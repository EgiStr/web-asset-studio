# Recipes

Every recipe follows the workflow in SKILL.md: bible -> anchor -> grids -> QA -> slice -> process -> pack. The `process` steps below are passed as-is in one call for all assets of the set.

## 1. Face photo -> illustrated sticker pack

- `project_create` type `sticker`. Bible example:
  - subject: written from the photo, e.g. "young man, oval face, warm light-brown skin, short black hair swept to the right, thick straight eyebrows, dark brown almond eyes, round thin black glasses, small nose, light stubble, wearing a mustard-yellow hoodie"
  - style: "cute chibi sticker, head about half of total height, thick clean dark-brown outlines, flat cel shading with one shadow tone, bright saturated colors, expressive face"
  - rules: ["one character per drawing, no props unless listed", "upper body only"]
- Anchor: `single`, items `["neutral friendly smile, looking at the viewer, upper body"]`, attach the face reference.
- Set: `grid` 3x3 per image, e.g. sheet 1 = happy, laughing, love (heart eyes), wink, thumbs up, cool (sunglasses), shocked, sad, crying; sheet 2 = angry, thinking, sleepy, confused, embarrassed (blush), excited, facepalm, OK sign, waving.
- `slice_grid` rows 3, cols 3, `names` = the expression slugs.
- `process` steps:
  ```json
  [{"op":"remove_bg"},{"op":"trim","padding":2},{"op":"outline","width":14,"color":"#ffffff"},{"op":"fit","width":512,"height":512}]
  ```
- Platforms: Telegram static stickers are 512 px on the longest side, PNG or WEBP. WhatsApp needs 512x512 WEBP under 100 KB, which these tools do not convert to; PNG output can be converted with any WEBP tool.

## 2. Face photo -> pixel-art sticker pack

- `project_create` type `sticker`, `pixel: {size: 64, colors: 24}`. Style: "pixel art bust portrait, big head, readable face".
- Grid 3x3 per image.
- `process` (pixel-perfect: outline at art resolution, then integer scale):
  ```json
  [{"op":"remove_bg"},{"op":"trim"},{"op":"pixelate","size":64,"palette":"shared","save_palette":true},
   {"op":"outline","width":1,"hard":true,"color":"#ffffff"},
   {"op":"fit","width":68,"height":68,"upscale":false},{"op":"scale","factor":8}]
  ```
  Result: 544x544, every art pixel exactly 8x8. Later sets: `"palette":"project"` instead of `"shared"`, so all packs share colors.

## 3. Game character animation (pixel sprites)

- `project_create` type `sprite`, `pixel: {size: 48, colors: 16}`. Style: "16-bit pixel art game sprite, side view, clean 1px dark outline, simple shading".
- Anchor: `single`, "standing idle pose, side view facing right, full body".
- Animations: `task: "animation"`, one motion per image, e.g. rows 1, cols 4, action "walk cycle facing right", items:
  `["contact pose: right leg forward", "passing pose: legs together, body slightly higher", "contact pose: left leg forward", "passing pose: legs together, body slightly higher"]`.
  Use 2x4 for 8-frame cycles. One animation per image keeps the motion coherent.
- `slice_grid` with names like `walk-1 ... walk-4`.
- `process` all frames of ONE animation together:
  ```json
  [{"op":"remove_bg"},{"op":"trim","group":true,"padding":1},{"op":"pixelate","size":48,"palette":"project"}]
  ```
  `trim group` crops every frame to the same box, so the character does not jitter. Never use plain `trim` on animation frames. Run the anchor (or the first animation) once with `"palette":"shared","save_palette":true` to lock the palette, then use `"project"` everywhere.
- `build_spritesheet` `{name: "walk-right", frames: [...], fps: 8, gif_scale: 4}`. In engines: Phaser `this.load.spritesheet(key, png, {frameWidth, frameHeight})` or `load.atlas(key, png, json)`; Godot `hframes` = columns, `vframes` = rows; Unity: Sprite Mode Multiple, Grid By Cell Size = frameWidth x frameHeight. Render with nearest-neighbor filtering.
- Mirror animations (walk left) in the engine with flipX instead of generating them.

## 4. Expressions / emotes / portraits for a game UI

Like recipe 1 or 2, but each emote is independent, so plain `trim` + `fit` to one canvas size is correct:
```json
[{"op":"remove_bg"},{"op":"trim","padding":2},{"op":"pixelate","size":32,"palette":"project"},{"op":"fit","width":34,"height":34,"upscale":false},{"op":"scale","factor":4}]
```

## 5. Pixel icons and UI for a website

- `project_create` type `icon` or `ui`, `pixel: {size: 32, colors: 16}`, bible.subject describes the visual language ("icon set for a cozy farming web game: chunky shapes, dark navy outline, warm palette"), not one object.
- `grid` 3x3 or 4x4, one icon per cell: items like "watering can", "seed bag", "coin", "settings gear".
- `process`:
  ```json
  [{"op":"remove_bg"},{"op":"trim"},{"op":"pixelate","size":32,"palette":"shared","save_palette":true},{"op":"fit","width":32,"height":32,"upscale":false}]
  ```
  For retina files add `{"op":"scale","factor":2}` at the end, or keep 1x and scale in CSS with `image-rendering: pixelated`.
- Buttons and panels: generate them flat, front-on, at a fixed aspect ("wide rounded pixel button, empty, no text"), and add text in HTML, never in the image.
- Icon atlas for the web: `build_spritesheet` with `columns` set, then use `background-position` from the JSON.

## 6. Illustration / hero image (no grid)

`single` with the bible; keep `background` as a real scene description instead of a key color (`project_update` `bible.background: "soft gradient sky at sunset"`). Usually no `process` steps beyond an optional `fit`.

## 7. Phone wallpaper (Pixel-class, seamless lock + home)

A wallpaper is not a sticker: the phone crops it, zooms it, scrolls it and puts a clock on top of it. Generate the pieces separately, then assemble them with `scripts/phone_wallpaper.py` (Python 3.9+ and Pillow, nothing else) so the sizes and the safe areas are exact.

- **Reference intake.** `add_reference` the photo or the wallpaper you are matching, role `style` (role `face` when the subject is a person). It sets the palette and the subject for everything that follows.
- **Style bible** for a dark key visual:
  - subject: "one character, three-quarter view, full body, long white hair, long black coat, red energy outlines, dark eye area"
  - style: "dark key visual, near-black background, one saturated accent colour, hard rim light, high contrast, anime game splash art"
  - background: "key-green" for the cutouts, a real description ("near-black with faint red grain") for the texture
  - palette: ["#0a0a0c", "#1a1a20", "#e01b28", "#f2f2f2"]
- **Generate one piece per image**, `task: "single"`:
  1. hero cutout: the character alone, whole body, on a flat key colour, no shadow, no scenery
  2. brush ring: the accent stroke alone on a flat key colour, nothing else
  3. texture grid: `task: "grid"` 2x2, "dark grain texture, tileable, no focal point, no border, no text", then `slice_grid` rows 2, cols 2 and keep one tile
- **Process the cutouts** into transparent PNGs:
  ```json
  [{"op":"remove_bg"},{"op":"trim","padding":4}]
  ```
  The texture is a full tile, not a subject: do not trim it.
- **Assemble**:
  ```bash
  python skills/asset-studio/scripts/phone_wallpaper.py \
    --texture out/texture.png --hero out/hero.png --ring out/ring.png \
    --text "YOUR LINE" --font path/to/title.ttf --out-dir out --name wallpaper
  ```
  The script fits the background to 1080x2400, scales the cutouts into the safe band, re-renders the lettering, writes the three files and prints a self-check.
- **Safe band.** On a 1080x2400 Pixel the lock clock covers roughly the top 460 px. Keep every critical element between y=460 and y=2100. The script prints the hero, ring and text boxes and checks them against the band; move things with `--hero-scale`, `--ring-dx`, `--ring-dy`, `--text-at`, `--text-align` instead of compositing by hand.
- **Lock-screen zoom.** The lock screen scales the wallpaper up, so the top and bottom edges come into view. Keep the outer strips plain continuing texture, never the subject, and let the script mirror the outer rows (`--extend`, default 140 px) into the scrolling variant so the zoom never lands on a cut. The self-check prints the mean luminance of the four border strips; a border brighter than `--max-edge-luma` (default 48) fails the check.
- **Typography.** Never scale up lettering that ChatGPT drew: at wallpaper size the glyphs are blurry and often misspelled. Put the words in the brief as plain text and re-render them with a TTF. The script rasterises the text at 4x and downsamples it, so the result is drawn type, not enlarged pixels.
- **Export set.**
  - `wallpaper-master.png` - 1080x2400, set as the static wallpaper
  - `wallpaper-scroll.png` - 1080x2680 (the master plus 140 mirrored rows top and bottom), used by a live wallpaper so it can pan without exposing a cut
  - `wallpaper.jpg` - JPEG fallback for launchers that reject a large PNG
  - lock and home preview - screenshots of the lock screen and the home screen on the real device. They are the only honest preview: the clock and the icon grid decide whether the wallpaper works.

## Fixing common problems

| Problem | Fix |
|---|---|
| Character drifts between sheets | Re-attach the anchor, stay in the same chat, make `bible.subject` more specific about the drifting feature |
| Drawings cross cell borders | Regenerate: "more empty margin around every drawing, each fully inside its own cell"; or slice with `inset` |
| Green fringe left on edges | `remove_bg` with `"tolerance": 60` or `"fringe": 2` |
| Parts of the subject vanish | Lower `tolerance` (25-30), or the subject uses the key color: switch `bible.background` to `key-magenta` |
| ChatGPT drew a checkerboard "transparency" | Flood mode removes it (both colors are detected); if not, pass `"colors": ["#ffffff", "#cccccc"]` |
| Pixel art looks mushy | Lower `pixelate.size` to the real grid of the drawing, and fewer colors |
| Frames jitter in the animation | Use `trim` with `"group": true` on all frames of that animation in one call |
| Lettering is blurry or misspelled | Do not upscale what ChatGPT drew: re-render it with a TTF (`--text "..." --font ...`) |
| Lock screen shows a seam at the top | Keep plain texture in the outer strips and mirror the edge rows (`--extend`) |
| The clock covers the subject | Keep critical content between y=460 and y=2100; the script prints the boxes it used |
| Cutout keeps a halo | `remove_bg` with `"tolerance": 60` or `"fringe": 2` |
