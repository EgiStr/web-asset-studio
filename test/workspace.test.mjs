import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as img from '../src/image.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aas-test-'));
process.env.ASSET_STUDIO_ROOT = path.join(tmp, 'studio');
process.env.ASSET_STUDIO_DOWNLOADS = path.join(tmp, 'Downloads');
fs.mkdirSync(process.env.ASSET_STUDIO_DOWNLOADS);
const ws = await import('../src/workspace.mjs');
const { buildPrompt } = await import('../src/prompts.mjs');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// 2x2 grid of colored discs on a green key background.
function gridSheet() {
  const im = img.createImage(400, 400);
  const colors = [[220, 40, 40], [40, 40, 220], [240, 200, 40], [120, 40, 160]];
  for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
    const cell = Math.floor(y / 200) * 2 + Math.floor(x / 200);
    const inDisc = Math.hypot((x % 200) - 100, (y % 200) - 100) < 60;
    const c = inDisc ? colors[cell] : [0, 255, 0];
    im.data.set([...c, 255], (y * 400 + x) * 4);
  }
  return img.encodePng(im);
}

before(() => {
  ws.createProject({ name: 'demo', type: 'sprite', bible: { subject: 'a round blob', style: 'flat' }, pixel: { size: 32, colors: 8 } });
});

test('rejects bad names and duplicate projects', () => {
  assert.throws(() => ws.checkName('My Project'), /Invalid/);
  assert.throws(() => ws.checkName('../x'), /Invalid/);
  assert.throws(() => ws.createProject({ name: 'demo', type: 'sprite', bible: {} }), /already exists/);
});

test('full pipeline: download -> slice -> process -> sheet', async () => {
  const dl = path.join(process.env.ASSET_STUDIO_DOWNLOADS, 'aas_demo_sheet1.png');
  fs.writeFileSync(path.join(process.env.ASSET_STUDIO_DOWNLOADS, 'other.png.crdownload'), 'partial');
  fs.writeFileSync(dl, gridSheet());

  const r = await ws.ingest({ project: 'demo', name: 'sheet1', source: { download: { nameContains: 'aas_demo_sheet1', timeoutSec: 10 } }, prompt: 'p' });
  assert.equal(r.asset.format, 'png');
  assert.deepEqual(r.asset.size.raw, [400, 400]);
  assert.ok(!fs.existsSync(dl), 'download moved out of Downloads');
  assert.ok(fs.existsSync(r.file));

  const again = await ws.ingest({ project: 'demo', name: 'sheet1', source: { path: r.file } });
  assert.equal(again.asset.name, 'sheet1-2', 'name auto-suffixed');

  let p = ws.loadProject('demo');
  const cells = ws.sliceAsset(p, 'sheet1', { rows: 2, cols: 2, names: ['red', 'blue', '', 'purple'] });
  ws.saveProject(p);
  assert.deepEqual(cells.map((c) => c.name), ['red', 'blue', 'purple']);
  assert.equal(ws.loadProject('demo').assets.red.raw, 'frames/red.png', 'manifest paths are posix');

  p = ws.loadProject('demo');
  const steps = [{ op: 'remove_bg' }, { op: 'trim' }, { op: 'pixelate', size: 16, count: 4, save_palette: true }, { op: 'fit', width: 20, kernel: 'nearest', align: 'bottom' }];
  const [res] = ws.processBatch(p, ['red'], steps);
  assert.equal(res.width, 20); assert.equal(res.height, 20);
  assert.ok(p.palette.length >= 1 && p.palette.length <= 4);
  const out = img.decode(fs.readFileSync(res.file));
  assert.equal(out.data[3], 0, 'corner transparent');
  assert.equal(out.data[((19 * 20) + 10) * 4 + 3], 255, 'bottom-aligned subject touches bottom row');

  // Re-running starts from raw, so results are identical, not compounded.
  const [res2] = ws.processBatch(p, ['red'], steps);
  assert.deepEqual(fs.readFileSync(res2.file), fs.readFileSync(res.file));

  ws.processBatch(p, ['blue'], [{ op: 'remove_bg' }, { op: 'trim' }, { op: 'pixelate', size: 16, palette: 'project' }, { op: 'fit', width: 20, kernel: 'nearest' }]);
  assert.throws(() => ws.buildSheet(p, { name: 'blobs', frames: ['red', 'blue', 'purple'] }), /Not processed yet: purple/);
  ws.processBatch(p, ['purple'], [{ op: 'remove_bg' }, { op: 'trim' }, { op: 'pixelate', size: 16, palette: 'project' }, { op: 'fit', width: 20, kernel: 'nearest' }]);
  const sheet = ws.buildSheet(p, { name: 'blobs', frames: ['red', 'blue', 'purple'], fps: 4 });
  ws.saveProject(p);
  assert.equal(sheet.frameWidth, 20);
  const atlas = JSON.parse(fs.readFileSync(sheet.json, 'utf8'));
  assert.deepEqual(Object.keys(atlas.frames), ['red', 'blue', 'purple']);
  assert.equal(fs.readFileSync(sheet.gif).toString('ascii', 0, 3), 'GIF');

  // Regenerated sheet: re-slicing with overwrite replaces cells and drops their stale processed files.
  const before = Object.keys(p.assets).length;
  const re = ws.sliceAsset(p, 'sheet1', { rows: 2, cols: 2, names: ['red', '', '', ''], overwrite: true });
  ws.saveProject(p);
  assert.deepEqual(re.map((c) => c.name), ['red']);
  assert.equal(Object.keys(p.assets).length, before);
  assert.equal(p.assets.red.processed, null);
  assert.ok(!fs.existsSync(path.join(ws.projectDir('demo'), 'processed', 'red.png')));

  const d = ws.describeProject(ws.loadProject('demo'));
  assert.ok(path.isAbsolute(d.assets[0].raw));
  assert.ok(d.sheets.blobs.png.endsWith('blobs.png'));
});

test('download wait times out with guidance', async () => {
  await assert.rejects(ws.waitForDownload({ nameContains: 'never-there', timeoutSec: 1 }), /ASSET_STUDIO_DOWNLOADS/);
});

test('prompt builder: grid layout, anchor and references', async () => {
  const p = ws.loadProject('demo');
  p.anchor = { asset: 'red', stage: 'raw' };
  ws.saveProject(p);
  const face = path.join(tmp, 'face.png');
  fs.writeFileSync(face, gridSheet());
  ws.addReference({ project: 'demo', path: face, role: 'face', note: 'face only' });
  const { prompt, attach } = buildPrompt(ws.loadProject('demo'), { task: 'animation', rows: 1, cols: 4, items: ['a', 'b', 'c', 'd'], action: 'bounce' });
  assert.match(prompt, /wide landscape/);
  assert.match(prompt, /32x32 pixel grid/);
  assert.match(prompt, /4\. \(row 1, column 4\) d/);
  assert.match(prompt, /#00FF00/);
  assert.equal(attach[0].role, 'anchor');
  assert.equal(attach[1].role, 'face');
  assert.throws(() => buildPrompt(p, { task: 'grid', rows: 2, cols: 2, items: ['x'] }), /4 cells/);
});

test('animation batch: group trim keeps alignment, shared palette, scale, per-asset errors', async () => {
  // 1x3 strip of 100x100 cells; a 20px square moves right by 10px per frame on green.
  const im = img.createImage(300, 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 300; x++) {
    const f = Math.floor(x / 100), lx = x % 100;
    const on = lx >= 30 + f * 10 && lx < 50 + f * 10 && y >= 40 && y < 60;
    im.data.set([...(on ? [200 - f * 60, 30, 30 + f * 60] : [0, 255, 0]), 255], (y * 300 + x) * 4);
  }
  const src = path.join(tmp, 'strip.png');
  fs.writeFileSync(src, img.encodePng(im));
  await ws.ingest({ project: 'demo', name: 'walk', source: { path: src } });
  let p = ws.loadProject('demo');
  ws.sliceAsset(p, 'walk', { rows: 1, cols: 3, names: ['w1', 'w2', 'w3'] });
  const results = ws.processBatch(p, ['w1', 'w2', 'w3', 'missing'], [
    { op: 'remove_bg' }, { op: 'trim', group: true }, { op: 'pixelate', size: 8, palette: 'shared', count: 3, save_palette: true }, { op: 'scale', factor: 3 },
  ]);
  ws.saveProject(p);
  assert.match(results.find((r) => r.asset === 'missing').error, /not found/);
  const ok = results.filter((r) => r.file);
  assert.equal(ok.length, 3);
  // Union box is 40x20 (x 30..70); all frames share it, so the square's offset grows per frame.
  ok.forEach((r) => { assert.equal(r.width, 24); assert.equal(r.height, 12); });
  const firstOpaqueX = (file) => {
    const o = img.decode(fs.readFileSync(file));
    for (let x = 0; x < o.width; x++) if (o.data[(6 * o.width + x) * 4 + 3]) return x;
    return -1;
  };
  const xs = ok.map((r) => firstOpaqueX(r.file));
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2], `frames not aligned to a shared box: ${xs}`);
  assert.equal(ws.loadProject('demo').palette.length, 3);
});
