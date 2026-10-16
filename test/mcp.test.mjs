// Runs the bundled server from a folder with no node_modules, through a real MCP client, to prove
// dist/server.mjs is self-contained (that is how the plugin ships it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as img from '../src/image.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aas-mcp-'));
let client;

before(async () => {
  fs.mkdirSync(path.join(tmp, 'plugin', 'dist'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'dist', 'server.mjs'), path.join(tmp, 'plugin', 'dist', 'server.mjs'));
  fs.cpSync(path.join(repo, 'skills'), path.join(tmp, 'plugin', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'Downloads'));
  fs.mkdirSync(path.join(tmp, 'work'));
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(tmp, 'plugin', 'dist', 'server.mjs')],
    cwd: path.join(tmp, 'work'),
    env: { ...process.env, ASSET_STUDIO_ROOT: '', CLAUDE_PROJECT_DIR: '', ASSET_STUDIO_DOWNLOADS: path.join(tmp, 'Downloads') },
    stderr: 'pipe',
  }));
});

after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const json = r.content[0].type === 'text' && r.content[0].text.startsWith('{') ? JSON.parse(r.content[0].text) : r.content[0].text;
  return { r, json };
};

test('tools and prompt are listed', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'add_reference', 'build_prompt', 'build_spritesheet', 'ingest', 'process', 'project_create', 'project_get',
    'project_update', 'set_anchor', 'slice_grid', 'studio_info', 'video_to_frames',
  ]);
  const { prompts } = await client.listPrompts();
  assert.equal(prompts[0].name, 'asset_studio_workflow');
  const pr = await client.getPrompt({ name: 'asset_studio_workflow', arguments: { goal: 'stickers' } });
  assert.match(pr.messages[0].content.text, /^Goal: stickers/);
  assert.match(pr.messages[0].content.text, /chatgpt\.com/);
});

test('default root is <cwd>/asset-studio and tools work end to end', async () => {
  const { json: info } = await call('studio_info');
  assert.equal(fs.realpathSync(path.dirname(info.root)), fs.realpathSync(path.join(tmp, 'work')));
  assert.equal(path.basename(info.root), 'asset-studio');

  const { json: created } = await call('project_create', { name: 'face', type: 'sticker', bible: { subject: 'me', style: 'chibi' } });
  assert.equal(created.bible.background, 'key-green');

  // 1024x1024 render: green key background, a skin-colored disc with white "eyes".
  const im = img.createImage(1024, 1024);
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    const d = Math.hypot(x - 512, y - 512);
    const eye = Math.hypot(x - 430, y - 470) < 40 || Math.hypot(x - 594, y - 470) < 40;
    const c = d < 300 ? (eye ? [255, 255, 255] : [240, 190, 150]) : [0, 255, 0];
    im.data.set([...c, 255], (y * 1024 + x) * 4);
  }
  const dl = path.join(tmp, 'Downloads', 'aas_face_happy.png');
  fs.writeFileSync(dl, img.encodePng(im));

  const { r: ing, json: asset } = await call('ingest', { project: 'face', name: 'happy', source: { download: { name_contains: 'aas_face_happy', timeout_sec: 10 } }, prompt: 'x' });
  assert.ok(!ing.isError, JSON.stringify(ing.content[0]));
  assert.equal(asset.asset.name, 'happy');
  assert.equal(ing.content.at(-1).type, 'image');

  const t0 = Date.now();
  const { r: pr, json: proc } = await call('process', {
    project: 'face', assets: ['happy'],
    steps: [{ op: 'remove_bg' }, { op: 'trim', padding: 4 }, { op: 'outline', width: 12 }, { op: 'fit', width: 512 }],
  });
  const ms = Date.now() - t0;
  assert.ok(!pr.isError, pr.content[0].text);
  assert.equal(proc.results[0].width, 512);
  assert.ok(ms < 15000, `processing took ${ms}ms`);
  const out = img.decode(fs.readFileSync(proc.results[0].file));
  assert.equal(out.data[3], 0, 'corner transparent');
  // Eye white is enclosed by skin, so it must survive background removal.
  // 600px disc + 2*4 trim padding + 2*13 outline canvas = 634px, fitted to 512.
  const ex = Math.round(256 + (430 - 512) * (512 / 634)), ey = Math.round(256 + (470 - 512) * (512 / 634));
  assert.deepEqual(Array.from(out.data.subarray((ey * 512 + ex) * 4, (ey * 512 + ex) * 4 + 4)), [255, 255, 255, 255]);

  const { json: anchor } = await call('set_anchor', { project: 'face', asset: 'happy' });
  assert.ok(anchor.file.endsWith(path.join('raw', 'happy.png')));
  const { json: built } = await call('build_prompt', { project: 'face', task: 'grid', rows: 2, cols: 2, items: ['sad', 'angry', 'laughing', 'sleepy'] });
  assert.equal(built.attach[0].file, anchor.file);
  assert.ok(!built.prompt_one_line.includes('\n'));

  const { r: bad } = await call('project_get', { project: 'nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not found/);
});
