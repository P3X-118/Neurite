// fsn DOCUMENT WINDOWS — the floating reader (user-directed 2026-08-16):
// "I prefer the original fsn windows you had for documents VS the neurite
// layout... It also has zoom ux that is broken... We'd prefer the tethers to be
// more fluid. Keep our slight motion but tethered to the towers we've opened...
// this does need to double as a reading tool."
//
// A file opens as a FLOATING fsn reader window: the standalone reader's chrome
// + content pipeline (native PDF/image via iframe src, text rendered, binary
// detected), FIXED pixel scale (never coupled to Graph.zoom — that was the
// broken zoom UX of the Neurite nodes), a slight ambient float, and a FLUID
// curved tether to its file box on the tower. ⤢ maximizes into a full reading
// view (FLIP-animated); windows are draggable and z-stack on focus.
import { animate } from './motion.mjs';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let seq = 0;
let zTop = 40;
/** id -> { el, body, anchor:{x,y,z}, name, source, path, phase, dragging, maximized, home:{x,y} } */
export const docWindows = new Map();

const NATIVE = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.webm', '.mp3'];
const nativeView = (name) => { const l = name.toLowerCase(); return NATIVE.some((e) => l.endsWith(e)); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The reader-style document shell for plain text (monospace, selectable — a reading tool). */
const textDoc = (name, text) =>
  `<!doctype html><body style="margin:0;padding:18px 22px;background:#04100f;color:#b8efe2;` +
  `font:13px/1.55 'Courier New',monospace;white-space:pre-wrap;word-break:break-word;` +
  `-webkit-user-select:text;user-select:text"><div style="color:#5fe6d0;border-bottom:1px solid #0a5548;` +
  `padding-bottom:8px;margin-bottom:14px">▤ ${esc(name)}</div>${esc(text)}</body>`;

export function openDocWindow(f) {
  const id = 'docwin-' + ++seq;
  const el = document.createElement('section');
  el.className = 'fsn-docwin';
  el.id = id;
  el.innerHTML =
    `<div class="dw-bar">` +
    `<span class="dw-title">▤ ${esc(f.name)}</span>` +
    `<span class="dw-path">${esc(f.source)} : ${esc(f.path)}</span>` +
    `<button class="dw-max" title="maximize / restore (ctrl+m)" type="button">⤢</button>` +
    `<button class="dw-close" title="close" type="button">✕</button>` +
    `</div>` +
    `<iframe class="dw-frame" sandbox="allow-same-origin"></iframe>`;
  document.body.appendChild(el);

  // spawn beside the file's projected position, clamped on-screen
  const fsn = globalThis.fsnHandle && globalThis.fsnHandle();
  const c = document.getElementById('fsn-canvas');
  const rx = c && c.width ? c.clientWidth / c.width : 1, ry = c && c.height ? c.clientHeight / c.height : 1;
  let sx = innerWidth * 0.55, sy = innerHeight * 0.3;
  if (fsn && fsn.project) {
    const p = fsn.project(f.x, f.y, f.z);
    if (p) { sx = p[0] * rx + 90; sy = p[1] * ry - 120; }
  }
  const W = 440, H = 360;
  sx = Math.max(258, Math.min(innerWidth - W - 12, sx));
  sy = Math.max(10, Math.min(innerHeight - H - 12, sy));
  el.style.left = sx + 'px';
  el.style.top = sy + 'px';
  el.style.zIndex = ++zTop;

  const win = {
    el, body: el.querySelector('.dw-frame'),
    anchor: { x: f.x, y: f.y, z: f.z },
    name: f.name, source: f.source, path: f.path,
    phase: Math.random() * Math.PI * 2,
    dragging: false, maximized: false,
    home: { x: sx, y: sy },
  };
  docWindows.set(id, win);
  loadContent(win);

  // entrance (the reader's own motion language)
  if (!reduced) animate(el, { opacity: [0, 1], scale: [0.94, 1], y: [12, 0] }, { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] });

  // focus-to-front
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++zTop; });
  // drag by the bar (buttons excluded)
  const bar = el.querySelector('.dw-bar');
  let dx = 0, dy = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || win.maximized) return;
    win.dragging = true;
    dx = e.clientX - el.offsetLeft; dy = e.clientY - el.offsetTop;
    bar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!win.dragging) return;
    win.home = { x: e.clientX - dx, y: e.clientY - dy };
    el.style.left = win.home.x + 'px';
    el.style.top = win.home.y + 'px';
  });
  bar.addEventListener('pointerup', () => { win.dragging = false; });
  el.querySelector('.dw-close').addEventListener('click', () => closeDocWindow(id));
  el.querySelector('.dw-max').addEventListener('click', () => toggleMaximize(win));
  el.addEventListener('dblclick', (e) => { if (e.target.closest('.dw-bar')) toggleMaximize(win); });
  return win;
}

async function loadContent(win) {
  const fsn = globalThis.fsnHandle && globalThis.fsnHandle();
  const url = fsn && fsn.raw_url ? fsn.raw_url(win.source, win.path) : '';
  if (!url) { win.body.srcdoc = textDoc(win.name, '(this file’s source isn’t reachable right now)'); return; }
  if (nativeView(win.name)) { win.body.src = url; return; } // browser-native: PDF viewer, images, media
  try {
    const r = await fetch(url);
    const text = await r.text();
    // lossy-decoded binary is U+FFFD soup — offer the raw file instead
    const junk = [...text.slice(0, 4000)].filter((ch) => ch === '�').length;
    if (junk > 12) {
      win.body.srcdoc = textDoc(win.name, '') .replace('</body>',
        `<div>▤ binary format — <a style="color:#7fffe0" href="${esc(url)}" target="_blank" rel="noopener">open the raw file ⇗</a></div></body>`);
      return;
    }
    win.body.srcdoc = textDoc(win.name, text);
  } catch (e) {
    win.body.srcdoc = textDoc(win.name, '(failed to load: ' + e.message + ')');
  }
}

export function closeDocWindow(id) {
  const win = docWindows.get(id);
  if (!win) return;
  docWindows.delete(id);
  if (reduced) { win.el.remove(); return; }
  animate(win.el, { opacity: [1, 0], scale: [1, 0.95] }, { duration: 0.16 }).finished
    .then(() => win.el.remove()).catch(() => win.el.remove());
}

/** FLIP maximize/restore — the full-tab READING view. */
export function toggleMaximize(win) {
  const el = win.el;
  const before = el.getBoundingClientRect();
  win.maximized = !win.maximized;
  el.classList.toggle('maximized', win.maximized);
  if (!win.maximized) { el.style.left = win.home.x + 'px'; el.style.top = win.home.y + 'px'; }
  if (reduced) return;
  const after = el.getBoundingClientRect();
  if (!after.width || !after.height) return;
  el.style.transformOrigin = 'top left';
  animate(el, {
    x: [before.left - after.left, 0], y: [before.top - after.top, 0],
    scaleX: [before.width / after.width, 1], scaleY: [before.height / after.height, 1],
  }, { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] });
}

/** Topmost open window (Ctrl+M target). */
export function topDocWindow() {
  let top = null, z = -1;
  for (const w of docWindows.values()) {
    const wz = +w.el.style.zIndex || 0;
    if (wz > z) { z = wz; top = w; }
  }
  return top;
}

/** Per-frame: ambient float (slight, per-window phase) — paused while dragging,
 * maximized, or reduced-motion. Returns screen anchor points for the tethers. */
export function stepDocWindows(now) {
  for (const w of docWindows.values()) {
    if (w.dragging || w.maximized) { w.el.style.transform = ''; continue; }
    if (reduced) continue;
    const t = now / 1000;
    const fx = Math.sin(t * 0.5 + w.phase) * 3.5;
    const fy = Math.cos(t * 0.37 + w.phase * 1.7) * 2.5;
    w.el.style.transform = `translate(${fx.toFixed(2)}px, ${fy.toFixed(2)}px)`;
  }
}
