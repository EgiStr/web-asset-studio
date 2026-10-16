// Project folders and the project.json manifest. Every path returned to the agent is absolute.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import * as img from './image.mjs';

export const STAGE_DIRS = { raw: 'raw', frame: 'frames', processed: 'processed', sheet: 'sheets', video: 'video', ref: 'refs' };
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov']);
const PARTIAL_EXT = /\.(crdownload|part|partial|tmp|download)$/i;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_HINTS = { 'key-green': '#00ff00', 'key-magenta': '#ff00ff', white: '#ffffff' };

// Claude Code sets CLAUDE_PROJECT_DIR for stdio servers; other clients start the server in the project.
export function studioRoot() {
  return path.resolve(process.env.ASSET_STUDIO_ROOT || path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'asset-studio'));
}

// Windows lets users move the Downloads known folder (e.g. to D:\Downloads); read it from the registry.
let knownDownloads;
function windowsDownloads() {
  if (knownDownloads !== undefined) return knownDownloads;
  knownDownloads = null;
  const key = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`;
  const r = spawnSync('reg', ['query', key, '/v', '{374DE290-123F-4565-9164-39C4925E467B}'], { encoding: 'utf8' });
  const m = r.status === 0 && /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(r.stdout);
  if (m) knownDownloads = m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
  return knownDownloads;
}

export function downloadsDir() {
  if (process.env.ASSET_STUDIO_DOWNLOADS) return path.resolve(process.env.ASSET_STUDIO_DOWNLOADS);
  return path.resolve((process.platform === 'win32' && windowsDownloads()) || path.join(os.homedir(), 'Downloads'));
}

export function checkName(name, what = 'name') {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Invalid ${what} "${name}": use lowercase letters, digits, "-" or "_" (max 64 chars, e.g. "happy-face").`);
  }
  return name;
}

export function projectDir(project) {
  return path.join(studioRoot(), checkName(project, 'project name'));
}

function manifestPath(project) {
  return path.join(projectDir(project), 'project.json');
}

export function loadProject(project) {
  const file = manifestPath(project);
  if (!fs.existsSync(file)) {
    const known = listProjects().map((p) => p.name);
    throw new Error(`Project "${project}" not found in ${studioRoot()}. Existing: ${known.join(', ') || '(none)'}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveProject(p) {
  p.updated = new Date().toISOString();
  const file = manifestPath(p.name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file);
}

export function listProjects() {
  const root = studioRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'project.json')))
    .map((e) => {
      const p = JSON.parse(fs.readFileSync(path.join(root, e.name, 'project.json'), 'utf8'));
      return { name: p.name, type: p.type, assets: Object.keys(p.assets).length, updated: p.updated };
    });
}

export function createProject({ name, type, bible, pixel }) {
  const dir = projectDir(name);
  if (fs.existsSync(path.join(dir, 'project.json'))) throw new Error(`Project "${name}" already exists at ${dir}. Use project_get / project_update.`);
  for (const sub of Object.values(STAGE_DIRS)) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const now = new Date().toISOString();
  const p = {
    name, type, created: now, updated: now,
    bible: { subject: '', style: '', palette: [], background: 'key-green', rules: [], avoid: [], ...bible },
    pixel: pixel ?? null,
    palette: [],
    anchor: null,
    references: [],
    assets: {},
    sheets: {},
  };
  saveProject(p);
  return p;
}

export function abs(project, rel) {
  return rel ? path.join(projectDir(project), rel) : null;
}

export function uniqueName(p, base) {
  if (!p.assets[base]) return base;
  for (let i = 2; ; i++) if (!p.assets[`${base}-${i}`]) return `${base}-${i}`;
}

function extFor(buf, fallbackName) {
  const sniffed = img.sniffFormat(buf);
  if (sniffed) return sniffed;
  const ext = path.extname(fallbackName || '').slice(1).toLowerCase();
  if (MEDIA_EXT.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  throw new Error('File is not a recognized image or video (png, jpg, webp, gif, mp4, webm).');
}

function imageSize(buf) {
  try { const i = img.decode(buf); return [i.width, i.height]; } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for a finished download: newest media file in the downloads dir that matches
// `nameContains` (or is younger than maxAgeSec) and whose size stopped changing.
export async function waitForDownload({ nameContains, maxAgeSec = 180, timeoutSec = 120 } = {}) {
  const dir = downloadsDir();
  if (!fs.existsSync(dir)) throw new Error(`Downloads folder ${dir} does not exist. Set ASSET_STUDIO_DOWNLOADS to Chrome's download folder.`);
  const deadline = Date.now() + timeoutSec * 1000;
  const needle = nameContains?.toLowerCase();
  let lastSeen = null;
  while (Date.now() < deadline) {
    const cutoff = Date.now() - maxAgeSec * 1000;
    const candidates = fs.readdirSync(dir)
      .filter((f) => !PARTIAL_EXT.test(f) && MEDIA_EXT.has(path.extname(f).slice(1).toLowerCase()))
      .filter((f) => !needle || f.toLowerCase().includes(needle))
      .map((f) => { try { const st = fs.statSync(path.join(dir, f)); return { f, st }; } catch { return null; } })
      .filter((c) => c && c.st.isFile() && c.st.size > 0 && (needle || c.st.mtimeMs >= cutoff))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    if (candidates.length) {
      const { f, st } = candidates[0];
      if (lastSeen && lastSeen.f === f && lastSeen.size === st.size) return path.join(dir, f);
      lastSeen = { f, size: st.size };
    }
    await sleep(700);
  }
  throw new Error(`No finished download${needle ? ` containing "${nameContains}"` : ` newer than ${maxAgeSec}s`} appeared in ${dir} within ${timeoutSec}s. ` +
    'Check that Chrome downloads there (or set ASSET_STUDIO_DOWNLOADS) and that "Ask where to save each file" is off.');
}

async function fetchUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}. The URL probably needs your browser session; use source "download" instead.`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function ingest({ project, name, source, prompt, chatUrl, parent, tags, overwrite = false }) {
  const p = loadProject(project);
  checkName(name, 'asset name');
  const finalName = overwrite ? name : uniqueName(p, name);
  let buf, origin, movedFrom = null;
  if (source.path) {
    if (!path.isAbsolute(source.path)) throw new Error('source.path must be absolute');
    buf = fs.readFileSync(source.path);
    origin = { type: 'path', path: source.path };
  } else if (source.url) {
    buf = await fetchUrl(source.url);
    origin = { type: 'url', url: source.url.split('?')[0] };
  } else if (source.download) {
    const file = await waitForDownload(source.download);
    buf = fs.readFileSync(file);
    movedFrom = source.download.keep ? null : file;
    origin = { type: 'download', file: path.basename(file) };
  } else {
    throw new Error('source needs one of: path, url, download');
  }
  const ext = extFor(buf, origin.path || origin.file || origin.url);
  const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
  const rel = path.posix.join(isVideo ? STAGE_DIRS.video : STAGE_DIRS.raw, `${finalName}.${ext}`);
  fs.writeFileSync(abs(project, rel), buf);
  if (movedFrom) fs.unlinkSync(movedFrom);
  const now = new Date().toISOString();
  const size = isVideo ? null : imageSize(buf);
  const prev = p.assets[finalName];
  if (prev) {
    // Overwriting: drop files of the old version that the new one does not replace.
    if (prev.raw !== rel) fs.rmSync(abs(project, prev.raw), { force: true });
    if (prev.processed) fs.rmSync(abs(project, prev.processed), { force: true });
  }
  p.assets[finalName] = {
    name: finalName, kind: isVideo ? 'video' : 'image', raw: rel, processed: null,
    size: { raw: size, processed: null }, format: ext,
    source: origin, prompt: prompt ?? null, chat_url: chatUrl ?? null, parent: parent ?? null,
    tags: tags ?? [], created: prev?.created ?? now, updated: now,
  };
  saveProject(p);
  return { asset: p.assets[finalName], file: abs(project, rel), warning: ext === 'webp' ? 'WEBP cannot be processed; download the PNG version instead.' : undefined };
}

export function addReference({ project, path: src, role, note }) {
  const p = loadProject(project);
  if (!path.isAbsolute(src)) throw new Error('path must be absolute');
  const buf = fs.readFileSync(src);
  const ext = extFor(buf, src);
  const base = checkName(path.basename(src, path.extname(src)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'ref', 'reference name');
  let file = path.posix.join(STAGE_DIRS.ref, `${role}-${base}.${ext}`);
  for (let i = 2; p.references.some((r) => r.file === file); i++) file = path.posix.join(STAGE_DIRS.ref, `${role}-${base}-${i}.${ext}`);
  fs.copyFileSync(src, abs(project, file));
  p.references.push({ file, role, note: note ?? null, added: new Date().toISOString() });
  saveProject(p);
  return { file: abs(project, file), references: p.references.map((r) => ({ ...r, file: abs(project, r.file) })) };
}

export function readAssetImage(p, name, stage = 'auto') {
  const a = p.assets[name];
  if (!a) throw new Error(`Asset "${name}" not found in project "${p.name}". Known: ${Object.keys(p.assets).join(', ') || '(none)'}`);
  if (a.kind !== 'image') throw new Error(`Asset "${name}" is a ${a.kind}, not an image`);
  const rel = stage === 'raw' ? a.raw : stage === 'processed' ? a.processed : (a.processed ?? a.raw);
  if (!rel) throw new Error(`Asset "${name}" has no ${stage} version yet; run process first.`);
  return { image: img.decode(fs.readFileSync(abs(p.name, rel))), rel };
}

// Runs steps on the RAW files of a batch in lockstep and writes processed/<name>.png, so re-running
// with tweaked settings never compounds earlier processing. Lockstep lets a step see the whole set:
// trim {group:true} crops every frame to one shared box (keeps animation aligned) and
// pixelate {palette:"shared"} derives one palette from all frames.
export function processBatch(p, names, steps) {
  const items = [];
  const results = [];
  for (const name of names) {
    try {
      items.push({ name, image: readAssetImage(p, name, 'raw').image, log: [] });
    } catch (e) {
      results.push({ asset: name, error: e.message });
    }
  }
  const fail = (it, e) => { it.error = e.message; };
  const live = () => items.filter((it) => !it.error);
  const each = (fn) => { for (const it of live()) { try { fn(it); } catch (e) { fail(it, e); } } };

  for (const step of steps) {
    switch (step.op) {
      case 'remove_bg':
        each((it) => {
          const r = img.removeBackground(it.image, { mode: step.mode, colors: step.colors, tolerance: step.tolerance, fringe: step.fringe, hint: KEY_HINTS[p.bible.background] });
          if (r.removedShare > 0.97) throw new Error('remove_bg removed almost everything; lower the tolerance or pass the background color explicitly.');
          it.image = r.image;
          it.log.push(r.note ?? `remove_bg: removed ${Math.round(r.removedShare * 100)}% of pixels, background ${r.removedColors.join(' ')}`);
        });
        break;
      case 'trim': {
        const padding = step.padding ?? 0;
        if (step.group) {
          const boxes = live().map((it) => {
            const b = img.alphaBounds(it.image);
            if (!b) fail(it, new Error('Image is fully transparent; background removal tolerance is probably too high.'));
            return b && { it, b };
          }).filter(Boolean);
          if (!boxes.length) break;
          const sizes = new Set(boxes.map(({ it }) => `${it.image.width}x${it.image.height}`));
          if (sizes.size > 1) throw new Error(`trim group needs frames of one size, got ${[...sizes].join(', ')}. Slice them from the same grid.`);
          const x0 = Math.min(...boxes.map(({ b }) => b.x)), y0 = Math.min(...boxes.map(({ b }) => b.y));
          const x1 = Math.max(...boxes.map(({ b }) => b.x + b.width)), y1 = Math.max(...boxes.map(({ b }) => b.y + b.height));
          for (const { it } of boxes) {
            const out = img.createImage(x1 - x0 + padding * 2, y1 - y0 + padding * 2);
            img.paste(out, img.crop(it.image, x0, y0, x1 - x0, y1 - y0), padding, padding);
            it.image = out;
            it.log.push(`trim group -> ${out.width}x${out.height}`);
          }
        } else {
          each((it) => { it.image = img.trim(it.image, { padding }); it.log.push(`trim -> ${it.image.width}x${it.image.height}`); });
        }
        break;
      }
      case 'crop': each((it) => { it.image = img.crop(it.image, step.x ?? 0, step.y ?? 0, step.width, step.height); it.log.push(`crop -> ${it.image.width}x${it.image.height}`); }); break;
      case 'resize': each((it) => { it.image = img.resize(it.image, step.width, step.height, step.kernel ?? 'area'); it.log.push(`resize -> ${it.image.width}x${it.image.height}`); }); break;
      case 'scale': {
        const f = step.factor;
        if (!Number.isInteger(f) || f < 1) throw new Error('scale.factor must be an integer >= 1');
        each((it) => { it.image = img.resize(it.image, it.image.width * f, it.image.height * f, 'nearest'); it.log.push(`scale x${f} -> ${it.image.width}x${it.image.height}`); });
        break;
      }
      case 'fit':
        each((it) => {
          it.image = img.fit(it.image, step.width, step.height ?? step.width, { kernel: step.kernel ?? 'area', align: step.align ?? 'center', upscale: step.upscale ?? true });
          it.log.push(`fit -> ${it.image.width}x${it.image.height} (${step.align ?? 'center'})`);
        });
        break;
      case 'pixelate': {
        const size = step.size ?? p.pixel?.size;
        const colors = step.count ?? p.pixel?.colors ?? 16;
        each((it) => { it.image = img.pixelGrid(it.image, { size }); });
        let shared = null;
        if (step.palette === 'project') {
          if (!p.palette.length) throw new Error('palette "project" requested but the project has no locked palette yet; run pixelate with save_palette: true first.');
          shared = p.palette.map(img.parseHex);
        } else if (Array.isArray(step.palette)) {
          shared = step.palette.map(img.parseHex);
        } else if (step.palette === 'shared') {
          shared = img.medianCutPalette(live().map((it) => it.image), colors);
        }
        let saved = null;
        each((it) => {
          const pal = shared ?? img.medianCutPalette(it.image, colors);
          if (pal.length) it.image = img.applyFixedPalette(it.image, pal);
          if (!saved) saved = pal;
          if (step.scale > 1) it.image = img.resize(it.image, it.image.width * step.scale, it.image.height * step.scale, 'nearest');
          it.log.push(`pixelate -> ${it.image.width}x${it.image.height}, ${pal.length} colors${shared ? ' (shared palette)' : ''}`);
        });
        if (step.save_palette && saved) p.palette = saved.map(img.toHex);
        break;
      }
      case 'outline':
        each((it) => {
          it.image = img.outline(it.image, { width: step.width ?? 8, color: step.color ?? '#ffffff', hard: step.hard ?? false });
          it.log.push(`outline ${step.width ?? 8}px ${step.color ?? '#ffffff'} -> ${it.image.width}x${it.image.height}`);
        });
        break;
      default: throw new Error(`Unknown step op "${step.op}"`);
    }
  }

  const now = new Date().toISOString();
  for (const it of items) {
    if (it.error) { results.push({ asset: it.name, error: it.error }); continue; }
    const rel = path.posix.join(STAGE_DIRS.processed, `${it.name}.png`);
    fs.writeFileSync(abs(p.name, rel), img.encodePng(it.image));
    const a = p.assets[it.name];
    a.processed = rel;
    a.size.processed = [it.image.width, it.image.height];
    a.steps = steps;
    a.updated = now;
    results.push({ asset: it.name, file: abs(p.name, rel), width: it.image.width, height: it.image.height, log: it.log });
  }
  return results;
}

export function sliceAsset(p, name, { rows, cols, names, inset = 0, overwrite = false }) {
  const { image } = readAssetImage(p, name, 'raw');
  const cells = img.sliceGrid(image, rows, cols, { inset });
  if (names && names.length !== rows * cols) throw new Error(`names has ${names.length} entries but the grid has ${rows * cols} cells (use "" to skip a cell)`);
  const out = [];
  const now = new Date().toISOString();
  cells.forEach((cell, i) => {
    const wanted = names ? names[i] : `${name}-r${cell.row + 1}c${cell.col + 1}`;
    if (!wanted) return;
    checkName(wanted, 'cell name');
    const finalName = overwrite ? wanted : uniqueName(p, wanted);
    const rel = path.posix.join(STAGE_DIRS.frame, `${finalName}.png`);
    const prev = p.assets[finalName];
    if (prev) {
      // Overwriting after a regenerate: the old processed file belongs to the old cell.
      if (prev.raw !== rel) fs.rmSync(abs(p.name, prev.raw), { force: true });
      if (prev.processed) fs.rmSync(abs(p.name, prev.processed), { force: true });
    }
    fs.writeFileSync(abs(p.name, rel), img.encodePng(cell.image));
    p.assets[finalName] = {
      name: finalName, kind: 'image', raw: rel, processed: null,
      size: { raw: [cell.image.width, cell.image.height], processed: null }, format: 'png',
      source: { type: 'slice', from: name, row: cell.row + 1, col: cell.col + 1 },
      prompt: p.assets[name].prompt, chat_url: p.assets[name].chat_url, parent: name,
      tags: p.assets[name].tags, created: now, updated: now,
    };
    out.push({ name: finalName, file: abs(p.name, rel), row: cell.row + 1, col: cell.col + 1 });
  });
  return out;
}

export function buildSheet(p, { name, frames, stage = 'processed', columns, padding = 0, align = 'center', fps = 8, gifScale = 1 }) {
  checkName(name, 'sheet name');
  if (!frames.length) throw new Error('frames is empty');
  const missing = frames.filter((f) => !p.assets[f]);
  if (missing.length) throw new Error(`Unknown frames: ${missing.join(', ')}`);
  if (stage === 'processed') {
    const unprocessed = frames.filter((f) => !p.assets[f].processed);
    if (unprocessed.length) throw new Error(`Not processed yet: ${unprocessed.join(', ')}. Run process on them with the same steps as the other frames, or pass stage "raw".`);
  }
  const loaded = frames.map((f) => ({ name: f, image: readAssetImage(p, f, stage).image }));
  const { sheet, cellW, cellH, columns: cols, rows, placed } = img.composeSheet(loaded, { columns, padding, align });
  const base = path.posix.join(STAGE_DIRS.sheet, name);
  fs.writeFileSync(abs(p.name, base + '.png'), img.encodePng(sheet));
  const atlas = {
    frames: Object.fromEntries(placed.map((f) => [f.name, {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h }, sourceSize: { w: f.w, h: f.h }, duration: Math.round(1000 / fps),
    }])),
    meta: { app: 'web-asset-studio', image: `${name}.png`, format: 'RGBA8888', size: { w: sheet.width, h: sheet.height }, scale: '1', frameWidth: cellW, frameHeight: cellH, columns: cols, rows, padding, fps },
  };
  fs.writeFileSync(abs(p.name, base + '.json'), JSON.stringify(atlas, null, 2));
  const cells = placed.map((f) => img.crop(sheet, f.x, f.y, f.w, f.h));
  fs.writeFileSync(abs(p.name, base + '.gif'), img.encodeGif(cells, { fps, scale: gifScale }));
  p.sheets[name] = { png: base + '.png', json: base + '.json', gif: base + '.gif', frames, cell: [cellW, cellH], columns: cols, rows, fps, updated: new Date().toISOString() };
  return {
    png: abs(p.name, base + '.png'), json: abs(p.name, base + '.json'), gif: abs(p.name, base + '.gif'),
    frameWidth: cellW, frameHeight: cellH, columns: cols, rows,
  };
}

export function ffmpegAvailable() {
  const bin = process.env.ASSET_STUDIO_FFMPEG || 'ffmpeg';
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? bin : null;
}

export function videoToFrames(p, name, { fps = 8, maxFrames = 48 }) {
  const a = p.assets[name];
  if (!a || a.kind !== 'video') throw new Error(`Asset "${name}" is not a video in project "${p.name}"`);
  const bin = ffmpegAvailable();
  if (!bin) throw new Error('ffmpeg not found. Install it (winget install Gyan.FFmpeg) or set ASSET_STUDIO_FFMPEG to ffmpeg.exe, then retry.');
  const prefix = `${name}-f`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-studio-'));
  try {
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-i', abs(p.name, a.raw), '-vf', `fps=${fps}`, '-frames:v', String(maxFrames), path.join(tmpDir, '%03d.png')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim()}`);
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.png')).sort();
    const now = new Date().toISOString();
    return files.map((f, i) => {
      const frameName = uniqueName(p, `${prefix}${String(i + 1).padStart(3, '0')}`);
      const rel = path.posix.join(STAGE_DIRS.frame, `${frameName}.png`);
      fs.copyFileSync(path.join(tmpDir, f), abs(p.name, rel));
      const size = imageSize(fs.readFileSync(abs(p.name, rel)));
      p.assets[frameName] = {
        name: frameName, kind: 'image', raw: rel, processed: null, size: { raw: size, processed: null }, format: 'png',
        source: { type: 'video-frame', from: name, index: i + 1, fps }, prompt: a.prompt, chat_url: a.chat_url, parent: name,
        tags: a.tags, created: now, updated: now,
      };
      return { name: frameName, file: abs(p.name, rel) };
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function describeProject(p) {
  const assets = Object.values(p.assets).map((a) => ({
    name: a.name, kind: a.kind, raw: abs(p.name, a.raw), processed: abs(p.name, a.processed),
    size: a.size, parent: a.parent, tags: a.tags,
  }));
  return {
    name: p.name, type: p.type, dir: projectDir(p.name), bible: p.bible, pixel: p.pixel, palette: p.palette,
    anchor: p.anchor ? { ...p.anchor, file: anchorFile(p) } : null,
    references: p.references.map((r) => ({ ...r, file: abs(p.name, r.file) })),
    assets,
    sheets: Object.fromEntries(Object.entries(p.sheets).map(([k, s]) => [k, { ...s, png: abs(p.name, s.png), json: abs(p.name, s.json), gif: abs(p.name, s.gif) }])),
  };
}

export function anchorFile(p) {
  if (!p.anchor) return null;
  const a = p.assets[p.anchor.asset];
  if (!a) return null;
  return abs(p.name, p.anchor.stage === 'processed' && a.processed ? a.processed : a.raw);
}
