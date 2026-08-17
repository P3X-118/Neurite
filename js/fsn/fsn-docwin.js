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

/** Run an animation, then ALWAYS call done exactly once — resolved promise,
 * thenable controls, throw, or none of the above (timeout fallback). */
function animateThen(el, keyframes, opts, done) {
  let called = false;
  const once = () => { if (!called) { called = true; done(); } };
  try {
    const ctl = animate(el, keyframes, opts);
    const p = ctl && (ctl.finished || ctl);
    if (p && typeof p.then === 'function') p.then(once, once);
  } catch (e) { once(); return; }
  setTimeout(once, ((opts && opts.duration) || 0.3) * 1000 + 80);
}
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
  `font:13px/1.55 'Courier New',monospace;-webkit-user-select:text;user-select:text">` +
  `<div style="max-width:78ch;margin:0 auto">` + // reading measure — long docs stay readable maximized
  `<div style="color:#5fe6d0;border-bottom:1px solid #0a5548;padding-bottom:8px;margin-bottom:14px">▤ ${esc(name)}</div>` +
  `<div style="white-space:pre-wrap;word-break:break-word">${esc(text)}</div></div></body>`;

export function openDocWindow(f) {
  const id = 'docwin-' + ++seq;
  const el = document.createElement('section');
  el.className = 'fsn-docwin';
  el.id = id;
  el.innerHTML =
    `<div class="dw-bar">` +
    `<span class="dw-title">▤ ${esc(f.name)}</span>` +
    `<span class="dw-path">${esc(f.source)} : ${esc(f.path)}</span>` +
    `<button class="dw-fz" data-d="-1" title="smaller text" type="button">A−</button>` +
    `<button class="dw-fz" data-d="1" title="larger text" type="button">A+</button>` +
    `<button class="dw-ret" title="retract — dock beside its tower, still in view" type="button">⇱</button>` +
    `<button class="dw-min" title="minimize — pull back to its tower" type="button">−</button>` +
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
  // Readable-by-default: room for the 78ch measure, clamped beside the panel.
  // Inline size on DESKTOP only — the phone sheet + maximized sizes are CSS
  // (media/class) rules that inline styles would override.
  const mobileSheet = matchMedia('(max-width: 700px)').matches;
  const W = mobileSheet ? 440 : Math.max(440, Math.min(700, innerWidth - 300));
  const H = mobileSheet ? 360 : Math.max(360, Math.min(620, Math.round(innerHeight * 0.74)));
  sx = Math.max(258, Math.min(innerWidth - W - 12, sx));
  sy = Math.max(40, Math.min(Math.max(44, innerHeight - H - 12), sy));
  el.style.left = sx + 'px';
  el.style.top = sy + 'px';
  el.style.zIndex = ++zTop;
  if (!mobileSheet) { el.style.width = W + 'px'; el.style.height = H + 'px'; }

  const win = {
    el, body: el.querySelector('.dw-frame'),
    anchor: { x: f.x, y: f.y, z: f.z },
    name: f.name, source: f.source, path: f.path,
    phase: Math.random() * Math.PI * 2,
    dragging: false, maximized: false,
    home: { x: sx, y: sy },
    fontPx: 13, native: nativeView(f.name),
    minimized: false, chip: null, retracted: false,
    size: { w: W, h: H },
  };
  if (win.native) el.querySelectorAll('.dw-fz').forEach((b) => (b.style.display = 'none'));
  docWindows.set(id, win);
  loadContent(win);
  markRow(win, true); // tree shows what's open

  // Phones: a 440px floating window can't float on a 375px viewport — open as a
  // full reading sheet (standalone mobile-reader parity). − still docks it to
  // the tower; ⤢ toggles back to the sheet.
  if (matchMedia('(max-width: 700px)').matches) {
    win.maximized = true;
    el.classList.add('maximized');
  }

  // entrance (the reader's own motion language)
  if (!reduced) animate(el, { opacity: [0, 1], scale: [0.94, 1], y: [12, 0] }, { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] });

  // focus-to-front
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++zTop; });
  // drag by the bar (buttons excluded)
  const bar = el.querySelector('.dw-bar');
  let dx = 0, dy = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || win.maximized || win.retracted) return;
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
  el.querySelectorAll('.dw-fz').forEach((b) => b.addEventListener('click', () => {
    win.fontPx = Math.max(10, Math.min(22, win.fontPx + +b.dataset.d));
    try { // srcdoc is same-origin; native views (pdf/img) have no text to size
      const doc = win.body.contentDocument;
      if (doc && doc.body) doc.body.style.fontSize = win.fontPx + 'px';
    } catch (e) { /* cross-origin native view — no-op */ }
  }));
  el.querySelector('.dw-max').addEventListener('click', () => toggleMaximize(win));
  el.querySelector('.dw-min').addEventListener('click', () => minimizeDocWindow(win));
  el.querySelector('.dw-ret').addEventListener('click', () => toggleRetract(win));
  // a retracted card expands on click anywhere (buttons keep their own actions)
  el.addEventListener('click', (e) => {
    if (win.retracted && !e.target.closest('button')) toggleRetract(win);
  });
  el.addEventListener('dblclick', (e) => { if (e.target.closest('.dw-bar')) toggleMaximize(win); });
  return win;
}

async function loadContent(win) {
  const fsn = globalThis.fsnHandle && globalThis.fsnHandle();
  const url = fsn && fsn.raw_url ? fsn.raw_url(win.source, win.path) : '';
  if (!url) { win.body.srcdoc = textDoc(win.name, '(this file’s source isn’t reachable right now)'); return; }
  if (nativeView(win.name)) {
    // A sandboxed iframe DISABLES Chrome's built-in PDF viewer (plugins are off
    // in sandboxes) — PDFs showed nothing (user-reported 2026-08-17). Native
    // views are our own same-origin corpus files: drop the sandbox for them;
    // srcdoc text keeps it. (Sandbox changes only apply on the next load, so
    // remove BEFORE setting src.)
    win.body.removeAttribute('sandbox');
    win.body.src = url;
    return;
  }
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
  markRow(win, false);
  if (win.chip) win.chip.remove();
  if (reduced) { win.el.remove(); return; }
  animateThen(win.el, { opacity: [1, 0], scale: [1, 0.95] }, { duration: 0.16 }, () => win.el.remove());
}

/** FLIP maximize/restore — the full-tab READING view. */
export function toggleMaximize(win) {
  const el = win.el;
  const before = el.getBoundingClientRect();
  win.maximized = !win.maximized;
  el.classList.toggle('maximized', win.maximized);
  if (win.maximized) {
    el.style.width = ''; el.style.height = ''; // the .maximized CSS sizes it
  } else {
    el.style.left = win.home.x + 'px'; el.style.top = win.home.y + 'px';
    if (!matchMedia('(max-width: 700px)').matches && win.size) {
      el.style.width = win.size.w + 'px'; el.style.height = win.size.h + 'px';
    }
  }
  if (reduced) return;
  const after = el.getBoundingClientRect();
  if (!after.width || !after.height) return;
  el.style.transformOrigin = 'top left';
  animate(el, {
    x: [before.left - after.left, 0], y: [before.top - after.top, 0],
    scaleX: [before.width / after.width, 1], scaleY: [before.height / after.height, 1],
  }, { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] });
}

/** Screen position of a window's file-box anchor (CSS px), or null. */
function anchorScreen(win) {
  const fsn = globalThis.fsnHandle && globalThis.fsnHandle();
  if (!fsn || !fsn.project) return null;
  const p = fsn.project(win.anchor.x, win.anchor.y, win.anchor.z);
  if (!p) return null;
  const c = document.getElementById('fsn-canvas');
  const rx = c && c.width ? c.clientWidth / c.width : 1, ry = c && c.height ? c.clientHeight / c.height : 1;
  return { x: p[0] * rx, y: p[1] * ry };
}

/** Mark/unmark the panel row for an open document (tree ↔ view sync). */
function markRow(win, open) {
  for (const row of document.querySelectorAll('#tree-rows .row.file')) {
    if (row.dataset.source === win.source && row.dataset.path === win.path) {
      row.classList.toggle('row-open', open);
      return;
    }
  }
}

function chipsLayer() {
  let el = document.getElementById('fsn-dockchips');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fsn-dockchips';
    document.body.appendChild(el);
  }
  return el;
}

/** Minimize: the window travels back to its file box (the tether visually reels
 * it in — the cable endpoint trails the window), then docks as a chip on the
 * tower. Multiple documents from one folder each dock at their own file box. */
export function minimizeDocWindow(win) {
  if (win.minimized) return;
  if (win.maximized) toggleMaximize(win);
  if (win.retracted) { win.retracted = false; win.el.classList.remove('retracted'); }
  win.minimized = true;
  const a = anchorScreen(win) || { x: innerWidth / 2, y: innerHeight * 0.7 };
  const r = win.el.getBoundingClientRect();
  const settle = () => {
    win.el.style.display = 'none';
    win.el.style.transform = '';
    win.el.style.opacity = '';
    if (!win.chip) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'fsn-dockchip';
      chip.textContent = '▤ ' + win.name;
      chip.title = 'restore ' + win.name;
      chip.addEventListener('click', () => restoreDocWindow(win));
      chipsLayer().appendChild(chip);
      win.chip = chip;
    }
    win.chip.style.display = '';
    if (!reduced) animate(win.chip, { opacity: [0, 1], scale: [0.6, 1] }, { duration: 0.18 });
  };
  if (reduced) { settle(); return; }
  win.el.style.transformOrigin = 'top left';
  animateThen(win.el, {
    x: [0, a.x - r.x], y: [0, a.y - r.y],
    scaleX: [1, 0.07], scaleY: [1, 0.07],
    opacity: [1, 0.25],
  }, { duration: 0.42, ease: [0.35, 0, 0.25, 1] }, settle);
}

/** Restore: the window flies back out from its tower to where it lived. */
export function restoreDocWindow(win) {
  if (!win.minimized) return;
  win.minimized = false;
  if (win.chip) win.chip.style.display = 'none';
  const el = win.el;
  el.style.display = '';
  el.style.left = win.home.x + 'px';
  el.style.top = win.home.y + 'px';
  el.style.zIndex = ++zTop;
  if (reduced) return;
  const a = anchorScreen(win);
  const r = el.getBoundingClientRect();
  el.style.transformOrigin = 'top left';
  const fx = a ? a.x - r.x : 40, fy = a ? a.y - r.y : 40;
  animate(el, {
    x: [fx, 0], y: [fy, 0],
    scaleX: [0.07, 1], scaleY: [0.07, 1],
    opacity: [0.25, 1],
  }, { duration: 0.42, ease: [0.35, 0, 0.25, 1] });
}

/** RETRACT (user-directed 2026-08-17): the document stays IN VIEW SPACE as a
 * compact card that RIDES its tower — per-frame anchored to the file box's
 * projection (so it is no longer locked to screen space while zooming), with a
 * short tether. Click the card (or ⇱ again) to expand back to the floating
 * reading window at that spot. */
export function toggleRetract(win) {
  if (win.minimized) return;
  if (win.maximized) toggleMaximize(win);
  win.retracted = !win.retracted;
  win.el.classList.toggle('retracted', win.retracted);
  if (!win.retracted) {
    // expand where the card currently sits (clamped) — it stays "in view space"
    const r = win.el.getBoundingClientRect();
    win.home = {
      x: Math.max(6, Math.min(innerWidth - 446, r.x)),
      y: Math.max(40, Math.min(innerHeight - 370, r.y - 60)),
    };
    win.el.style.left = win.home.x + 'px';
    win.el.style.top = win.home.y + 'px';
    win.el.style.zIndex = ++zTop;
    if (!reduced) animate(win.el, { opacity: [0.7, 1], scale: [0.92, 1] }, { duration: 0.22, ease: [0.2, 0.8, 0.2, 1] });
  }
}

/** This window's document state for the mosaic bus (8d chip mirroring). */
export function docsStateJson() {
  const out = [];
  for (const w of docWindows.values()) {
    out.push({ name: w.name, source: w.source, path: w.path,
      a: [w.anchor.x, w.anchor.y, w.anchor.z], min: !!w.minimized });
  }
  return JSON.stringify(out);
}

/** Restore (or focus) MY document by path — the owner side of a cross-window
 * chip click. */
export function restoreByPath(path) {
  for (const w of docWindows.values()) {
    if (w.path !== path) continue;
    if (w.minimized) restoreDocWindow(w);
    else w.el.style.zIndex = ++zTop;
    return true;
  }
  return false;
}

// 8d: PEERS' docked documents render as chips here too — the landscape is
// shared, so a doc minimized to its tower in ANY window shows at that tower in
// EVERY window. Clicking one asks the owner window to restore it.
const remoteDocs = new Map();  // ownerId -> docs[]
const remoteChips = new Map(); // `${owner}::${path}` -> element
export function setRemoteDocs(owner, docs) {
  remoteDocs.set(owner, docs || []);
}
function stepRemoteChips(placed) {
  const live = new Set();
  const peers = globalThis.fsnMosaic ? globalThis.fsnMosaic.state.windows : null;
  const fsn = globalThis.fsnHandle && globalThis.fsnHandle();
  const c = document.getElementById('fsn-canvas');
  const rx = c && c.width ? c.clientWidth / c.width : 1, ry = c && c.height ? c.clientHeight / c.height : 1;
  for (const [owner, docs] of remoteDocs) {
    if (peers && !peers.has(owner)) continue; // owner window is gone
    for (const d of docs) {
      if (!d.min) continue;
      const key = owner + '::' + d.path;
      live.add(key);
      let chip = remoteChips.get(key);
      if (!chip) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'fsn-dockchip remote';
        chip.textContent = '▤ ' + d.name;
        chip.title = 'restore ' + d.name + ' (opens in its own window)';
        chip.addEventListener('click', () => {
          if (globalThis.fsnMosaic) globalThis.fsnMosaic.requestDocRestore(owner, d.path);
        });
        chipsLayer().appendChild(chip);
        remoteChips.set(key, chip);
      }
      let a = null;
      if (fsn && fsn.project) {
        const pr = fsn.project(d.a[0], d.a[1], d.a[2]);
        if (pr) a = { x: pr[0] * rx, y: pr[1] * ry };
      }
      if (!a) { chip.style.display = 'none'; continue; }
      chip.style.display = '';
      const cw = chip.offsetWidth || 120, chh = 26;
      let x = Math.round(a.x - cw / 2), y = Math.round(a.y - 34);
      let bumped = true;
      while (bumped) {
        bumped = false;
        for (const r of placed) {
          if (x < r.x + r.w && x + cw > r.x && y < r.y + chh && y + chh > r.y) { y = r.y + chh + 4; bumped = true; }
        }
      }
      placed.push({ x, y, w: cw });
      chip.style.left = x + 'px';
      chip.style.top = y + 'px';
    }
  }
  for (const [key, chip] of remoteChips) {
    if (!live.has(key)) { chip.remove(); remoteChips.delete(key); }
  }
}

/** Topmost open window (Ctrl+M target). */
export function topDocWindow() {
  let top = null, z = -1;
  for (const w of docWindows.values()) {
    if (w.minimized) continue;
    const wz = +w.el.style.zIndex || 0;
    if (wz > z) { z = wz; top = w; }
  }
  return top;
}

/** Per-frame: ambient float (slight, per-window phase) — paused while dragging,
 * maximized, or reduced-motion. Returns screen anchor points for the tethers. */
export function stepDocWindows(now) {
  globalThis.__fsnDocSteps = (globalThis.__fsnDocSteps || 0) + 1; // liveness (debug)
  // Dock chips: position at each doc's file-box anchor, then CLUSTER — several
  // docs from one folder project nearly on top of each other; overlapping chips
  // stack downward so every one stays readable and clickable.
  const placed = [];
  for (const w of docWindows.values()) {
    if (!w.minimized || !w.chip) continue;
    const a = anchorScreen(w);
    if (!a) { w.chip.style.display = 'none'; continue; }
    w.chip.style.display = '';
    const cw = w.chip.offsetWidth || 120, chh = 26;
    let x = Math.round(a.x - cw / 2), y = Math.round(a.y - 34);
    let bumped = true;
    while (bumped) {
      bumped = false;
      for (const r of placed) {
        if (x < r.x + r.w && x + cw > r.x && y < r.y + chh && y + chh > r.y) {
          y = r.y + chh + 4; // stack below the occupying chip
          bumped = true;
        }
      }
    }
    placed.push({ x, y, w: cw });
    w.chip.style.left = x + 'px';
    w.chip.style.top = y + 'px';
  }
  stepRemoteChips(placed); // 8d: peers' docked docs share the same towers
  for (const w of docWindows.values()) {
    if (w.minimized) {
      continue;
    }
    if (w.retracted) {
      const a = anchorScreen(w);
      if (a) {
        w.el.style.display = '';
        const rw = w.el.offsetWidth || 180;
        w.el.style.left = Math.round(a.x - rw / 2) + 'px';
        w.el.style.top = Math.round(a.y - (w.el.offsetHeight || 34) - 22) + 'px';
      } else {
        w.el.style.display = 'none'; // tower behind the camera
      }
      // fall through: the slight float rides ON TOP of the anchor tracking
    }
    if (w.dragging || w.maximized) { w.el.style.transform = ''; continue; }
    if (reduced) continue;
    const t = now / 1000;
    const fx = Math.sin(t * 0.5 + w.phase) * 3.5;
    const fy = Math.cos(t * 0.37 + w.phase * 1.7) * 2.5;
    w.el.style.transform = `translate(${fx.toFixed(2)}px, ${fy.toFixed(2)}px)`;
  }
}
