import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as img from '../src/image.mjs';

function fill(w, h, fn) {
  const im = img.createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a = 255] = fn(x, y);
    const i = (y * w + x) * 4;
    im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b; im.data[i + 3] = a;
  }
  return im;
}
const px = (im, x, y) => Array.from(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));

test('png round trip', () => {
  const a = fill(5, 3, (x, y) => [x * 40, y * 80, 7, 255 - x]);
  const b = img.decode(img.encodePng(a));
  assert.equal(b.width, 5); assert.equal(b.height, 3);
  assert.deepEqual(Array.from(b.data), Array.from(a.data));
});

test('flood removal keeps background-colored pixels enclosed by the subject', () => {
  // White background, black ring, white "eye" inside the ring.
  const im = fill(60, 60, (x, y) => {
    const d = Math.hypot(x - 30, y - 30);
    return d < 20 && d > 12 ? [0, 0, 0] : [255, 255, 255];
  });
  const { image } = img.removeBackground(im, { tolerance: 30 });
  assert.equal(px(image, 0, 0)[3], 0, 'outside removed');
  assert.equal(px(image, 30, 30)[3], 255, 'enclosed white kept');
  assert.equal(px(image, 30, 14)[3], 255, 'ring kept');
  const keyed = img.removeBackground(im, { mode: 'key', tolerance: 30 }).image;
  assert.equal(px(keyed, 30, 30)[3], 0, 'key mode removes everywhere');
});

test('fake checkerboard transparency is removed', () => {
  const im = fill(64, 64, (x, y) => {
    if (x >= 20 && x < 44 && y >= 20 && y < 44) return [30, 60, 200];
    return ((x >> 3) + (y >> 3)) % 2 ? [204, 204, 204] : [255, 255, 255];
  });
  const { image, removedColors } = img.removeBackground(im);
  assert.equal(removedColors.length, 2);
  const b = img.alphaBounds(image);
  assert.deepEqual(b, { x: 20, y: 20, width: 24, height: 24 });
});

test('pixelate recovers an off-grid upscaled sprite', () => {
  const pal = [[20, 20, 30], [230, 180, 140], [200, 40, 50], [250, 250, 250]];
  const src = fill(16, 16, (x, y) => pal[(x * 3 + y * 5 + ((x * y) >> 2)) % 4]);
  // Upscale by a non-integer factor with noise, like an AI render that only looks like pixel art.
  const S = 1000 / 16;
  const big = fill(1000, 1000, (x, y) => {
    const c = pal.indexOf(pal.find((p) => p === pal[(Math.floor(x / S) * 3 + Math.floor(y / S) * 5 + ((Math.floor(x / S) * Math.floor(y / S)) >> 2)) % 4]));
    const n = ((x * 7919 + y * 104729) % 13) - 6;
    return pal[c].map((v) => Math.max(0, Math.min(255, v + n)));
  });
  const { image, palette } = img.pixelate(big, { size: 16, colors: 4 });
  assert.equal(image.width, 16); assert.equal(image.height, 16);
  assert.equal(palette.length, 4);
  let match = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const a = px(image, x, y), b = px(src, x, y);
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 30) match++;
  }
  assert.ok(match / 256 > 0.95, `only ${match}/256 pixels recovered`);
  const scaled = img.pixelate(big, { size: 16, colors: 4, scale: 4 }).image;
  assert.equal(scaled.width, 64);
});

test('fixed palette mapping only uses given colors', () => {
  const im = fill(10, 10, (x) => [x * 25, 0, 0]);
  const { image, palette } = img.pixelate(im, { size: 10, palette: ['#000000', '#ff0000'] });
  assert.deepEqual(palette, ['#000000', '#ff0000']);
  for (let i = 0; i < image.data.length; i += 4) assert.ok(image.data[i] === 0 || image.data[i] === 255);
});

test('outline grows canvas and paints border behind subject', () => {
  const im = fill(30, 30, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? [255, 0, 0] : [0, 0, 0, 0]));
  const out = img.outline(im, { width: 3, color: '#ffffff', hard: true });
  assert.equal(out.width, 30 + 8);
  const pad = 4;
  assert.deepEqual(px(out, 15 + pad, 15 + pad), [255, 0, 0, 255], 'subject on top');
  assert.deepEqual(px(out, 8 + pad, 15 + pad), [255, 255, 255, 255], '2px outside = outline');
  assert.equal(px(out, 5 + pad, 15 + pad)[3], 0, '5px outside = transparent');
});

test('slice grid yields equal cells in reading order', () => {
  const colors = Array.from({ length: 9 }, (_, i) => [i * 25, 100, 200 - i * 20]);
  const im = fill(300, 300, (x, y) => colors[Math.floor(y / 100) * 3 + Math.floor(x / 100)]);
  const cells = img.sliceGrid(im, 3, 3, { inset: 2 });
  assert.equal(cells.length, 9);
  cells.forEach((c, i) => {
    assert.equal(c.image.width, 96);
    assert.deepEqual(px(c.image, 10, 10).slice(0, 3), colors[i]);
  });
});

test('fit centers or bottom-aligns on a transparent canvas', () => {
  const im = fill(10, 20, () => [9, 9, 9]);
  const c = img.fit(im, 40, 40);
  assert.deepEqual(img.alphaBounds(c), { x: 10, y: 0, width: 20, height: 40 });
  const b = img.fit(fill(20, 10, () => [9, 9, 9]), 40, 40, { align: 'bottom' });
  assert.deepEqual(img.alphaBounds(b), { x: 0, y: 20, width: 40, height: 20 });
});

test('sprite sheet and gif', () => {
  const frames = [0, 1, 2].map((i) => ({ name: `f${i}`, image: fill(8 + i, 8, () => [i * 80, 0, 0]) }));
  const { sheet, cellW, cellH, placed } = img.composeSheet(frames, { columns: 2, padding: 1 });
  assert.equal(cellW, 10); assert.equal(cellH, 8);
  assert.equal(sheet.width, 21); assert.equal(sheet.height, 17);
  assert.deepEqual(placed[2], { name: 'f2', x: 0, y: 9, w: 10, h: 8 });
  const gif = img.encodeGif(placed.map((f) => img.crop(sheet, f.x, f.y, f.w, f.h)), { fps: 10, scale: 2 });
  assert.equal(gif.toString('ascii', 0, 6), 'GIF89a');
  assert.equal(gif.readUInt16LE(6), 20);
});

test('rejects webp with a clear message', () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.throws(() => img.decode(webp), /PNG and JPEG/);
});

test('subject cropped at the bottom edge is not mistaken for background', () => {
  // Green (slightly off-pure, as ChatGPT renders it) background; a bust whose hoodie runs off
  // the bottom edge across half its width, with a white face detail.
  const im = fill(200, 200, (x, y) => {
    if (y >= 120 && x >= 50 && x < 150) return [210, 160, 40];
    if (Math.hypot(x - 100, y - 80) < 40) return Math.hypot(x - 100, y - 80) < 8 ? [255, 255, 255] : [240, 190, 150];
    return [20, 235, 30];
  });
  const plain = img.removeBackground(im);
  assert.deepEqual(plain.removedColors.length, 1);
  assert.equal(px(plain.image, 100, 199)[3], 255, 'hoodie at the bottom edge kept');
  assert.equal(px(plain.image, 100, 80)[3], 255, 'face kept');
  assert.equal(px(plain.image, 5, 5)[3], 0, 'background removed');
  const hinted = img.removeBackground(im, { hint: '#00ff00' });
  assert.equal(px(hinted.image, 100, 199)[3], 255);
  assert.equal(px(hinted.image, 5, 199)[3], 0);
});
