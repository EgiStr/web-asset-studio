# Driving chatgpt.com with a browser MCP

ChatGPT's page changes often. Nothing here is a guaranteed selector: **discover elements on the live page first** (`find` / `read_page` / screenshot), and use the hints below only as a starting point. If a hint does not match, look again instead of guessing.

## Action mapping

| Action | Claude in Chrome (`mcp__claude-in-chrome__*`) | Agent360 Browser MCP |
|---|---|---|
| Open a working tab | `tabs_context_mcp`, then `tabs_create_mcp` + `navigate` | `browser_navigate` `{url, new_tab: true}` |
| Current URL / tabs | `tabs_context_mcp` | `browser_list_tabs` |
| Find an element | `find` `{query}` or `read_page` (gives `ref_N`) | `browser_get_page_content`, `browser_screenshot` |
| Click | `computer` `left_click` with `ref` | `browser_click` `{selector}` |
| Type text | click the composer, then `computer` `type` | `browser_fill` `{selector, value}`; fallback script below |
| Attach files | `file_upload` `{ref of input[type=file], paths, tabId}` (max 10 MB per call) | `browser_upload_file` `{selector, files}` |
| Run JavaScript | `javascript_tool` | `browser_execute_script` `{code}` |
| Wait | `computer` `wait` (max 10 s per call) | `browser_wait` `{selector, timeout}` |
| Look at the page | `computer` `screenshot` | `browser_screenshot` |
| Hand over to the user | say it in chat and wait for their reply | `browser_ask_user` `{message}` |

Browser MCP upload notes: the extension needs **"Allow access to file URLs"** turned on (chrome://extensions, Agent360 Browser MCP, Details), and files must be inside the folder browser-mcp was started from. The asset root defaults to `<that folder>/asset-studio`, so paths from `add_reference` / `build_prompt` already qualify. If an upload is refused, tell the user which of the two it is.

Claude in Chrome: do not click file inputs or upload buttons (that opens a native dialog you cannot see); pass the input's `ref` to `file_upload`.

## One generation, step by step

1. **Open the chat.** First image of a set: open `https://chatgpt.com/` in a new tab. Later images: navigate to the saved `chat_url` so ChatGPT keeps the context. Never take over a tab the user is using.
2. **Check the state** with a screenshot. Signed-in = a message composer and no "Log in" / "Sign up" button. A login page, CAPTCHA, "verify you are human", or an error page means stop and hand over to the user.
3. **Count existing generated images** with the status script below (`images`), so you can tell when a new one arrives.
4. **Attach files** from `build_prompt`'s `attach`, in order (anchor first). The page has several hidden `input[type="file"]` elements (seen October 2026: one `accept="image/*"` single, one `accept="image/*"` multiple, one `image/*,video/*` multiple, one with no accept). Use an image input that allows `multiple` when attaching more than one file. Wait until the thumbnails finish uploading (no spinner) before sending.
5. **Type `prompt_one_line`** into the composer. Hint (seen October 2026): a ProseMirror `div[contenteditable="true"]` with `aria-label="Ask ChatGPT"` inside the composer form, next to a button labelled "Add files and more". Older builds used `#prompt-textarea`. Never type the multi-line `prompt`.
6. **Send** with the send button, which only appears once the composer has text (hint: `[data-testid="send-button"]`), or by pressing Enter once.
7. **Wait.** Image generation takes about 30 s to 2 min. Poll the status script about every 10-15 s, not faster. Done when `generating` is false and `images` went up. Then take one screenshot to confirm the image is sharp (ChatGPT shows blurry partial previews while it works).
   - If ChatGPT answers with a question instead of an image, reply once in one line: "Generate the image now using your best judgment, no questions."
   - If it shows a limit, policy refusal, or error: stop and report the exact message to the user.
8. **Download it** with the download script below (file name `aas_<project>_<asset>.png`). Fallback: hover the image and click ChatGPT's own download button, then ingest with `name_contains: "ChatGPT Image"` (or no `name_contains`, which takes the newest file from the last 3 minutes).
9. **Record the chat URL** (`tabs_context_mcp` / `browser_list_tabs`) and call `ingest`:
   `{project, name, source: {download: {name_contains: "aas_<project>_<asset>"}}, prompt: <prompt_one_line>, chat_url}`.
10. **QA the preview** that `ingest` returns (checklist in SKILL.md) before moving on.

## Scripts

Run them with `javascript_tool` / `browser_execute_script`. They only read the page and save the image the user just generated.

### Status

```js
(() => {
  const gen = [...document.querySelectorAll('main img')].filter(
    (i) => i.naturalWidth >= 256 && !i.closest('[data-message-author-role="user"]'));
  const last = gen.at(-1);
  return JSON.stringify({
    generating: !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"]'),
    images: new Set(gen.map((i) => i.currentSrc || i.src)).size,
    last: last ? { w: last.naturalWidth, h: last.naturalHeight, alt: last.alt, src: (last.currentSrc || last.src).slice(0, 90) } : null,
    url: location.href,
  });
})()
```

### Download the newest generated image

Replace `FILE_NAME`. The script stores its result in `window.__aas`; if the tool returns before the promise settles, run `window.__aas` in a second call to read it.

```js
(async () => {
  const FILE_NAME = 'aas_PROJECT_ASSET.png';
  window.__aas = 'pending';
  try {
    const gen = [...document.querySelectorAll('main img')].filter(
      (i) => i.naturalWidth >= 256 && !i.closest('[data-message-author-role="user"]'));
    const el = gen.at(-1);
    if (!el) return (window.__aas = 'error: no generated image found');
    const res = await fetch(el.currentSrc || el.src, { credentials: 'include' });
    if (!res.ok) return (window.__aas = 'error: HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = FILE_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return (window.__aas = `ok ${el.naturalWidth}x${el.naturalHeight} ${blob.type} ${blob.size} bytes`);
  } catch (e) {
    return (window.__aas = 'error: ' + e.message);
  }
})()
```

- `blob.type` should be `image/png`. If it is `image/webp`, the processing tools cannot read it: use ChatGPT's own download button instead (it saves PNG).
- If the result is an error, or no file arrives (`ingest` times out), use the download-button fallback.
- If Chrome asks where to save each file, ask the user to turn off "Ask where to save each file before downloading" in Chrome's download settings, or to save into the watched folder.

### Typing fallback (browser-mcp, if `browser_fill` leaves the composer empty)

```js
(() => {
  const el = document.querySelector('[contenteditable="true"][aria-label*="ChatGPT"], #prompt-textarea, [contenteditable="true"]');
  if (!el) return 'error: composer not found';
  el.focus();
  document.execCommand('insertText', false, PROMPT_ONE_LINE_AS_JSON_STRING);
  return 'ok ' + el.innerText.length + ' chars';
})()
```

Insert the prompt as a JSON-escaped string literal (`JSON.stringify(prompt_one_line)`).

## Video (Sora)

Video generation depends on the user's ChatGPT plan and lives in Sora (`https://sora.chatgpt.com/`) or in ChatGPT itself, depending on the account; its UI differs from the image flow. Discover the page the same way, generate one clip at a time, download the MP4 with the site's own download button, then:

- `ingest` (it lands in `video/`), and
- `video_to_frames` (needs ffmpeg: `winget install Gyan.FFmpeg`, or set `ASSET_STUDIO_FFMPEG`) to turn it into frames for `process` / `build_spritesheet`.

For game animation, frame grids from the image flow are usually cleaner than frames cut from a video: video frames carry motion blur and background.
