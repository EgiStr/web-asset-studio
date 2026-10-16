// Composes ChatGPT image prompts from the project's style bible so every generation repeats the
// same locked description; only the per-image variation changes.
import { anchorFile, abs } from './workspace.mjs';

const BACKGROUNDS = {
  'key-green': 'Background: one flat, solid pure green (#00FF00) fill covering the whole canvas. No gradient, no floor, no shadow, no scenery, no checkerboard. Do not use that green anywhere on the subject.',
  'key-magenta': 'Background: one flat, solid pure magenta (#FF00FF) fill covering the whole canvas. No gradient, no floor, no shadow, no scenery, no checkerboard. Do not use that magenta anywhere on the subject.',
  white: 'Background: one flat, solid pure white (#FFFFFF) fill. No gradient, no floor, no shadow, no scenery, no checkerboard.',
  transparent: 'Background: real transparent PNG background (alpha channel). If transparency is not possible, use one flat solid pure green (#00FF00) fill instead. Never draw a checkerboard pattern.',
};

const DEFAULT_AVOID = ['text', 'letters', 'numbers', 'labels', 'watermark', 'signature', 'frame or border around the image', 'cast shadow on the ground'];

export function buildPrompt(p, { task = 'single', items = [], rows, cols, action, notes, useAnchor = true }) {
  const b = p.bible;
  const lines = [];
  const anchor = useAnchor ? anchorFile(p) : null;
  const refs = p.references.map((r) => ({ file: abs(p.name, r.file), role: r.role, note: r.note }));
  const attach = [...(anchor ? [{ file: anchor, role: 'anchor' }] : []), ...refs.filter((r) => r.file !== anchor)];

  if (task === 'grid' || task === 'animation') {
    if (!rows || !cols) throw new Error(`task "${task}" needs rows and cols`);
    if (items.length !== rows * cols) throw new Error(`items has ${items.length} entries but the grid has ${rows * cols} cells`);
    const shape = cols > rows ? 'wide landscape (3:2)' : rows > cols ? 'tall portrait (2:3)' : 'square (1:1)';
    lines.push(`Create ONE ${shape} image that is a ${rows} x ${cols} grid (${rows} rows, ${cols} columns) of ${rows * cols} separate drawings of the SAME subject.`);
  } else if (task === 'variation') {
    if (items.length !== 1) throw new Error('task "variation" takes exactly one item: the change to make');
    lines.push('Create ONE new image of the exact same subject as the attached anchor image, changing only what is described under CHANGE.');
  } else {
    lines.push(items.length ? `Create ONE image: ${items[0]}.` : 'Create ONE image of the subject described below.');
  }

  lines.push('', `SUBJECT: ${b.subject || '(describe the subject in project_update first)'}`);
  if (b.style) lines.push(`STYLE: ${b.style}`);
  if (p.pixel) {
    lines.push(`PIXEL ART: true pixel art drawn on a ${p.pixel.size}x${p.pixel.size} pixel grid scaled up evenly, crisp square pixels, no anti-aliasing, no blur, no gradients, no dithering, maximum ${p.pixel.colors ?? 16} colors, clean 1-pixel dark outline.`);
  }
  if (b.palette?.length) lines.push(`PALETTE: use only these colors: ${b.palette.join(', ')}.`);

  if (attach.length) {
    lines.push('', 'REFERENCES: ' + attach.map((a, i) => `image ${i + 1} = ${a.role}${a.note ? ` (${a.note})` : ''}`).join('; ') + '.');
    lines.push('CONSISTENCY: Keep identical to the references: face shape and features, hairstyle, skin and hair colors, outfit, proportions, line weight, shading and rendering style. Do not redesign the character.');
  }

  if (task === 'grid' || task === 'animation') {
    lines.push('', 'LAYOUT: The canvas is divided into equal, evenly spaced cells, read left to right, top to bottom. One drawing per cell, centered, at the same scale in every cell, fully inside its cell with an empty margin on all sides. Nothing crosses into a neighboring cell. No grid lines, dividers or borders between cells.');
    if (task === 'animation') {
      lines.push(`ANIMATION: the cells are consecutive frames of one looping animation${action ? `: ${action}` : ''}. Same camera angle, same zoom, same facing direction in every frame; the character stays at the same position with feet on the same baseline; only the motion changes between frames; the last frame leads smoothly back into the first.`);
    }
    lines.push('', 'CELLS:');
    items.forEach((it, i) => lines.push(`${i + 1}. (row ${Math.floor(i / cols) + 1}, column ${(i % cols) + 1}) ${it}`));
  } else if (task === 'variation') {
    lines.push('', `CHANGE: ${items[0]}`, 'Everything else stays exactly as in the anchor image.');
  }

  lines.push('', BACKGROUNDS[b.background] ?? `Background: ${b.background}`);
  if (b.rules?.length) lines.push('RULES: ' + b.rules.join('; ') + '.');
  lines.push('AVOID: ' + [...DEFAULT_AVOID, ...(b.avoid ?? [])].join(', ') + '.');
  if (notes) lines.push('', notes);
  lines.push('', 'Generate the image now without asking follow-up questions.');

  const prompt = lines.join('\n');
  // Typing "\n" into the ChatGPT composer presses Enter and sends early, so browsers type this one.
  const promptOneLine = lines.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return { prompt, prompt_one_line: promptOneLine, attach };
}
