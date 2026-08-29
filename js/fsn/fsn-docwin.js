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
// curved tether to its file box on the tower. □ maximizes into a full reading
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
  `<div style="color:#5fe6d0;border-bottom:1px solid #0a5548;padding-bottom:8px;margin-bottom:14px">≡ ${esc(name)}</div>` +
  `<div style="white-space:pre-wrap;word-break:break-word">${esc(text)}</div></div></body>`;

/** PDF rendering via pdf.js (already on the page from Neurite's imports) —
 * the ONLY way PDFs work on phones (mobile Chrome has no inline viewer), and
 * consistent on desktop too. Lazy per-page canvases (IntersectionObserver),
 * fit-width, A−/A+ re-renders at ±scale. Falls back to the native iframe
 * viewer when pdfjsLib is unavailable. */
async function renderPdf(win, url) {
  const lib = globalThis.pdfjsLib;
  if (!lib) { // no pdf.js — desktop native viewer / download
    win.body.removeAttribute('sandbox');
    win.body.src = url;
    return;
  }
  try {
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      // cross-origin worker fails closed into pdf.js's fake-worker (main thread) — fine
      lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.9.179/build/pdf.worker.min.js';
    }
    const buf = await (await fetch(url)).arrayBuffer();
    const doc = await lib.getDocument({ data: buf }).promise;
    win.body.style.display = 'none';
    let scroller = win.el.querySelector('.dw-pdf');
    if (!scroller) {
      scroller = document.createElement('div');
      scroller.className = 'dw-pdf';
      win.el.appendChild(scroller);
    }
    scroller.replaceChildren();
    win.pdf = { doc, scale: 1, io: null };
    const pageBox = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const holder = document.createElement('div');
      holder.className = 'dw-page';
      holder.dataset.page = i;
      scroller.appendChild(holder);
      pageBox.push(holder);
    }
    const renderPage = async (holder) => {
      if (holder.dataset.done === win.pdf.scale.toFixed(2)) return;
      holder.dataset.done = win.pdf.scale.toFixed(2);
      const page = await doc.getPage(+holder.dataset.page);
      const avail = Math.max(200, scroller.clientWidth - 16);
      const base = page.getViewport({ scale: 1 });
      const fit = (avail / base.width) * win.pdf.scale;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: fit });
      let cv = holder.querySelector('canvas');
      if (!cv) { cv = document.createElement('canvas'); holder.replaceChildren(cv); }
      cv.width = Math.round(vp.width * dpr);
      cv.height = Math.round(vp.height * dpr);
      cv.style.width = Math.round(vp.width) + 'px';
      cv.style.height = Math.round(vp.height) + 'px';
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    };
    win.pdf.io = new IntersectionObserver((entries) => {
      for (const e2 of entries) if (e2.isIntersecting) renderPage(e2.target);
    }, { root: scroller, rootMargin: '600px' });
    pageBox.forEach((h) => { h.style.minHeight = '200px'; win.pdf.io.observe(h); });
    renderPage(pageBox[0]); // first page immediately
    win.pdf.rerender = () => { pageBox.forEach((h) => { delete h.dataset.done; }); renderPage(pageBox[0]); };
  } catch (e) {
    win.body.style.display = '';
    win.body.srcdoc = textDoc(win.name, '(pdf failed to render: ' + e.message + ') ');
  }
}

export function openDocWindow(f) {
  const id = 'docwin-' + ++seq;
  const el = document.createElement('section');
  el.className = 'fsn-docwin';
  el.id = id;
  el.innerHTML =
    `<div class="dw-bar">` +
    `<span class="dw-title">≡ ${esc(f.name)}</span>` +
    `<span class="dw-path">${esc(f.source)} : ${esc(f.path)}</span>` +
    `<button class="dw-fz" data-d="-1" title="smaller text" type="button">A−</button>` +
    `<button class="dw-fz" data-d="1" title="larger text" type="button">A+</button>` +
    `<button class="dw-ungroup" title="remove from its group" type="button">−G</button>` +
    `<button class="dw-pin" title="pin to screen / release back into z-space" type="button">PIN</button>` +
    `<button class="dw-ret" title="retract — dock beside its tower, still in view" type="button">↖</button>` +
    `<button class="dw-min" title="minimize — pull back to its tower" type="button">−</button>` +
    `<button class="dw-max" title="maximize / restore (ctrl+m)" type="button">□</button>` +
    `<button class="dw-close" title="close" type="button">×</button>` +
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
    group: null, gz: null, _groupScale: 1, pinned: false,
  };
  if (win.native && !f.name.toLowerCase().endsWith('.pdf'))
    el.querySelectorAll('.dw-fz').forEach((b) => (b.style.display = 'none'));
  docWindows.set(id, win);
  loadContent(win);
  markRow(win, true); // tree shows what's open

  // Phones: a 440px floating window can't float on a 375px viewport — open as a
  // full reading sheet (standalone mobile-reader parity). − still docks it to
  // the tower; □ toggles back to the sheet.
  if (matchMedia('(max-width: 700px)').matches) {
    win.maximized = true;
    el.classList.add('maximized');
  }

  // Born IN the construct space: anchor at the creation spot (the default).
  // The phone sheet is screen-space by nature and skips it.
  if (!mobileSheet) soloAnchor(win);

  // entrance (the reader's own motion language)
  if (!reduced) animate(el, { opacity: [0, 1], scale: [0.94, 1], y: [12, 0] }, { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] });

  // focus-to-front
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++zTop; });
  // Arm the content on a click (never on a drag — a drag is a camera move that
  // merely happened to start over the window).
  // Arm the content on a click (never on a drag — a drag is a camera move that
  // merely happened to start over the window).
  el.addEventListener('pointerup', (e) => {
    if (e.target.closest('button') || win.dragging) return;
    if (!el.classList.contains('content-active')) armContent(win);
  });
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
  bar.addEventListener('pointerup', () => {
    if (!win.dragging) return;
    win.dragging = false;
    // Stage 9 gesture: my centre dropped INSIDE another window = group with it
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    for (const other of docWindows.values()) {
      if (other === win || other.minimized || other.retracted || other.el.style.display === 'none') continue;
      const o = other.el.getBoundingClientRect();
      if (cx > o.x && cx < o.x + o.width && cy > o.y && cy < o.y + o.height) {
        groupWindows(win, other);
        return;
      }
    }
    // dragged a grouped window somewhere empty: keep the group, move its anchor
    if (win.group) {
      const map = screenZMap();
      if (map) win.gz = map.toZ(cx, cy);
    }
  });
  el.querySelector('.dw-close').addEventListener('click', () => closeDocWindow(id));
  el.querySelectorAll('.dw-fz').forEach((b) => b.addEventListener('click', () => {
    if (win.pdf) { // A± = pdf render scale
      win.pdf.scale = Math.max(0.6, Math.min(2.4, win.pdf.scale + 0.2 * +b.dataset.d));
      win.pdf.rerender();
      return;
    }
    win.fontPx = Math.max(10, Math.min(22, win.fontPx + +b.dataset.d));
    try { // srcdoc is same-origin
      const doc = win.body.contentDocument;
      if (doc && doc.body) doc.body.style.fontSize = win.fontPx + 'px';
    } catch (e) { /* no-op */ }
  }));
  el.querySelector('.dw-max').addEventListener('click', () => toggleMaximize(win));
  el.querySelector('.dw-min').addEventListener('click', () => minimizeDocWindow(win));
  el.querySelector('.dw-ret').addEventListener('click', () => toggleRetract(win));
  el.querySelector('.dw-ungroup').addEventListener('click', () => ungroupWindow(win));
  el.querySelector('.dw-pin').addEventListener('click', () => {
    if (win.pinned) {
      win.pinned = false;
      el.classList.remove('pinned');
      soloAnchor(win); // release: re-enter z-space right where it sits
    } else {
      leaveGroup(win); // pin: hold this screen spot while the world moves
      win.pinned = true;
      el.classList.add('pinned');
    }
  });
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
  if (win.name.toLowerCase().endsWith('.pdf')) {
    // pdf.js everywhere — phones have no inline PDF viewer at all
    renderPdf(win, url);
    return;
  }
  if (nativeView(win.name)) {
    // images/media: sandbox off (it disables plugins/decoding paths), native render
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
        `<div>≡ binary format — <a style="color:#7fffe0" href="${esc(url)}" target="_blank" rel="noopener">open the raw file →</a></div></body>`);
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
  if (win.group) leaveGroup(win);
  if (win.pdf && win.pdf.io) win.pdf.io.disconnect();
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

let wasMobileSheet = matchMedia('(max-width: 700px)').matches;

/** Re-shape open windows when the phone breakpoint is CROSSED. Windows are sized
 * once at creation, so without this a rotate (or any resize past 700px) leaves a
 * desktop-width window clipped on a phone — and the reverse leaves a full-bleed
 * sheet stuck after returning to desktop. Only fires on an actual crossing, so
 * ordinary resizing never fights the user's own drag/placement. */
function reflowDocWindows() {
  const isMobile = matchMedia('(max-width: 700px)').matches;
  if (isMobile === wasMobileSheet) return;
  wasMobileSheet = isMobile;
  for (const win of docWindows.values()) {
    if (win.minimized) continue;
    if (isMobile) {
      // the phone reading sheet is a CSS class; inline desktop sizing would win
      win.el.style.width = '';
      win.el.style.height = '';
      win.el.style.left = '';
      win.el.style.top = '';
      win.el.style.transform = '';
      if (win.group) leaveGroup(win); // z-anchoring is meaningless for a full sheet
      win.pinned = false;
      win.el.classList.remove('pinned');
      win.maximized = true;
      win.el.classList.add('maximized');
    } else {
      win.maximized = false;
      win.el.classList.remove('maximized');
      const W = Math.max(440, Math.min(700, innerWidth - 300));
      const H = Math.max(360, Math.min(620, Math.round(innerHeight * 0.74)));
      win.size = { w: W, h: H };
      win.el.style.width = W + 'px';
      win.el.style.height = H + 'px';
      const x = Math.max(258, Math.min(innerWidth - W - 12, win.home ? win.home.x : innerWidth * 0.5));
      const y = Math.max(40, Math.min(Math.max(44, innerHeight - H - 12), win.home ? win.home.y : 80));
      win.home = { x, y };
      win.el.style.left = x + 'px';
      win.el.style.top = y + 'px';
      soloAnchor(win); // re-enter z-space where it now sits
    }
  }
}
addEventListener('resize', reflowDocWindows);

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

// ---------------------------------------------------------------------------
// Stage 9 — WINDOW GROUPS with a SHARED ZOOM STATE (user-directed 2026-08-17:
// "group different windows so we can view them all in the same zoom state, but
// neurite's natural state is letting these items float in their own space").
// A group is a z-space frame: each member stores its Graph-z position (w.gz)
// and the group's reference zoom. Camera zoom then moves AND scales the whole
// set coherently (Neurite-native behavior, opted into by grouping); free
// windows stay screen-fixed. Formed by DROPPING one window onto another; −G
// ungroups. Suspended while dragging/maximized/minimized/retracted/construct.
let groupSeq = 0;
const groups = new Map(); // gid -> { zoomRef, label }
// debug ground truth (same spirit as __fsnFrames)
globalThis.__fsnGroupWin = (i, j) => { const ws = [...docWindows.values()]; if (ws[i] && ws[j]) groupWindows(ws[i], ws[j]); return __fsnGroupsDbg(); };
globalThis.__fsnGroupsDbg = () => JSON.stringify({
  size: groups.size,
  wins: [...docWindows.values()].map((w) => ({ g: w.group, gs: +(w._groupScale || 0).toFixed(3), gz: !!w.gz, drag: w.dragging })),
});

const zoomMag = () => {
  const G = globalThis.Graph;
  return G ? Math.hypot(G.zoom.x, G.zoom.y) : 1;
};

/** Per-frame affine map screen↔z, probed from Graph.xyToZ itself (3 calls) so
 * it can never drift from Neurite's internals. Returns {toScreen(z)->{x,y}}. */
function screenZMap() {
  const G = globalThis.Graph;
  if (!G || !G.xyToZ) return null;
  const o = G.xyToZ(0, 0), ex = G.xyToZ(1, 0), ey = G.xyToZ(0, 1);
  const ax = { x: ex.x - o.x, y: ex.y - o.y }; // dz per screen-x px
  const ay = { x: ey.x - o.x, y: ey.y - o.y }; // dz per screen-y px
  const det = ax.x * ay.y - ax.y * ay.x;
  if (!det) return null;
  return {
    toScreen(z) {
      const dx = z.x - o.x, dy = z.y - o.y;
      return { x: (dx * ay.y - dy * ay.x) / det, y: (dy * ax.x - dx * ax.y) / det };
    },
    toZ(x, y) { return G.xyToZ(x, y); },
  };
}

/** Put a window into b's group (or form a new one). Captures the member's
 * z-anchor at its CURRENT screen centre. */
export function groupWindows(a, b) {
  if (a === b || a.minimized || b.minimized || a.retracted || b.retracted) return;
  const map = screenZMap();
  if (!map) return;
  if (a.group) leaveGroup(a); // a window brings itself, not its old group
  let gid = b.group;
  const gb = gid && groups.get(gid);
  if (gb && gb.solo) { gb.solo = false; gb.label = 'GROUP ' + ++groupSeq; }
  if (!gid) {
    gid = 'g' + ++groupSeq;
    groups.set(gid, { zoomRef: zoomMag(), label: 'GROUP ' + groupSeq });
    b.group = gid;
    const rb = b.el.getBoundingClientRect();
    b.gz = map.toZ(rb.x + rb.width / 2, rb.y + rb.height / 2);
  }
  a.group = gid;
  const ra = a.el.getBoundingClientRect();
  a.gz = map.toZ(ra.x + ra.width / 2, ra.y + ra.height / 2);
  for (const w of [a, b]) w.el.classList.add('grouped');
}

/** Make ONE window's content interactive; every other window goes inert so the
 * camera stays drivable across the rest of the screen. */
export function armContent(win) {
  for (const w of docWindows.values()) {
    if (w === win) continue;
    w.el.classList.remove('content-active');
  }
  if (win) win.el.classList.add('content-active');
}

/** Disarm all content (a background press) — the next drag anywhere is camera. */
export function disarmContent() {
  for (const w of docWindows.values()) w.el.classList.remove('content-active');
}

/** Fully leave z-management (retract/minimize/pin — states with their own
 * anchoring). A DECORATED group collapsing to one member demotes to a solo
 * carrier rather than dumping the survivor to the screen. */
export function leaveGroup(w) {
  const gid = w.group;
  if (!gid) return;
  w.group = null; w.gz = null;
  w.el.classList.remove('grouped');
  w.el.style.transform = '';
  const members = [...docWindows.values()].filter((x) => x.group === gid);
  const g = groups.get(gid);
  if (members.length === 1 && g && !g.solo) { g.solo = true; g.label = ''; }
  if (members.length === 0) groups.delete(gid);
}

/** Anchor a window in z-space AT ITS CURRENT SCREEN SPOT as a group-of-one —
 * the DEFAULT life of a window (user 2026-08-27: windows behave as though they
 * are in the 3D construct space where they were created; screen-lock is the
 * deliberate exception, via the pin). zoomRef = the zoom of the moment, so it
 * opens at natural size and scales from there. */
export function soloAnchor(win) {
  if (win.group || win.pinned || win.maximized || win.minimized || win.retracted) return;
  const map = screenZMap();
  if (!map) return;
  const gid = 'g' + ++groupSeq;
  groups.set(gid, { zoomRef: zoomMag(), label: '', solo: true });
  win.group = gid;
  const r = win.el.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  win.gz = map.toZ(cx, cy); // kept: the fallback when the anchor is unprojectable
  // A solo window rides its FILE in the 3D construct, offset by wherever it was
  // opened. Storing the offset (rather than an absolute screen spot) is what
  // lets it hold its relationship to the tower through orbit, fly and zoom.
  const a = anchorScreen(win);
  win.anchorOff = a ? { dx: cx - a.x, dy: cy - a.y, ref: zoomMag() || 1 } : null;
}

/** The −G action: out of the SHARED group, back to your own spot in z-space. */
export function ungroupWindow(w) {
  leaveGroup(w);
  soloAnchor(w);
}

function groupsLayer() {
  let el = document.getElementById('fsn-groups');
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.id = 'fsn-groups';
    el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:38;';
    document.body.appendChild(el);
  }
  return el;
}

/** EXPAND DOCUMENTS (user-directed 2026-08-18: "right click and expand all the
 * documents out from their base tethered and in the neurite space, not all
 * attached to the screen persistent zoom"): open a directory's DIRECT files as
 * compact cards fanned around the tower base, all in ONE z-space group — they
 * float in Neurite space (camera zoom moves AND scales them; zooming in brings
 * them to reading size), each tethered to its file box. Subfolders are NOT
 * expanded — one level, as always. */
export function expandDirDocs(source, dirPath) {
  const fsn = globalThis.fsnHandle && globalThis.fsnHandle();
  const map = screenZMap();
  if (!fsn || !fsn.find_file || !map) return 0;
  const base = dirPath.replace(/\/$/, '');
  // direct children only, from the tree rows (the wasm-built truth)
  const rows = [...document.querySelectorAll('#tree-rows .row.file')].filter((r) => {
    if (r.dataset.source !== source) return false;
    const pp = r.dataset.path || '';
    if (!pp.startsWith(base + '/')) return false;
    return !pp.slice(base.length + 1).includes('/');
  }).slice(0, 8); // sane cap
  if (!rows.length) return 0;
  const gid = 'g' + ++groupSeq;
  // zoomRef below the current zoom => the cards open COMPACT (scale ~0.55) and
  // grow toward full reading size as the camera zooms in toward the tower.
  groups.set(gid, { zoomRef: zoomMag() * 0.55, label: base.split('/').pop().toUpperCase() + ' · DOCS' });
  let n = 0;
  rows.forEach((r, i) => {
    const hit = fsn.find_file(r.dataset.source || '', r.dataset.path || '');
    if (!hit) return;
    let f; try { f = JSON.parse(hit); } catch (e) { return; }
    // already open? adopt it into the expansion instead of duplicating
    let win = [...docWindows.values()].find((w) => w.source === f.source && w.path === f.path);
    if (!win) win = openDocWindow(f);
    if (!win) return;
    if (win.minimized) restoreDocWindow(win);
    if (win.retracted) { win.retracted = false; win.el.classList.remove('retracted'); }
    // fan the cards around the tower base's screen position, then anchor in z
    const pr = fsn.project(f.x, f.y, f.z);
    const c = document.getElementById('fsn-canvas');
    const rx = c && c.width ? c.clientWidth / c.width : 1, ry = c && c.height ? c.clientHeight / c.height : 1;
    const bx = pr ? pr[0] * rx : innerWidth / 2, by = pr ? pr[1] * ry : innerHeight / 2;
    const ang = (i / rows.length) * Math.PI * 2 - Math.PI / 2;
    const R = 150 + 26 * (i % 2);
    win.group = gid;
    win.gz = map.toZ(bx + Math.cos(ang) * R, by + Math.sin(ang) * R * 0.7 - 60);
    win.el.classList.add('grouped');
    n++;
  });
  if (n === 0) groups.delete(gid);
  return n;
}

/** Stage 5 z-rebase: the epoch transform T(z) = (z - pan)/s is applied to all
 * z-anchored doc state so grouped windows are PIXEL-INVARIANT across a rebase
 * (group scale sc = zoomRef/|zoom| — both divide by s, sc unchanged; anchors
 * transform with the space). */
export function rebaseDocState(pan, s) {
  for (const g of groups.values()) g.zoomRef /= s;
  for (const w of docWindows.values()) {
    if (w.gz) { w.gz = { x: (w.gz.x - pan.x) / s, y: (w.gz.y - pan.y) / s }; }
  }
}

/** Per-frame: place grouped windows from their z-anchors, scale by the zoom
 * ratio (readability-clamped), and draw each group's frame. */
function stepGroups() {
  const inConstruct = globalThis.fsnInConstruct && globalThis.fsnInConstruct();
  const layer = document.getElementById('fsn-groups');
  // LATE JOIN: a window opened before the z-camera was ready has no group yet.
  // Retry until it takes, or it stays frozen where it was created — which is
  // exactly the "locked to the viewport" symptom.
  for (const w of docWindows.values()) {
    if (!w.group && !w.pinned && !w.maximized && !w.minimized && !w.retracted) soloAnchor(w);
  }
  if (groups.size === 0 || inConstruct) { if (layer) layer.replaceChildren(); return; }
  const map = screenZMap();
  if (!map) return;
  const zm = zoomMag() || 1;
  const bounds = new Map(); // gid -> {x0,y0,x1,y1}
  for (const w of docWindows.values()) {
    if (!w.group || w.dragging || w.maximized || w.minimized || w.retracted) continue;
    const g = groups.get(w.group);
    if (!g) { w.group = null; continue; }
    const sc = Math.max(0.35, Math.min(2.2, g.zoomRef / zm)); // readability clamp
    let c;
    if (g.solo) {
      // 3D-anchored: follows orbit and fly, not just pan/zoom.
      if (!w.anchorOff) {
        // late latch — the anchor was unprojectable when the window opened
        const a0 = anchorScreen(w);
        if (a0) {
          const r0 = w.el.getBoundingClientRect();
          w.anchorOff = { dx: r0.x + r0.width / 2 - a0.x, dy: r0.y + r0.height / 2 - a0.y,
                          ref: zoomMag() || 1 };
        }
      }
      const a = w.anchorOff && anchorScreen(w);
      if (a) {
        const k = w.anchorOff.ref ? Math.max(0.35, Math.min(2.2, zm ? w.anchorOff.ref / zm : 1)) : 1;
        c = { x: a.x + w.anchorOff.dx * k, y: a.y + w.anchorOff.dy * k };
      } else {
        c = map.toScreen(w.gz); // anchor behind the camera — hold the z-plane spot
      }
    } else {
      c = map.toScreen(w.gz);
    }
    const bw = (w.size ? w.size.w : 440), bh = (w.size ? w.size.h : 360);
    w.el.style.left = Math.round(c.x - bw / 2) + 'px';
    w.el.style.top = Math.round(c.y - bh / 2) + 'px';
    w.el.style.transformOrigin = 'center';
    w._groupScale = sc; // the float transform composes with this in stepDocWindows
    if (g.solo) continue; // solo carriers are invisible z-frames, not GROUP chrome
    const r = { x0: c.x - (bw * sc) / 2, y0: c.y - (bh * sc) / 2, x1: c.x + (bw * sc) / 2, y1: c.y + (bh * sc) / 2 };
    const b = bounds.get(w.group);
    bounds.set(w.group, b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : r);
  }
  const svg = groupsLayer();
  const want = [...bounds.entries()];
  while (svg.children.length > want.length * 2) svg.removeChild(svg.lastChild);
  while (svg.children.length < want.length * 2) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'fsn-groupframe');
    svg.appendChild(rect);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('class', 'fsn-grouplabel');
    svg.appendChild(label);
  }
  want.forEach(([gid, b], i) => {
    const rect = svg.children[i * 2], label = svg.children[i * 2 + 1];
    rect.setAttribute('x', Math.round(b.x0 - 10)); rect.setAttribute('y', Math.round(b.y0 - 24));
    rect.setAttribute('width', Math.round(b.x1 - b.x0 + 20)); rect.setAttribute('height', Math.round(b.y1 - b.y0 + 34));
    label.setAttribute('x', Math.round(b.x0 - 2)); label.setAttribute('y', Math.round(b.y0 - 10));
    label.textContent = (groups.get(gid) || {}).label || gid;
  });
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
  if (win.group) leaveGroup(win);
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
      chip.textContent = '≡ ' + win.name;
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
 * short tether. Click the card (or ↖ again) to expand back to the floating
 * reading window at that spot. */
export function toggleRetract(win) {
  if (win.minimized) return;
  if (win.maximized) toggleMaximize(win);
  if (!win.retracted && win.group) leaveGroup(win);
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
        chip.textContent = '≡ ' + d.name;
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
  stepGroups(); // Stage 9: z-anchored groups follow the camera
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
    const gs = w.group && !w.dragging && !w.maximized ? (w._groupScale || 1) : 1;
    if (w.dragging || w.maximized) { w.el.style.transform = ''; continue; }
    if (reduced) { if (gs !== 1) w.el.style.transform = `scale(${gs.toFixed(3)})`; continue; }
    const t = now / 1000;
    const fx = Math.sin(t * 0.5 + w.phase) * 3.5;
    const fy = Math.cos(t * 0.37 + w.phase * 1.7) * 2.5;
    w.el.style.transform = `translate(${fx.toFixed(2)}px, ${fy.toFixed(2)}px)` + (gs !== 1 ? ` scale(${gs.toFixed(3)})` : '');
  }
}
