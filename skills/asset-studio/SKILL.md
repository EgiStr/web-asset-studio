---
name: asset-studio
description: Generate consistent, high-quality image asset sets (face-to-sticker packs, many expressions of one character, pixel-art sprites and animation frames, game sprite sheets, pixel web/UI icons, short videos) by driving the ChatGPT web app (chatgpt.com) in the user's logged-in Chrome through a browser MCP (Claude in Chrome or Agent360 browser-mcp), then saving, cleaning, slicing and packing the results with the web-asset-studio MCP tools. Use when the user wants images or videos made with their ChatGPT account instead of the paid OpenAI API, or says things like "buat stiker dari muka saya", "bikin banyak ekspresi", "sprite sheet", "aset pixel", "animasi game", "pakai chatgpt.com untuk generate gambar".
---

# Asset Studio: consistent asset sets from chatgpt.com

Two halves work together:

- **A browser MCP** drives chatgpt.com in the user's own signed-in Chrome: Claude in Chrome (`mcp__claude-in-chrome__*`) or Agent360 Browser MCP (`browser_*`). Use whichever is connected; the action mapping is in [references/chatgpt-web.md](references/chatgpt-web.md).
- **The web-asset-studio MCP** does everything deterministic: project folders, the style bible, prompt composition, saving downloads, background removal, pixel-art cleanup, sticker outlines, grid slicing, sprite sheets.

You (the agent) do the creative half: look at reference photos, write the exhaustive subject description, judge every result, and decide what to regenerate.

## Rules that are not optional

1. **The user's account, the user's pace.** One generation at a time, wait for it to finish, no parallel tabs hammering ChatGPT. If ChatGPT shows a usage/rate limit, stop the batch and tell the user when it resets. Never try to get around limits.
2. **Login, CAPTCHA, Cloudflare checks, "verify you are human": stop and hand over to the user.** Never solve or bypass them. With browser-mcp use `browser_ask_user`; with Claude in Chrome tell the user in chat and wait.
3. **Confirm before the first download of a batch**: say how many images will be downloaded from chatgpt.com into the Downloads folder and moved into the project. Chrome may ask "Download multiple files?": the user clicks Allow, not you.
4. **Their face goes to OpenAI.** Before uploading a personal photo, say once that it will be sent to ChatGPT, and proceed only if they agree.
5. **Look at every result before keeping it.** `ingest`, `slice_grid` and `process` return a preview image. Check it against the QA list below. Reject drifting results; do not ship them.
6. **Never type a multi-line prompt.** A newline in the composer sends the message early. Always use `prompt_one_line` from `build_prompt`.

## Workflow

### 0. Setup (once per session)
- Call `studio_info`. Show the user `root` (where assets go) and `downloads_dir`. If `downloads_dir_exists` is false, or Chrome saves elsewhere, ask the user to set `ASSET_STUDIO_DOWNLOADS`.
- Confirm a browser MCP is connected: Claude in Chrome `tabs_context_mcp`, or browser-mcp `browser_list_tabs`.

### 1. Plan the set with the user
Agree on what kind of asset (sticker / sprite / icons / UI / video), how many, the style, final sizes, and whether it is pixel art (and the true grid, e.g. 32 or 64 px). Propose a concrete list, e.g. "12 expressions: happy, sad, angry, laughing, crying, love, shocked, thinking, sleepy, cool, wink, thumbs-up". Pick a recipe from [references/recipes.md](references/recipes.md).

### 2. Write the style bible
- Copy reference photos in with `add_reference` (role `face`, `style`, ...). Use the returned absolute paths for uploading.
- Look at the reference images yourself and write `bible.subject` exhaustively: face shape, eye shape and color, eyebrows, nose, mouth, skin tone, hair (style, length, part, color), glasses, facial hair, outfit, accessories, body proportions. This text is repeated in every prompt, so it is the main consistency lever. Be specific ("short black hair with a side part to the left, thick straight eyebrows, round black glasses"), not generic ("a young man").
- `bible.style`: medium, line weight, shading, proportions ("chibi, head 1/2 of body height, thick 6px dark-brown outlines, flat cel shading with one shadow tone").
- `bible.background`: keep `key-green` unless the subject is green (then `key-magenta`).
- `project_create` with it; `pixel: {size, colors}` for pixel art.

### 3. Lock the character (anchor)
- `build_prompt` with `task: "single"`, e.g. items `["front view, neutral friendly smile, full body"]`.
- Generate it in ChatGPT (step 5). Iterate in the same chat until the user approves the design.
- `set_anchor` on the approved asset. From now on `build_prompt` lists the anchor first in `attach`; always upload everything in `attach`.

### 4. Produce the set in grids
- Put several variations in ONE image: `task: "grid"` (expressions, icons) or `task: "animation"` (frames of one motion). Same image = same model pass = much better consistency than separate prompts.
- Sizes that work: 2x2 or 3x3 for stickers and detailed art; up to 4x4 for small pixel sprites and icons. More cells means less detail per cell.
- Stay in the same ChatGPT conversation for the whole set (save `chat_url`), and still attach the anchor every time.

### 5. Generate one image in chatgpt.com
Follow [references/chatgpt-web.md](references/chatgpt-web.md): open/continue the chat, attach the `attach` files, type `prompt_one_line`, send, wait for the image to finish, download it with a known file name, then `ingest` with `source.download.name_contains`, the prompt and the `chat_url`.

### 6. QA every result (from the preview)
- Same character as the anchor: face, hair, colors, outfit, proportions.
- Grid: exactly rows x cols drawings, each fully inside its cell with margin, nothing overlapping a neighbor, no grid lines; cell order matches the item list.
- Background: one flat key color, no checkerboard, no floor shadow, no scenery.
- No text, letters, watermark, extra limbs, merged fingers, cropped heads.
- Pixel art: chunky even pixels, limited colors.

If something fails, regenerate in the same chat with a short, specific correction ("Same sheet, but cell 3 crosses into cell 4: more empty margin around every drawing, keep everything else identical"). Ingest the retry under the SAME name with `overwrite: true`, and if it was already sliced, re-run `slice_grid` with the same `names` and `overwrite: true` (otherwise you get stale `-2` copies), then re-run `process` on those cells. After 3 failed tries of the same thing, show the user and ask.

### 7. Slice, clean and pack
- `slice_grid` with one `names` entry per cell (row by row; `""` skips a bad cell).
- `process` all cells of a set in ONE call with the SAME steps so they come out uniform (recipes list the steps). It always starts from raw, so tune `tolerance` and re-run freely.
- Animation frames: never `trim` frames one by one (it breaks alignment); see the sprite recipe.
- Pixel sets: first frame `pixelate` with `save_palette: true`, every other frame `palette: "project"`.
- `build_spritesheet` for animations or atlases; it writes PNG + JSON + GIF preview.

### 8. Report
`project_get`, then tell the user what was made with absolute paths: `processed/` (final PNGs), `sheets/` (sheet PNG/JSON/GIF), `raw/` (originals), `project.json` (prompts and chat links for every asset).

## Folder layout (inside `root`)

```
<project>/
  project.json   bible, palette, anchor, every asset with its prompt + chat URL
  refs/          reference photos and style samples
  raw/           ChatGPT downloads, untouched
  frames/        cells cut from grid sheets or video frames
  processed/     final PNGs (transparent, trimmed, sized)
  sheets/        sprite sheets: .png + .json atlas + .gif preview
  video/         downloaded videos
```
