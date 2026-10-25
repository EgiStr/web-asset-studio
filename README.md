# Web Asset Studio

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-green.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)

**Generate consistent sticker packs, pixel-art sprites, animation sheets and web icons with your own ChatGPT web account, then cut, clean and pack them automatically.**
An MCP server plus an agent skill. No OpenAI API key, no paid image API.

▶ **[Watch the 24-second promo](docs/promo.mp4)** · [Bahasa Indonesia](README.id.md)

## Why

The OpenAI image API is paid per image. Students and hobbyists often already have a ChatGPT account and can generate images in the web app, but one prompt gives one image with one expression, and a second prompt drifts: different face, different style, a fake "transparent" checkerboard background, pixel art that is not on a grid.

Web Asset Studio fixes the part around the generation:

| Problem | What this does |
|---|---|
| Characters drift between prompts | One reusable **style bible** is repeated in every prompt, an approved **anchor** image is attached every time, and many variations are generated inside **one grid image** |
| Backgrounds are fake or noisy | Flood-fill background removal from the edges (keeps the white of the eyes), detects fake checkerboards, and never eats a subject cropped at the frame edge |
| "Pixel art" is not pixel art | Area-downscale to the true grid, hard alpha, a limited palette that can be **shared across a whole set** |
| Files end up everywhere | A project folder with raw, frames, processed, sheets and a `project.json` that records every prompt and chat link |
| Game engines need sheets | Uniform-cell sprite sheet PNG, a JSON atlas, and a GIF preview |

## How it works

Two halves, plus a skill that tells the agent how to use them:

```
photo ──► add_reference ──► project_create (style bible) ──► build_prompt
                                                               │
        browser MCP drives chatgpt.com in your logged-in Chrome ◄┘
        (attach files, type prompt, wait, download)
                                                               │
 ingest ──► agent checks the preview ──► slice_grid ──► process ──► build_spritesheet
                                                       │
                              raw/  frames/  processed/  sheets/   project.json
```

- **Browser MCP** ([Claude in Chrome](https://claude.com/chrome) or [`@agent360/browser-mcp`](https://www.npmjs.com/package/@agent360/browser-mcp)) operates chatgpt.com in the Chrome profile where you are already signed in.
- **`web-asset-studio` MCP server** (this repo) does everything deterministic: folders, manifest, prompt composition, ingesting downloads, background removal, pixelation, outlines, slicing, packing. Pure JavaScript, no native dependencies, bundled to one file.
- **`asset-studio` skill** is the procedure for the agent: lock the character, generate in grids, QA every result, regenerate what drifts. Clients without skills can read the same text from the MCP prompt `asset_studio_workflow`.

## Read this first

- **Terms of use.** OpenAI's terms restrict automatic extraction of output from the service. Automating chatgpt.com with your account is a gray area and the risk (rate limits, account restrictions) is yours. The workflow is deliberately slow: one image at a time, it stops at usage limits, and it never works around login or CAPTCHA (it hands those to you).
- **Limits.** Free accounts have a small daily image quota; a 3x3 grid gives nine assets for one image.
- **Privacy.** Any photo you attach is uploaded to ChatGPT. The agent is instructed to ask you first.
- **ChatGPT's UI changes.** The selectors in [`skills/asset-studio/references/chatgpt-web.md`](skills/asset-studio/references/chatgpt-web.md) are hints; the agent is told to discover elements on the live page. That page was verified against a real account in October 2026, but expect drift.
- **Video (Sora)** is only partly covered: ingest and `video_to_frames` (needs ffmpeg) exist, the browser flow is untested.

## Install

Requirements: Node.js 18.17+, Chrome signed in to chatgpt.com, and one browser MCP.

### 1. A browser MCP (pick one)

- **Claude in Chrome:** install the extension and connect it to Claude.
- **Agent360 Browser MCP:**
  ```bash
  claude mcp add --scope user browser-mcp -- npx @agent360/browser-mcp@latest
  ```
  then install its Chrome extension. To upload reference photos, enable **Allow access to file URLs** for the extension in `chrome://extensions`.

### 2a. Claude Code (plugin: server + skill)

```bash
claude plugin marketplace add EgiStr/web-asset-studio
```
```bash
claude plugin install web-asset-studio@web-asset-studio
```

Restart Claude Code. The server is prebuilt in `dist/server.mjs`, so there is nothing to compile.

### 2b. Any other MCP client (Claude Desktop, Cursor, VS Code, Codex, Windsurf)

```json
{
  "mcpServers": {
    "web-asset-studio": {
      "command": "node",
      "args": ["/path/to/web-asset-studio/dist/server.mjs"],
      "env": { "ASSET_STUDIO_ROOT": "/path/to/your/project/asset-studio" }
    }
  }
}
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ASSET_STUDIO_ROOT` | `<project dir>/asset-studio` | Where projects are stored |
| `ASSET_STUDIO_DOWNLOADS` | OS Downloads folder (on Windows, read from the registry, so a relocated Downloads folder works) | Folder Chrome saves to, watched by `ingest` |
| `ASSET_STUDIO_FFMPEG` | `ffmpeg` on PATH | Used by `video_to_frames` |

In Chrome, turn off **Ask where to save each file before downloading** and allow multiple downloads when asked.

## Use it

Tell your agent, for example:

> Use asset-studio. Here is my photo `~/photos/me.jpg`. Make 18 chibi sticker expressions with transparent backgrounds, a white outline, 512 px.

> Make a 48 px pixel-art character from this photo, then a 4-frame idle and an 8-frame walk cycle facing right, packed as a sprite sheet for Phaser.

> Make 16 pixel icons, 32 px, for a farming web game: coin, seed bag, watering can, hoe, and so on, all sharing one palette.

Output lives in `asset-studio/<project>/`:

```
project.json   style bible, palette, anchor, every asset with its prompt and chat URL
refs/          reference photos
raw/           ChatGPT downloads, untouched
frames/        cells cut from grid sheets or video
processed/     final transparent PNGs, uniform size
sheets/        sprite sheet .png + atlas .json + preview .gif
video/         downloaded videos
```

## MCP tools

| Tool | What it does |
|---|---|
| `studio_info` | Asset root, watched Downloads folder, ffmpeg, existing projects |
| `project_create`, `project_get`, `project_update` | Project and style bible (subject, style, palette, background, rules), pixel settings, locked palette |
| `add_reference` | Copy a photo or style sample into `refs/` |
| `set_anchor` | Mark an approved asset that every later generation must attach |
| `build_prompt` | Compose a `single`, `grid`, `animation` or `variation` prompt and list the files to attach; returns a `prompt_one_line` so Enter does not send early |
| `ingest` | Save a finished browser download (moved out of Downloads), a URL, or a local path; returns a preview |
| `slice_grid` | Cut a grid image into named cells (`overwrite` replaces cells after a regenerate) |
| `process` | Ordered steps on the raw files: `remove_bg`, `trim` (`group` keeps animation frames aligned), `crop`, `resize`, `fit`, `scale`, `pixelate`, `outline` |
| `build_spritesheet` | Uniform-cell sheet PNG + JSON atlas (TexturePacker hash, works in Phaser/Pixi; `frameWidth`/`frameHeight` for Godot/Unity) + GIF |
| `video_to_frames` | Extract PNG frames from an ingested video (needs ffmpeg) |

Recipes for stickers, pixel stickers, sprite animation, emotes, web icons, phone wallpapers and fixes for common problems are in [`skills/asset-studio/references/recipes.md`](skills/asset-studio/references/recipes.md).

## Development

```bash
npm install
npm test      # builds dist/server.mjs first, then runs 18 tests
npm run build
```

The tests cover image processing on synthetic images (fake checkerboard, off-grid pixel art, a subject cropped at the edge, aligned animation frames), the full pipeline from a fake Downloads folder, and the bundled server started without `node_modules` through a real MCP client. `dist/server.mjs` is committed because the plugin runs it directly: rebuild and commit it after changing `src/`.

```
src/        image.mjs (pixels), workspace.mjs (projects), prompts.mjs, server.mjs (MCP)
skills/     the asset-studio skill and its references
test/       node:test suites
docs/       promo.mp4
```

Contributions are welcome, especially: updates to the ChatGPT page hints when the UI changes, an objects-only mode for `build_prompt` (it currently always injects the character bible), and a tested Sora/video flow.

## License

[MIT](LICENSE)
