#!/usr/bin/env python3
"""Build a Pixel-class phone wallpaper from generated assets.

Needs Python 3.9+ and Pillow, nothing else:

    python -m pip install Pillow

The AI makes the art (hero cutout, brush ring, texture, lettering). This script
does the deterministic part: fit the background to a 1080x2400 master, re-render
the overlay typography from a TTF at 4x so the glyphs are drawn instead of
upscaled from the generated image, mirror the outer rows so the lock-screen zoom
never lands on a cut, and write the master PNG, the taller scrolling variant and
a JPEG fallback.

    python phone_wallpaper.py --texture texture.png --out-dir out \\
        --hero character.png --ring brush.png \\
        --text "IF I CAN'T REACH GOD LEVEL" --font title.ttf
"""

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps
except ImportError:
    sys.exit("error: Pillow is required. Run: python -m pip install Pillow")

RESAMPLE = getattr(Image, "Resampling", Image).LANCZOS


def parse_hex(value):
    v = value.strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6:
        raise SystemExit("error: bad color %r, expected #RRGGBB" % value)
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))


def open_rgba(path):
    if not path:
        return None
    p = Path(path)
    if not p.exists():
        raise SystemExit("error: file not found: %s" % p)
    img = Image.open(p)
    img.load()
    return img.convert("RGBA")


def tile_texture(tile, width, height):
    """Repeat a seamless tile over the whole canvas."""
    out = Image.new("RGBA", (width, height))
    for y in range(0, height, tile.height):
        for x in range(0, width, tile.width):
            out.paste(tile, (x, y))
    return out


def build_background(args, width, height):
    if args.reference and args.texture:
        raise SystemExit("error: use --reference or --texture for the background, not both")
    if args.reference:
        img = open_rgba(args.reference)
        return ImageOps.fit(img, (width, height), method=RESAMPLE, centering=(0.5, args.fit_y))
    if args.texture:
        tile = open_rgba(args.texture)
        if args.texture_scale != 1.0:
            tile = tile.resize(
                (max(1, round(tile.width * args.texture_scale)), max(1, round(tile.height * args.texture_scale))),
                RESAMPLE,
            )
        return tile_texture(tile, width, height)
    return Image.new("RGBA", (width, height), parse_hex(args.background))


def fit_inside(img, max_w, max_h, max_upscale):
    """Scale an asset down into the given box; upscale only up to max_upscale."""
    scale = min(max_w / img.width, max_h / img.height, max_upscale)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    return img if size == img.size else img.resize(size, RESAMPLE)


def place_asset(canvas, img, width, band_h, scale, cx, cy, max_upscale):
    """Scale a cutout into the safe band, paste it centred on (cx, cy), return its box."""
    img = fit_inside(img, width * 0.98, band_h * scale, max_upscale)
    canvas.paste(img, (round(cx - img.width / 2), round(cy - img.height / 2)), img)
    return (round(cx - img.width / 2), round(cy - img.height / 2),
            round(cx + img.width / 2), round(cy + img.height / 2))


def load_font(path, size):
    if not path:
        raise SystemExit("error: --text needs --font (path to a .ttf file)")
    p = Path(path)
    if not p.exists():
        raise SystemExit("error: font not found: %s" % p)
    try:
        return ImageFont.truetype(str(p), size)
    except OSError as exc:
        raise SystemExit("error: cannot load font %s: %s" % (p, exc))


def wrap(text, font, max_width):
    lines = []
    for para in text.split("\n"):
        words = para.split()
        if not words:
            lines.append("")
            continue
        line = words[0]
        for word in words[1:]:
            trial = line + " " + word
            if font.getlength(trial) <= max_width:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def render_text(text, font_path, size, color, max_width, supersample, shadow):
    """Draw the lettering at supersample x and downsample: re-rendered, not upscaled.

    The glyphs go into a coverage mask, so the colour never bleeds into the
    transparent pixels and the downsampled edge stays clean.
    """
    font = load_font(font_path, size * supersample)
    lines = wrap(text, font, max_width * supersample)
    ascent, descent = font.getmetrics()
    line_h = int((ascent + descent) * 1.15)
    width = max([int(font.getlength(line)) for line in lines] or [1])
    height = max(1, line_h * len(lines))
    pad = supersample * 2
    mask = Image.new("L", (width + 2 * pad, height + 2 * pad), 0)
    draw = ImageDraw.Draw(mask)
    for i, line in enumerate(lines):
        draw.text((pad, pad + i * line_h), line, font=font, fill=255)
    alpha = mask.resize((max(1, mask.width // supersample), max(1, mask.height // supersample)), RESAMPLE)
    layer = Image.new("RGBA", alpha.size, color + (0,))
    layer.putalpha(alpha)
    if shadow > 0:
        halo = alpha.filter(ImageFilter.GaussianBlur(shadow)).point(lambda v: v * 3 // 4)
        under = Image.new("RGBA", alpha.size, (0, 0, 0, 0))
        under.putalpha(halo)
        layer = Image.alpha_composite(under, layer)
    return layer


def place_text(canvas, layer, band, args, width):
    """Put the lettering inside the safe band, never under the lock clock."""
    band_top, band_bottom = band
    if args.text_at == "top":
        y = band_top + args.text_margin
    elif args.text_at == "bottom":
        y = band_bottom - args.text_margin - layer.height
    else:
        y = band_top + (band_bottom - band_top - layer.height) // 2
    if args.text_align == "left":
        x = args.text_margin
    elif args.text_align == "right":
        x = width - args.text_margin - layer.width
    else:
        x = (width - layer.width) // 2
    canvas.paste(layer, (x, y), layer)
    return (x, y, x + layer.width, y + layer.height)


def extend_edges(img, extend):
    """Mirror the outer rows so the texture continues past the frame edge.

    The lock screen zooms the wallpaper in, so a hard cut at the top or bottom
    would show up as a seam. Mirroring the edge rows keeps the same texture
    running and makes the join exact.
    """
    if extend <= 0:
        return img, 0
    width, height = img.size
    e = min(extend, height)
    top = img.crop((0, 0, width, e)).transpose(Image.FLIP_TOP_BOTTOM)
    bottom = img.crop((0, height - e, width, height)).transpose(Image.FLIP_TOP_BOTTOM)
    out = Image.new("RGBA", (width, height + 2 * e))
    out.paste(top, (0, 0))
    out.paste(img, (0, e))
    out.paste(bottom, (0, e + height))
    return out, e


def edge_luma(img, strip):
    """Mean luminance of each border strip of the master."""
    width, height = img.size
    gray = img.convert("L")

    def mean(box):
        hist = gray.crop(box).histogram()
        total = sum(hist)
        if not total:
            return 0.0
        return sum(i * n for i, n in enumerate(hist)) / total

    return {
        "top": mean((0, 0, width, strip)),
        "bottom": mean((0, height - strip, width, height)),
        "left": mean((0, 0, strip, height)),
        "right": mean((width - strip, 0, width, height)),
    }


def row_diff(img, y1, y2):
    """Mean absolute difference between two rows; 0 means the join is exact."""
    a = img.crop((0, y1, img.width, y1 + 1)).convert("RGB")
    b = img.crop((0, y2, img.width, y2 + 1)).convert("RGB")
    diff = ImageChops.difference(a, b).convert("L")
    hist = diff.histogram()
    total = sum(hist)
    if not total:
        return 0.0
    return sum(i * n for i, n in enumerate(hist)) / total


def parse_args():
    p = argparse.ArgumentParser(description="Build a Pixel-class wallpaper master, scrolling variant and JPEG fallback.")
    p.add_argument("--reference", help="key visual fitted to the master (not with --texture)")
    p.add_argument("--texture", help="seamless tile repeated as the background")
    p.add_argument("--texture-scale", type=float, default=1.0, help="resize the tile before repeating it")
    p.add_argument("--background", default="#000000", help="solid background color")
    p.add_argument("--fit-y", type=float, default=0.5, help="crop anchor for --reference, 0 top .. 1 bottom")
    p.add_argument("--hero", help="transparent character cutout")
    p.add_argument("--hero-scale", type=float, default=0.8, help="hero height as a fraction of the safe band")
    p.add_argument("--ring", help="transparent brush ring, drawn behind the hero")
    p.add_argument("--ring-scale", type=float, default=0.95, help="ring height as a fraction of the safe band")
    p.add_argument("--ring-dx", type=int, default=0, help="ring offset from the hero centre, px")
    p.add_argument("--ring-dy", type=int, default=0, help="ring offset from the hero centre, px")
    p.add_argument("--text", help="overlay lettering, use \\n for line breaks")
    p.add_argument("--font", help="TTF used to re-render the lettering")
    p.add_argument("--text-size", type=int, default=110, help="lettering height in px on the master")
    p.add_argument("--text-color", default="#ffffff")
    p.add_argument("--text-shadow", type=int, default=0, help="blurred dark halo behind the lettering, px")
    p.add_argument("--text-at", choices=["top", "centre", "bottom"], default="bottom")
    p.add_argument("--text-align", choices=["left", "center", "right"], default="center")
    p.add_argument("--text-margin", type=int, default=60, help="padding from the band edge, px")
    p.add_argument("--text-max-width", type=int, default=0, help="wrap width, 0 means 86%% of the master width")
    p.add_argument("--supersample", type=int, default=4, help="factor the type is rasterised at")
    p.add_argument("--width", type=int, default=1080)
    p.add_argument("--height", type=int, default=2400)
    p.add_argument("--lock-clock-bottom", type=int, default=460, help="y where the lock clock ends")
    p.add_argument("--safe-bottom", type=int, default=2100, help="y where the safe band ends")
    p.add_argument("--extend", type=int, default=140, help="rows mirrored above and below for the scrolling variant")
    p.add_argument("--max-upscale", type=float, default=3.0, help="how far a cutout may be scaled up")
    p.add_argument("--max-edge-luma", type=float, default=48.0, help="highest allowed mean luminance of a border strip")
    p.add_argument("--jpeg-quality", type=int, default=92)
    p.add_argument("--name", default="wallpaper", help="output file name prefix")
    p.add_argument("--out-dir", default=".", help="where the files are written")
    p.add_argument("--strict", action="store_true", help="exit non-zero when a check fails")
    p.add_argument("--json", action="store_true", help="print the summary as JSON")
    return p.parse_args()


def main():
    args = parse_args()
    width, height = args.width, args.height
    band = (args.lock_clock_bottom, args.safe_bottom)
    band_h = band[1] - band[0]
    if band_h <= 0:
        raise SystemExit("error: --safe-bottom must be below --lock-clock-bottom")

    canvas = build_background(args, width, height)
    boxes = {}
    cx, cy = width / 2, band[0] + band_h / 2
    if args.ring:
        boxes["ring"] = place_asset(canvas, open_rgba(args.ring), width, band_h, args.ring_scale,
                                    cx + args.ring_dx, cy + args.ring_dy, args.max_upscale)
    if args.hero:
        boxes["hero"] = place_asset(canvas, open_rgba(args.hero), width, band_h, args.hero_scale,
                                    cx, cy, args.max_upscale)

    if args.text:
        max_width = args.text_max_width or int(width * 0.86)
        layer = render_text(args.text, args.font, args.text_size, parse_hex(args.text_color),
                            max_width, max(1, args.supersample), args.text_shadow)
        boxes["text"] = place_text(canvas, layer, band, args, width)

    master = canvas.convert("RGB")
    scroll, e = extend_edges(master, args.extend)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    master_path = out_dir / ("%s-master.png" % args.name)
    scroll_path = out_dir / ("%s-scroll.png" % args.name)
    jpeg_path = out_dir / ("%s.jpg" % args.name)
    master.save(master_path)
    scroll.save(scroll_path)
    master.save(jpeg_path, "JPEG", quality=args.jpeg_quality, subsampling=0, optimize=True)

    checks = []

    def check(label, ok, detail):
        checks.append({"label": label, "ok": bool(ok), "detail": detail})

    check("master size", master.size == (width, height), "%dx%d" % master.size)
    check("scroll size", scroll.size == (width, height + 2 * e), "%dx%d" % scroll.size)
    check("jpeg size", master.size == (width, height), "%dx%d" % master.size)

    luma = edge_luma(master, max(2, round(height * 0.02)))
    for side, value in luma.items():
        check("edge %s" % side, value <= args.max_edge_luma,
              "mean luma %.1f (limit %.0f)" % (value, args.max_edge_luma))
    if e:
        check("edge continuity top", row_diff(scroll, e - 1, e) == 0.0, "row diff %.2f" % row_diff(scroll, e - 1, e))
        check("edge continuity bottom", row_diff(scroll, e + height - 1, e + height) == 0.0,
              "row diff %.2f" % row_diff(scroll, e + height - 1, e + height))
    for label, box in boxes.items():
        check("%s inside safe band" % label, box[1] >= band[0] and box[3] <= band[1],
              "y %d..%d (band %d..%d)" % (box[1], box[3], band[0], band[1]))

    failed = [c for c in checks if not c["ok"]]
    summary = {
        "master": str(master_path), "scroll": str(scroll_path), "jpeg": str(jpeg_path),
        "size": [width, height], "scroll_size": [width, height + 2 * e], "safe_band": list(band),
        "edge_luma": {k: round(v, 2) for k, v in luma.items()}, "checks": checks, "failed": len(failed),
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("[wallpaper] master   %s  %dx%d" % (master_path, width, height))
        print("[wallpaper] scroll   %s  %dx%d" % (scroll_path, width, height + 2 * e))
        print("[wallpaper] jpeg     %s" % jpeg_path)
        print("[wallpaper] safe band y=%d..%d" % band)
        for c in checks:
            print("[check] %-26s %-4s %s" % (c["label"], "ok" if c["ok"] else "FAIL", c["detail"]))
    return 1 if failed and args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
