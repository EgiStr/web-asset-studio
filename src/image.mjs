// Pure-JS RGBA image operations. An image is { width, height, data: Uint8Array(width*height*4) }.
// No native dependencies so the bundled server runs anywhere Node 18+ runs.
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import gifenc from 'gifenc';

const { GIFEncoder, quantize: gifQuantize, applyPalette } = gifenc;

export function createImage(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid image size ${width}x${height}`);
  }
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function sniffFormat(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

export function decode(buf) {
  const fmt = sniffFormat(buf);
  if (fmt === 'png') {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
  }
  if (fmt === 'jpg') {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
    return { width: j.width, height: j.height, data: j.data };
  }
  throw new Error(`Cannot decode ${fmt ?? 'unknown'} image: only PNG and JPEG are supported. Download the image as PNG.`);
}

export function encodePng(img) {
  return PNG.sync.write({ width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) });
}

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`Invalid color "${hex}", expected #RRGGBB`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function dist2(d, i, c) {
  const dr = d[i] - c[0], dg = d[i + 1] - c[1], db = d[i + 2] - c[2];
  return dr * dr + dg * dg + db * db;
}

function minDist2(d, i, colors) {
  let best = Infinity;
  for (const c of colors) {
    const v = dist2(d, i, c);
    if (v < best) best = v;
  }
  return best;
}

// Background colors from the image border: one for a flat background, two for a fake
// "transparency" checkerboard. A real background runs along at least 3 of the 4 edges; a subject
// cropped at the frame (a bust cut off at the bottom) touches one or two, so it is not taken for
// background. `hint` (the requested key color) also admits a candidate on fewer edges.
export function borderColors(img, { maxColors = 6, minShare = 0.03, minEdgeShare = 0.1, hint } = {}) {
  const { width: w, height: h, data: d } = img;
  const buckets = new Map();
  let opaque = 0, total = 0;
  const visit = (x, y, edge) => {
    const i = (y * w + x) * 4;
    total++;
    if (d[i + 3] < 128) return;
    opaque++;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, edges: [0, 0, 0, 0] };
    b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; b.edges[edge]++;
    buckets.set(key, b);
  };
  for (let x = 0; x < w; x++) { visit(x, 0, 0); if (h > 1) visit(x, h - 1, 1); }
  for (let y = 0; y < h; y++) { visit(0, y, 2); if (w > 1) visit(w - 1, y, 3); }
  const edgeLen = [w, w, h, h];
  const mean = (b) => [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)];
  const nearHint = (c) => hint && (c[0] - hint[0]) ** 2 + (c[1] - hint[1]) ** 2 + (c[2] - hint[2]) ** 2 <= 100 * 100;
  const ranked = [...buckets.values()].filter((b) => b.n >= opaque * minShare).sort((a, b) => b.n - a.n);
  let picked = ranked.filter((b) => b.edges.filter((n, e) => n >= edgeLen[e] * minEdgeShare).length >= 3 || nearHint(mean(b)));
  if (!picked.length && ranked.length) picked = [ranked[0]];
  return { colors: picked.slice(0, maxColors).map(mean), opaqueShare: total ? opaque / total : 0 };
}

// Background removal by flood fill from the border, so background-colored pixels inside the
// subject (white of the eyes, highlights) are kept. mode "key" removes a color everywhere.
export function removeBackground(img, { mode = 'flood', colors, tolerance = 40, fringe = 1, hint } = {}) {
  const { width: w, height: h } = img;
  const out = { width: w, height: h, data: new Uint8Array(img.data) };
  const d = out.data;
  let bg = colors?.length ? colors.map(parseHex) : null;
  if (!bg) {
    const found = borderColors(img, { hint: hint ? parseHex(hint) : undefined });
    if (found.opaqueShare < 0.1 || !found.colors.length) {
      return { image: out, removedColors: [], note: 'Border is already transparent; nothing removed.' };
    }
    bg = found.colors;
  }
  const tol2 = tolerance * tolerance;
  const removed = new Uint8Array(w * h);
  const matches = (p) => d[p * 4 + 3] < 16 || minDist2(d, p * 4, bg) <= tol2;

  if (mode === 'key') {
    for (let p = 0; p < w * h; p++) if (matches(p)) removed[p] = 1;
  } else if (mode === 'flood') {
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const push = (p) => { if (!removed[p] && matches(p)) { removed[p] = 1; queue[tail++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (head < tail) {
      const p = queue[head++];
      const x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
  } else {
    throw new Error(`Unknown remove_bg mode "${mode}" (use "flood" or "key")`);
  }

  // Anti-aliased edge pixels are a blend of subject and background; peel those that are still
  // close to the background color so no light halo remains.
  const fringeTol2 = (tolerance * 2) ** 2;
  for (let pass = 0; pass < fringe; pass++) {
    const peel = [];
    for (let p = 0; p < w * h; p++) {
      if (removed[p]) continue;
      const x = p % w, y = (p / w) | 0;
      const nearRemoved = (x > 0 && removed[p - 1]) || (x < w - 1 && removed[p + 1]) || (y > 0 && removed[p - w]) || (y < h - 1 && removed[p + w]);
      if (nearRemoved && minDist2(d, p * 4, bg) <= fringeTol2) peel.push(p);
    }
    for (const p of peel) removed[p] = 1;
  }

  let count = 0;
  for (let p = 0; p < w * h; p++) if (removed[p]) { d[p * 4 + 3] = 0; count++; }
  return { image: out, removedColors: bg.map(toHex), removedShare: count / (w * h) };
}

export function crop(img, x, y, cw, ch) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  cw = Math.min(Math.round(cw), img.width - x); ch = Math.min(Math.round(ch), img.height - y);
  const out = createImage(cw, ch);
  for (let row = 0; row < ch; row++) {
    const s = ((y + row) * img.width + x) * 4;
    out.data.set(img.data.subarray(s, s + cw * 4), row * cw * 4);
  }
  return out;
}

export function alphaBounds(img, threshold = 8) {
  const { width: w, height: h, data: d } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function trim(img, { padding = 0, threshold = 8 } = {}) {
  const b = alphaBounds(img, threshold);
  if (!b) throw new Error('Image is fully transparent; background removal tolerance is probably too high.');
  const out = createImage(b.width + padding * 2, b.height + padding * 2);
  paste(out, crop(img, b.x, b.y, b.width, b.height), padding, padding);
  return out;
}

export function paste(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (y * src.width + x) * 4, di = (dy * dst.width + dx) * 4;
      const sa = src.data[si + 3] / 255;
      if (sa === 0) continue;
      const da = dst.data[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst.data[di + c] = Math.round((src.data[si + c] * sa + dst.data[di + c] * da * (1 - sa)) / oa);
      }
      dst.data[di + 3] = Math.round(oa * 255);
    }
  }
}

// Box-coverage weights for resampling one axis from `src` to `dst` samples.
function axisWeights(src, dst) {
  const scale = src / dst;
  const result = [];
  for (let i = 0; i < dst; i++) {
    const start = i * scale, end = (i + 1) * scale;
    const taps = [];
    for (let j = Math.floor(start); j < Math.min(src, Math.ceil(end)); j++) {
      const wgt = Math.min(end, j + 1) - Math.max(start, j);
      if (wgt > 1e-9) taps.push([j, wgt]);
    }
    const sum = taps.reduce((s, t) => s + t[1], 0);
    result.push(taps.map(([j, wgt]) => [j, wgt / sum]));
  }
  return result;
}

// kernel "area": averages every source pixel a target pixel covers (premultiplied alpha), the
// right downscale for AI "pixel art" whose pixels are not on a clean grid. kernel "nearest":
// blocky, for upscaling real pixel art.
export function resize(img, width, height, kernel = 'area') {
  width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
  const { width: sw, height: sh, data: s } = img;
  const out = createImage(width, height);
  if (kernel === 'nearest') {
    for (let y = 0; y < height; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / width));
        out.data.set(s.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * width + x) * 4);
      }
    }
    return out;
  }
  if (kernel !== 'area') throw new Error(`Unknown kernel "${kernel}" (use "area" or "nearest")`);
  const pre = new Float32Array(sw * sh * 4);
  for (let p = 0; p < sw * sh; p++) {
    const a = s[p * 4 + 3] / 255;
    pre[p * 4] = s[p * 4] * a; pre[p * 4 + 1] = s[p * 4 + 1] * a; pre[p * 4 + 2] = s[p * 4 + 2] * a; pre[p * 4 + 3] = a;
  }
  const wx = axisWeights(sw, width), wy = axisWeights(sh, height);
  const tmp = new Float32Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (const [j, wgt] of wx[x]) {
        const i = (y * sw + j) * 4;
        tmp[o] += pre[i] * wgt; tmp[o + 1] += pre[i + 1] * wgt; tmp[o + 2] += pre[i + 2] * wgt; tmp[o + 3] += pre[i + 3] * wgt;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [j, wgt] of wy[y]) {
        const i = (j * width + x) * 4;
        r += tmp[i] * wgt; g += tmp[i + 1] * wgt; b += tmp[i + 2] * wgt; a += tmp[i + 3] * wgt;
      }
      const o = (y * width + x) * 4;
      if (a > 1e-6) {
        out.data[o] = Math.min(255, Math.round(r / a)); out.data[o + 1] = Math.min(255, Math.round(g / a)); out.data[o + 2] = Math.min(255, Math.round(b / a));
      }
      out.data[o + 3] = Math.min(255, Math.round(a * 255));
    }
  }
  return out;
}

// Scale to fit inside width x height keeping aspect ratio, centered on a transparent canvas
// (align "bottom" keeps feet on a shared baseline for animation frames).
export function fit(img, width, height, { kernel = 'area', align = 'center', upscale = true } = {}) {
  let scale = Math.min(width / img.width, height / img.height);
  if (!upscale) scale = Math.min(1, scale);
  const rw = Math.max(1, Math.round(img.width * scale)), rh = Math.max(1, Math.round(img.height * scale));
  const scaled = rw === img.width && rh === img.height ? img : resize(img, rw, rh, kernel);
  const out = createImage(width, height);
  const ox = Math.floor((width - rw) / 2);
  const oy = align === 'bottom' ? height - rh : Math.floor((height - rh) / 2);
  paste(out, scaled, ox, oy);
  return out;
}

export function binarizeAlpha(img, threshold = 128) {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = out.data[i] >= threshold ? 255 : 0;
  return out;
}

// Median-cut palette over the opaque pixels of one image or several (one palette for a whole set),
// no dithering (dithering ruins pixel art).
export function medianCutPalette(images, maxColors) {
  const hist = new Map();
  for (const im of Array.isArray(images) ? images : [images]) {
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  }
  if (!hist.size) return [];
  const all = [...hist].map(([k, n]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255, n]);
  // Weighted squared error of a run of colors, from prefix sums.
  const sse = (box) => {
    let n = 0, r = 0, g = 0, b = 0, q = 0;
    for (const p of box) { n += p[3]; r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; q += (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) * p[3]; }
    return n ? q - (r * r + g * g + b * b) / n : 0;
  };
  // Split where the summed error of both halves is lowest (not at the median), so a dense
  // color cluster is not cut in two while a separate cluster stays merged.
  const bestSplit = (box) => {
    let best = null;
    for (let c = 0; c < 3; c++) {
      const sorted = [...box].sort((a, b) => a[c] - b[c]);
      const k = sorted.length;
      const pre = new Float64Array((k + 1) * 5);
      for (let i = 0; i < k; i++) {
        const p = sorted[i], o = i * 5, w = p[3];
        pre[o + 5] = pre[o] + w; pre[o + 6] = pre[o + 1] + p[0] * w; pre[o + 7] = pre[o + 2] + p[1] * w; pre[o + 8] = pre[o + 3] + p[2] * w;
        pre[o + 9] = pre[o + 4] + (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) * w;
      }
      const err = (a, b) => {
        const n = pre[b * 5] - pre[a * 5];
        if (!n) return 0;
        const r = pre[b * 5 + 1] - pre[a * 5 + 1], g = pre[b * 5 + 2] - pre[a * 5 + 2], bl = pre[b * 5 + 3] - pre[a * 5 + 3];
        return pre[b * 5 + 4] - pre[a * 5 + 4] - (r * r + g * g + bl * bl) / n;
      };
      for (let cut = 1; cut < k; cut++) {
        if (sorted[cut][c] === sorted[cut - 1][c]) continue;
        const e = err(0, cut) + err(cut, k);
        if (!best || e < best.e) best = { e, left: sorted.slice(0, cut), right: sorted.slice(cut) };
      }
    }
    return best;
  };
  const boxes = [{ colors: all, err: sse(all) }];
  while (boxes.length < maxColors) {
    let pick = -1;
    boxes.forEach((b, i) => { if (b.colors.length > 1 && b.err > 0 && (pick < 0 || b.err > boxes[pick].err)) pick = i; });
    if (pick < 0) break;
    const split = bestSplit(boxes[pick].colors);
    if (!split) break;
    boxes.splice(pick, 1, { colors: split.left, err: sse(split.left) }, { colors: split.right, err: sse(split.right) });
  }
  let palette = boxes.map(({ colors }) => {
    let n = 0, r = 0, g = 0, b = 0;
    for (const p of colors) { n += p[3]; r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; }
    return [r / n, g / n, b / n];
  });
  // A few k-means passes to settle the centers.
  for (let iter = 0; iter < 4; iter++) {
    const acc = palette.map(() => [0, 0, 0, 0]);
    for (const p of all) {
      let best = 0, bd = Infinity;
      palette.forEach((c, i) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = i; } });
      const a = acc[best]; a[0] += p[0] * p[3]; a[1] += p[1] * p[3]; a[2] += p[2] * p[3]; a[3] += p[3];
    }
    palette = palette.map((c, i) => (acc[i][3] ? [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] : c));
  }
  return palette.map((c) => c.map(Math.round));
}

export function applyFixedPalette(img, palette) {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  const d = out.data;
  const cache = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let c = cache.get(key);
    if (!c) {
      let best = Infinity;
      for (const p of palette) { const v = dist2(d, i, p); if (v < best) { best = v; c = p; } }
      cache.set(key, c);
    }
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
  }
  return out;
}

// First half of pixelate: area-downscale to the true pixel grid (longest side = size), hard alpha.
export function pixelGrid(img, { size, alphaThreshold = 128 } = {}) {
  if (!Number.isInteger(size) || size < 4) throw new Error('pixelate.size must be an integer >= 4 (the true pixel grid, e.g. 32 or 64)');
  const s = Math.min(size / img.width, size / img.height);
  const out = resize(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)), 'area');
  return binarizeAlpha(out, alphaThreshold);
}

// Turn a high-res "pixel art style" render into real pixel art: area-downscale to the true grid,
// hard alpha, limited palette (shared across a set when `palette` is given), optional integer upscale.
export function pixelate(img, { size, colors = 16, palette, scale = 1, alphaThreshold = 128 } = {}) {
  let out = pixelGrid(img, { size, alphaThreshold });
  const pal = palette?.length ? palette.map(parseHex) : medianCutPalette(out, colors);
  if (pal.length) out = applyFixedPalette(out, pal);
  if (scale > 1) out = resize(out, out.width * scale, out.height * scale, 'nearest');
  return { image: out, palette: pal.map(toHex) };
}

// Chamfer (3-4) distance from every pixel to the nearest opaque pixel, in pixels.
function distanceToOpaque(img, threshold = 128) {
  const { width: w, height: h, data: d } = img;
  const INF = 1e9;
  const dist = new Float64Array(w * h);
  for (let p = 0; p < w * h; p++) dist[p] = d[p * 4 + 3] >= threshold ? 0 : INF;
  const relax = (p, q, cost) => { if (dist[q] + cost < dist[p]) dist[p] = dist[q] + cost; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x > 0) relax(p, p - 1, 3);
      if (y > 0) {
        relax(p, p - w, 3);
        if (x > 0) relax(p, p - w - 1, 4);
        if (x < w - 1) relax(p, p - w + 1, 4);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      if (x < w - 1) relax(p, p + 1, 3);
      if (y < h - 1) {
        relax(p, p + w, 3);
        if (x < w - 1) relax(p, p + w + 1, 4);
        if (x > 0) relax(p, p + w - 1, 4);
      }
    }
  }
  for (let p = 0; p < w * h; p++) dist[p] /= 3;
  return dist;
}

// Die-cut sticker border: grows the canvas by `width` and paints `color` behind the subject.
export function outline(img, { width = 8, color = '#ffffff', hard = false } = {}) {
  if (width <= 0) return img;
  const pad = Math.ceil(width) + 1;
  const canvas = createImage(img.width + pad * 2, img.height + pad * 2);
  paste(canvas, img, pad, pad);
  const dist = distanceToOpaque(canvas);
  const [r, g, b] = parseHex(color);
  const back = createImage(canvas.width, canvas.height);
  for (let p = 0; p < dist.length; p++) {
    const a = hard ? (dist[p] <= width ? 1 : 0) : Math.max(0, Math.min(1, width + 0.5 - dist[p]));
    if (a > 0) { back.data[p * 4] = r; back.data[p * 4 + 1] = g; back.data[p * 4 + 2] = b; back.data[p * 4 + 3] = Math.round(a * 255); }
  }
  paste(back, canvas, 0, 0);
  return back;
}

// Equal-size cells of a rows x cols sheet, `inset` pixels shaved from each side of every cell
// to drop gutters or stray grid lines.
export function sliceGrid(img, rows, cols, { inset = 0 } = {}) {
  const cw = img.width / cols, ch = img.height / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round(c * cw) + inset, y0 = Math.round(r * ch) + inset;
      const x1 = Math.round((c + 1) * cw) - inset, y1 = Math.round((r + 1) * ch) - inset;
      if (x1 <= x0 || y1 <= y0) throw new Error(`inset ${inset} is larger than the cell size`);
      cells.push({ row: r, col: c, image: crop(img, x0, y0, x1 - x0, y1 - y0) });
    }
  }
  return cells;
}

// Uniform-cell sprite sheet: every frame sits in a cellW x cellH cell, so the sheet works both as
// a fixed-size spritesheet (Phaser frameWidth/frameHeight, Godot hframes/vframes) and as an atlas.
export function composeSheet(frames, { columns, padding = 0, align = 'center' } = {}) {
  const cellW = Math.max(...frames.map((f) => f.image.width));
  const cellH = Math.max(...frames.map((f) => f.image.height));
  const cols = Math.max(1, Math.min(columns ?? frames.length, frames.length));
  const rows = Math.ceil(frames.length / cols);
  const sheet = createImage(cols * cellW + (cols - 1) * padding, rows * cellH + (rows - 1) * padding);
  const placed = frames.map((f, i) => {
    const x = (i % cols) * (cellW + padding), y = Math.floor(i / cols) * (cellH + padding);
    const ox = Math.floor((cellW - f.image.width) / 2);
    const oy = align === 'bottom' ? cellH - f.image.height : Math.floor((cellH - f.image.height) / 2);
    paste(sheet, f.image, x + ox, y + oy);
    return { name: f.name, x, y, w: cellW, h: cellH };
  });
  return { sheet, cellW, cellH, columns: cols, rows, placed };
}

export function encodeGif(frames, { fps = 8, scale = 1 } = {}) {
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  for (const f0 of frames) {
    const f = scale > 1 ? resize(f0, f0.width * scale, f0.height * scale, 'nearest') : f0;
    const rgba = f.data;
    const palette = gifQuantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true });
    const index = applyPalette(rgba, palette, 'rgba4444');
    const transparentIndex = palette.findIndex((p) => p[3] === 0);
    gif.writeFrame(index, f.width, f.height, {
      palette: palette.map((p) => [p[0], p[1], p[2]]),
      delay,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      dispose: 2,
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}
