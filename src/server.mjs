#!/usr/bin/env node
// MCP server: the deterministic half of the asset pipeline (folders, manifest, prompt
// composition, image processing). Driving chatgpt.com is left to a browser MCP, guided by the skill.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as ws from './workspace.mjs';
import * as img from './image.mjs';
import { buildPrompt } from './prompts.mjs';

const VERSION = '1.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, '..', 'skills', 'asset-studio');

const server = new McpServer(
  { name: 'web-asset-studio', version: VERSION },
  {
    instructions:
      'Asset pipeline for images generated in the ChatGPT web app through a browser MCP. Flow: project_create (style bible) -> build_prompt -> ' +
      'generate in chatgpt.com with the browser tools (attach the files build_prompt lists) -> ingest -> look at the result -> slice_grid / process -> ' +
      'set_anchor on the best one -> build_spritesheet. Get the full browser procedure from the prompt "asset_studio_workflow" before the first generation.',
  },
);

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  });
}

// Thumbnails on a checkerboard so the agent can see whether background removal worked.
function previewContent(images, label) {
  const T = 160;
  const cols = Math.min(images.length, 6);
  const rows = Math.ceil(images.length / cols);
  const sheet = img.createImage(cols * T, rows * T);
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const v = ((x >> 3) + (y >> 3)) % 2 ? 200 : 255;
      const i = (y * sheet.width + x) * 4;
      sheet.data[i] = v; sheet.data[i + 1] = v; sheet.data[i + 2] = v; sheet.data[i + 3] = 255;
    }
  }
  images.forEach((im, i) => {
    const small = img.fit(im, T - 8, T - 8, { kernel: 'area', upscale: im.width < 64 && im.height < 64 });
    img.paste(sheet, small, (i % cols) * T + 4, Math.floor(i / cols) * T + 4);
  });
  return [
    { type: 'text', text: `Preview (${label}) on a checkerboard; checkerboard visible = transparent:` },
    { type: 'image', data: img.encodePng(sheet).toString('base64'), mimeType: 'image/png' },
  ];
}

const bibleShape = {
  subject: z.string().optional().describe('Exhaustive, reusable description of the subject: face shape, eyes, nose, mouth, hair, skin tone, outfit, accessories, proportions'),
  style: z.string().optional().describe('Rendering style, e.g. "chibi die-cut sticker, thick clean outlines, flat cel shading"'),
  palette: z.array(z.string()).optional().describe('Hex colors to restrict to, e.g. ["#2b2b2b","#f2c6a0"]'),
  background: z.string().optional().describe('"key-green" (default, easiest to remove), "key-magenta" (green subjects), "white", "transparent", or a custom description'),
  rules: z.array(z.string()).optional().describe('Extra hard rules repeated in every prompt'),
  avoid: z.array(z.string()).optional().describe('Extra things to avoid'),
};

tool('studio_info', 'Where assets are stored, which downloads folder is watched, ffmpeg availability, and the list of projects. Call first.', {}, async () =>
  text({
    version: VERSION,
    root: ws.studioRoot(),
    downloads_dir: ws.downloadsDir(),
    downloads_dir_exists: fs.existsSync(ws.downloadsDir()),
    ffmpeg: ws.ffmpegAvailable(),
    projects: ws.listProjects(),
    env: { ASSET_STUDIO_ROOT: 'override asset root', ASSET_STUDIO_DOWNLOADS: "override Chrome's download folder", ASSET_STUDIO_FFMPEG: 'path to ffmpeg' },
  }));

tool('project_create', 'Create an asset project with a style bible that every prompt reuses (this is what keeps a set consistent).', {
  name: z.string().describe('Lowercase slug, e.g. "my-face-stickers"'),
  type: z.enum(['sticker', 'sprite', 'tileset', 'ui', 'icon', 'illustration', 'video']).describe('What the set is'),
  bible: z.object(bibleShape).describe('Style bible'),
  pixel: z.object({
    size: z.number().int().min(4).max(512).describe('True pixel grid, e.g. 32 or 64'),
    colors: z.number().int().min(2).max(256).optional().describe('Palette size, default 16'),
  }).optional().describe('Set for pixel-art projects'),
}, async ({ name, type, bible, pixel }) => {
  ws.checkName(name, 'project name');
  return text(ws.describeProject(ws.createProject({ name, type, bible, pixel })));
});

tool('project_get', 'Project bible, anchor, references, every asset with absolute file paths, and sheets.', {
  project: z.string(),
}, async ({ project }) => text(ws.describeProject(ws.loadProject(project))));

tool('project_update', 'Change the style bible (merged field by field), pixel settings, or the locked palette.', {
  project: z.string(),
  bible: z.object(bibleShape).optional(),
  pixel: z.object({ size: z.number().int().min(4).max(512), colors: z.number().int().min(2).max(256).optional() }).nullable().optional(),
  palette: z.array(z.string()).optional().describe('Locked palette used by pixelate palette:"project"; [] clears it'),
}, async ({ project, bible, pixel, palette }) => {
  const p = ws.loadProject(project);
  if (bible) p.bible = { ...p.bible, ...Object.fromEntries(Object.entries(bible).filter(([, v]) => v !== undefined)) };
  if (pixel !== undefined) p.pixel = pixel;
  if (palette) { palette.forEach(img.parseHex); p.palette = palette; }
  ws.saveProject(p);
  return text(ws.describeProject(p));
});

tool('add_reference', 'Copy a reference image (the user\'s face photo, a style sample) into the project\'s refs folder. Upload the returned path to ChatGPT.', {
  project: z.string(),
  path: z.string().describe('Absolute path of the source image'),
  role: z.enum(['face', 'character', 'style', 'pose', 'other']),
  note: z.string().optional().describe('What to take from it, e.g. "take only the face"'),
}, async (args) => text(ws.addReference(args)));

tool('set_anchor', 'Mark an approved asset as the anchor: build_prompt then attaches it to every later generation so the character stays the same.', {
  project: z.string(),
  asset: z.string(),
  stage: z.enum(['raw', 'processed']).default('raw').describe('raw keeps ChatGPT\'s full-resolution render (usually the better reference)'),
}, async ({ project, asset, stage }) => {
  const p = ws.loadProject(project);
  if (!p.assets[asset]) throw new Error(`Asset "${asset}" not found`);
  if (stage === 'processed' && !p.assets[asset].processed) throw new Error(`Asset "${asset}" has not been processed yet`);
  p.anchor = { asset, stage };
  ws.saveProject(p);
  return text({ anchor: p.anchor, file: ws.anchorFile(p) });
});

tool('build_prompt', 'Compose the ChatGPT prompt from the bible plus this request, and list the files to attach (anchor first). Paste the prompt verbatim.', {
  project: z.string(),
  task: z.enum(['single', 'grid', 'animation', 'variation']).describe('single = one image; grid = several variations (expressions, icons) in one image; animation = frames of one motion in one image; variation = edit of the anchor'),
  items: z.array(z.string()).describe('single: [what to draw]; grid/animation: one entry per cell, row by row; variation: [the change]'),
  rows: z.number().int().min(1).max(6).optional(),
  cols: z.number().int().min(1).max(6).optional(),
  action: z.string().optional().describe('animation only, e.g. "walk cycle facing right"'),
  notes: z.string().optional().describe('Extra one-off instructions appended at the end'),
  use_anchor: z.boolean().default(true),
}, async ({ project, task, items, rows, cols, action, notes, use_anchor }) => {
  const p = ws.loadProject(project);
  return text(buildPrompt(p, { task, items, rows, cols, action, notes, useAnchor: use_anchor }));
});

tool('ingest', 'Save a generated image or video into the project (raw/ or video/) and record its prompt. Source: a finished browser download (moved out of Downloads), a URL, or a local path.', {
  project: z.string(),
  name: z.string().describe('Asset slug, e.g. "expressions-sheet-1" or "happy"; "-2" is appended if taken unless overwrite'),
  source: z.object({
    download: z.object({
      name_contains: z.string().optional().describe('Part of the downloaded file name (set it when you chose the name). Without it the newest file is taken.'),
      max_age_sec: z.number().optional().describe('Without name_contains: only files modified in the last N seconds (default 180)'),
      timeout_sec: z.number().optional().describe('How long to wait for the download to finish (default 120)'),
      keep: z.boolean().optional().describe('Copy instead of moving out of Downloads'),
    }).optional(),
    url: z.string().optional().describe('Direct http(s) URL that works without cookies'),
    path: z.string().optional().describe('Absolute local file path'),
  }),
  prompt: z.string().optional().describe('The prompt that produced it'),
  chat_url: z.string().optional().describe('The chatgpt.com conversation URL, to continue the same chat later'),
  parent: z.string().optional(),
  tags: z.array(z.string()).optional(),
  overwrite: z.boolean().default(false),
  preview: z.boolean().default(true),
}, async ({ project, name, source, prompt, chat_url, parent, tags, overwrite, preview }) => {
  const r = await ws.ingest({
    project, name, prompt, chatUrl: chat_url, parent, tags, overwrite,
    source: source.download ? { download: { nameContains: source.download.name_contains, maxAgeSec: source.download.max_age_sec, timeoutSec: source.download.timeout_sec, keep: source.download.keep } } : source,
  });
  const out = text(r);
  if (preview && r.asset.kind === 'image' && r.asset.format !== 'webp') {
    out.content.push(...previewContent([img.decode(fs.readFileSync(r.file))], r.asset.name));
  }
  return out;
});

tool('slice_grid', 'Cut a grid image (from task grid/animation) into equal cells; each cell becomes its own asset in frames/.', {
  project: z.string(),
  asset: z.string(),
  rows: z.number().int().min(1).max(12),
  cols: z.number().int().min(1).max(12),
  names: z.array(z.string()).optional().describe('One slug per cell, row by row; "" skips a cell. Default <asset>-r1c1 ...'),
  inset: z.number().int().min(0).default(0).describe('Pixels shaved off each cell side (drops gutters/lines)'),
  overwrite: z.boolean().default(false).describe('Replace existing cells of the same name (after regenerating a sheet) instead of adding "-2" copies'),
  preview: z.boolean().default(true),
}, async ({ project, asset, rows, cols, names, inset, overwrite, preview }) => {
  const p = ws.loadProject(project);
  const cells = ws.sliceAsset(p, asset, { rows, cols, names, inset, overwrite });
  ws.saveProject(p);
  const out = text({ cells });
  if (preview && cells.length) out.content.push(...previewContent(cells.map((c) => img.decode(fs.readFileSync(c.file))), `${cells.length} cells`));
  return out;
});

const stepSchema = z.object({
  op: z.enum(['remove_bg', 'trim', 'crop', 'resize', 'fit', 'scale', 'pixelate', 'outline']),
  mode: z.enum(['flood', 'key']).optional().describe('remove_bg: flood (default, from the edges, keeps eye whites) or key (remove the color everywhere)'),
  colors: z.array(z.string()).optional().describe('remove_bg: background hex colors; default = detected from the border'),
  tolerance: z.number().optional().describe('remove_bg: RGB distance 0-441, default 40; raise for noisy backgrounds'),
  fringe: z.number().int().optional().describe('remove_bg: halo peel passes, default 1'),
  padding: z.number().int().optional().describe('trim: transparent margin to keep'),
  group: z.boolean().optional().describe('trim: crop every asset in this call to ONE shared box (use for animation frames so they stay aligned)'),
  factor: z.number().int().optional().describe('scale: integer nearest-neighbor upscale (pixel-perfect)'),
  x: z.number().int().optional(), y: z.number().int().optional(),
  width: z.number().optional().describe('crop/resize/fit: width; outline: thickness in px'),
  height: z.number().int().optional(),
  kernel: z.enum(['area', 'nearest']).optional().describe('area for downscaling, nearest for upscaling pixel art'),
  align: z.enum(['center', 'bottom']).optional().describe('fit: bottom keeps feet on one baseline'),
  upscale: z.boolean().optional(),
  size: z.number().int().optional().describe('pixelate: true pixel grid (default project pixel.size)'),
  palette: z.union([z.enum(['shared', 'project']), z.array(z.string())]).optional().describe('pixelate: "shared" = one palette from all assets in this call, "project" = the locked project palette, or an explicit hex list; default = per-image palette'),
  save_palette: z.boolean().optional().describe('pixelate: lock the resulting palette into the project (reuse later with palette "project")'),
  scale: z.number().int().optional().describe('pixelate: integer nearest-neighbor upscale after pixelating'),
  count: z.number().int().min(2).max(256).optional().describe('pixelate: number of palette colors (default project pixel.colors)'),
  color: z.string().optional().describe('outline: hex color, default #ffffff'),
  hard: z.boolean().optional().describe('outline: no anti-aliasing (pixel art)'),
});

tool('process', 'Run steps, in order, on the RAW files of one or more assets and write processed/<name>.png. Always starts from raw, so re-run with new settings freely. Pass every asset of a set in ONE call with the same steps so they come out uniform. Recipes: sticker = remove_bg, trim, outline, fit 512; animation = remove_bg, trim group, pixelate shared.', {
  project: z.string(),
  assets: z.array(z.string()).min(1),
  steps: z.array(stepSchema).min(1),
  preview: z.boolean().default(true),
}, async ({ project, assets, steps, preview }) => {
  const p = ws.loadProject(project);
  const results = ws.processBatch(p, assets, steps);
  ws.saveProject(p);
  const out = text({ results, palette: p.palette });
  const okFiles = results.filter((r) => r.file);
  if (preview && okFiles.length) out.content.push(...previewContent(okFiles.map((r) => img.decode(fs.readFileSync(r.file))), `${okFiles.length} processed`));
  if (!okFiles.length) out.isError = true;
  return out;
});

tool('build_spritesheet', 'Pack frames into one uniform-cell sprite sheet PNG + JSON atlas (TexturePacker hash, works in Phaser/Pixi; frameWidth/frameHeight for Godot/Unity) + animated GIF preview.', {
  project: z.string(),
  name: z.string().describe('Sheet slug, e.g. "walk-right"'),
  frames: z.array(z.string()).min(1).describe('Asset names in playback order'),
  stage: z.enum(['processed', 'raw']).default('processed'),
  columns: z.number().int().min(1).optional().describe('Default: all frames in one row'),
  padding: z.number().int().min(0).default(0),
  align: z.enum(['center', 'bottom']).default('center'),
  fps: z.number().min(1).max(60).default(8),
  gif_scale: z.number().int().min(1).max(16).default(1).describe('Integer upscale for the GIF preview (pixel art)'),
}, async ({ project, name, frames, stage, columns, padding, align, fps, gif_scale }) => {
  const p = ws.loadProject(project);
  const r = ws.buildSheet(p, { name, frames, stage, columns, padding, align, fps, gifScale: gif_scale });
  ws.saveProject(p);
  const out = text(r);
  out.content.push(...previewContent([img.decode(fs.readFileSync(r.png))], `sheet ${name}`));
  return out;
});

tool('video_to_frames', 'Extract PNG frames from an ingested video (needs ffmpeg) so they can be processed and packed like other frames.', {
  project: z.string(),
  asset: z.string(),
  fps: z.number().min(1).max(60).default(8),
  max_frames: z.number().int().min(1).max(500).default(48),
}, async ({ project, asset, fps, max_frames }) => {
  const p = ws.loadProject(project);
  const frames = ws.videoToFrames(p, asset, { fps, maxFrames: max_frames });
  ws.saveProject(p);
  return text({ frames });
});

function readSkillDoc(rel) {
  try { return fs.readFileSync(path.join(skillDir, rel), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); } catch { return null; }
}

server.registerPrompt('asset_studio_workflow', {
  description: 'Full procedure for generating consistent asset sets in chatgpt.com with a browser MCP and this server.',
  argsSchema: { goal: z.string().optional().describe('What the user wants, e.g. "12 pixel stickers of my face"') },
}, ({ goal }) => {
  const docs = ['SKILL.md', 'references/chatgpt-web.md', 'references/recipes.md'].map(readSkillDoc).filter(Boolean);
  const body = docs.length ? docs.join('\n\n---\n\n') : 'Workflow docs not found next to the server; see the project README.';
  return { messages: [{ role: 'user', content: { type: 'text', text: (goal ? `Goal: ${goal}\n\n` : '') + body } }] };
});

await server.connect(new StdioServerTransport());
