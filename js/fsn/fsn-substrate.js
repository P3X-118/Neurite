// fsn substrate for Neurite — replaces the Mandelbrot fractal as the spatial
// substrate the node/graph layer rides on.
//
// Neurite's node layer talks to its substrate through a tiny transform contract
// (mapped 2026-07-26): world<->screen for placing/picking nodes, plus a per-frame
// camera/redraw. This module implements that contract over `FsnEmbed` (the fsn
// Rust/wasm 3D landscape), so nodes sit on fsn pedestals instead of fractal hairs.
//
// STATUS: engine + shims land here and BUILD; the in-place swap of Neurite's core
// seams (see README) is gated by `isFsnActive()` so the fractal path is unchanged
// when off. WORLD_SCALE and the ground-plane mapping need live tuning against the
// running app. Load-bearing constant is WORLD_SCALE.
//
// Wasm assets are vendored in ./pkg (built via `wasm-pack build --target web`).

import init, { FsnEmbed } from './pkg/fsn.js';
import { docWindows, openDocWindow, topDocWindow, toggleMaximize, stepDocWindows, restoreDocWindow, docsStateJson, restoreByPath, setRemoteDocs, expandDirDocs } from './fsn-docwin.js';
Object.assign(globalThis, { fsnDocsStateJson: docsStateJson, fsnRestoreByPath: restoreByPath, fsnSetRemoteDocs: setRemoteDocs });
import wasmUrl from './pkg/fsn_bg.wasm?url'; // Vite: resolves to the served asset URL

// Neurite world units are ~O(1) around the origin; fsn's landscape spans tens of
// units. This bridges the two — TUNE against the running app.
const WORLD_SCALE = 12.0;

let fsn = null;
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Which visualization is the substrate. **IRIX/fsn is the DEFAULT**; the Neurite
 * fractal is admin-only, off unless explicitly turned on (`?viz=fractal` or
 * `window.NEURITE_FRACTAL = true`). This is the "IRIX is the primary theme" rule. */
export function fsnVizMode() {
  const q = new URLSearchParams(location.search);
  if (q.get('viz') === 'fractal' || globalThis.NEURITE_FRACTAL === true) return 'fractal';
  return 'fsn';
}

/** True when fsn is the active substrate (the default). Checks the mode only —
 * NOT whether fsn finished initializing (else boot never triggers); the shims
 * below no-op until `fsn` is ready, so activating before init is safe. */
export function isFsnActive() {
  return fsnVizMode() === 'fsn';
}

/** True only when an admin explicitly re-enabled the Neurite fractal. */
export function isFractalActive() {
  return fsnVizMode() === 'fractal';
}

/** One-time init: bind fsn to a canvas layered under Neurite's #nodes overlay.
 * `console: true` boots the fsn CONSOLE composition — the standalone shell
 * (side-panel tree / boards / labels / reader via the real Rust web_ui) driving
 * this embed; the console markup must already be in the DOM (mountFsnConsole). */
export async function initFsnSubstrate(canvas, { console: consoleMode = false } = {}) {
  await init(wasmUrl);
  fsn = consoleMode ? await FsnEmbed.create_console(canvas) : await FsnEmbed.create_live(canvas);
  return fsn;
}

// --- console composition: the panel's camera requests, host-side ---
/** Pedestal the panel asked to fly to since last poll (-1 none). */
export function fsnTakeFocus() { return fsn && fsn.take_focus ? fsn.take_focus() : -1; }
/** True once after a board switch — recenter to the overview. */
export function fsnTakeRecenter() { return fsn && fsn.take_recenter ? !!fsn.take_recenter() : false; }
/** fsn world (x,z) → the Graph.pan that centers it (file fly-to). */
export function fsnWorldToPan(x, z) {
  return { x: x / WORLD_SCALE, y: z / WORLD_SCALE };
}

/** Graph.pan target that centers pedestal `i` (fsn world → z-space). */
export function fsnPedestalPan(i) {
  const a = fsn && fsn.pedestal_anchor ? fsn.pedestal_anchor(i) : null;
  return a ? { x: a[0] / WORLD_SCALE, y: a[2] / WORLD_SCALE } : null;
}

export function fsnHandle() {
  return fsn;
}

// --- the substrate contract (each maps to a Neurite fn; see README) ---

/**
 * world (Neurite complex `vec2`) -> normalized screen UV {x,y} in [0,1], or null
 * if behind the camera. Reimplements `fromZtoUV` (mandelbrot.js) — the Node.draw
 * placement seam. Nodes are projected onto fsn's ground plane (y=0).
 */
export function fsnFromZtoUV(z) {
  if (!fsn) return null;
  const p = fsn.project(z.x * WORLD_SCALE, 0, z.y * WORLD_SCALE); // [sx,sy] physical px, or undefined
  if (!p) return null;
  const [w, h] = fsnBufferSize();
  return { x: p[0] / w, y: p[1] / h };
}

/**
 * world (Neurite `vec2`) -> screen CSS px {x,y}, or null if behind the camera.
 * The direct-px variant of fsnFromZtoUV — Node.draw sets style.left/top from it.
 */
export function fsnProjectPx(z) {
  if (!fsn) return null;
  const p = fsn.project(z.x * WORLD_SCALE, 0, z.y * WORLD_SCALE); // [sx,sy] physical px, or undefined
  if (!p) return null;
  const c = document.getElementById('fsn-canvas');
  const rx = c && c.width ? c.clientWidth / c.width : 1; // physical px -> CSS px
  const ry = c && c.height ? c.clientHeight / c.height : 1;
  return { x: p[0] * rx, y: p[1] * ry };
}

/**
 * screen px -> world (Neurite complex `vec2`) on fsn's ground plane. Reimplements
 * `Graph.xyToZ`/`vecToZ` — node create/drag/pick. `px,py` are CSS px; pass the
 * device-pixel ratio the canvas is scaled by.
 */
export function fsnXyToZ(px, py, dpr = 1) {
  if (!fsn) return { x: 0, y: 0 };
  const w = fsn.unproject_ground(px * dpr, py * dpr); // [x,y,z] world, or undefined
  if (!w) return { x: 0, y: 0 };
  return { x: w[0] / WORLD_SCALE, y: w[2] / WORLD_SCALE }; // fsn (x,_,z) -> Neurite (re,im)
}

/** Per-frame: drive fsn's animation + draw. Replaces `Svg.updateViewbox`+render_hair. */
export function fsnStep(dt) {
  if (!fsn) return;
  fsn.update(dt);
  fsn.render();
  stepDocWindows(performance.now()); // ambient float on the open document windows
  fsnUpdateWires(); // fluid tethers: document windows -> their file boxes on the towers
  if (constructActive) fsnUpdateConstructLinks(); // Stage 7: correlation links in the construct
}

/** Design B: each frame, slave fsn's camera to Neurite's Graph.pan/zoom so the 3D
 * landscape is the DRIVEN visual skin. Neurite owns coordinates + the infinite zoom. */
export function fsnDriveView() {
  if (!fsn || !fsn.set_view) return;
  const G = globalThis.Graph;
  if (!G || !G.pan || !G.zoom) return;
  const scale = Math.hypot(G.zoom.x, G.zoom.y); // |Graph.zoom|
  fsn.set_view(G.pan.x * WORLD_SCALE, G.pan.y * WORLD_SCALE, scale);
}

/** fsn's own orbit (rotate the tower) — Design B rides this on RIGHT-drag. */
export function fsnOrbit(dx, dy) {
  if (fsn) fsn.orbit(dx, dy);
}
export function fsnZoom(delta) {
  if (fsn) fsn.zoom(delta);
}
export function fsnResize(wPx, hPx) {
  if (fsn) fsn.resize(wPx, hPx);
}

// --- Design B descent: re-root the tower onto a floor's subfolder ---
/** Pick the floor under a pixel and descend into it. Returns the new root path,
 * or "" if nothing / a file / floor 0 / a locked inception boundary was hit. */
export function fsnDescendAt(px, py, dpr = 1) {
  if (!fsn || !fsn.pick_at) return '';
  const i = fsn.pick_at(px * dpr, py * dpr);
  if (i < 1) return '';
  // The console shows the balloon LANDSCAPE, where pedestal i is a depth-first
  // tree position — NOT child i-1 of the current dir, which is what descend(i)
  // (tower semantics) assumes; it silently returned "" there. Panel rows are
  // index-aligned with pedestals, so descend by the row's PATH via enter_path.
  // dir rows carry data-index = the pedestal index (file rows interleave in
  // #tree-rows, so ordinal position does NOT align — that broke descend)
  const row = document.querySelector('#tree-rows .row[data-index="' + i + '"]');
  const path = row && row.dataset ? row.dataset.path || '' : '';
  if (path && path !== '/' && fsn.enter_path) {
    const r = fsn.enter_path(path);
    if (r) return r;
  }
  return fsn.descend(i); // tower-mode fallback (embed demo / non-console)
}
export function fsnAscend() { return fsn && fsn.ascend ? fsn.ascend() : ''; }
export function fsnCurrentPath() { return fsn && fsn.current_path ? fsn.current_path() : ''; }

/** Pick the FILE under a pixel — JSON {name,path,source,x,y,z} (world anchor) or "". */
export function fsnPickFileAt(px, py, dpr = 1) {
  return fsn && fsn.pick_file_at ? fsn.pick_file_at(px * dpr, py * dpr) : '';
}

/** Design B Stage 4b: bloom a file into a floating Neurite node, placed beside the file
 * (project its world anchor to screen, offset, unproject to z-space). Returns the node. */
// Design B Stage 4b: bloomed file-nodes stay WIRED to their file box on the tower. The
// wire is a screen-space line (own overlay SVG, not Neurite's viewBox'd svg_bg) recomputed
// each frame from fsn.project(fileWorld) -> node center, so it tracks fsn orbit + Graph zoom.
// Entering the tag "construct" (Stage 7) calls fsnClearWires() to drop them.
// (bloomWires retired 2026-08-16 — tethers read the fsn-docwin registry)

function fsnWiresSvg() {
  let el = document.getElementById('fsn-wires');
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.id = 'fsn-wires';
    el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2;';
    document.body.appendChild(el);
  }
  return el;
}

export function fsnUpdateWires() {
  if (!fsn) return;
  const wel = document.getElementById('fsn-wires');
  if (constructActive) { if (wel) wel.style.display = 'none'; return; } // tethers drop in the construct
  if (wel && wel.style.display === 'none') wel.style.display = '';
  const wins = [...docWindows.values()].filter((w) => !w.maximized && !w.minimized);
  const el = document.getElementById('fsn-wires');
  if (wins.length === 0) { if (el) el.replaceChildren(); return; }
  const svg = fsnWiresSvg();
  const c = document.getElementById('fsn-canvas');
  const rx = c && c.width ? c.clientWidth / c.width : 1, ry = c && c.height ? c.clientHeight / c.height : 1;
  while (svg.children.length > wins.length) svg.removeChild(svg.lastChild);
  while (svg.children.length < wins.length) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'fsn-tether');
    svg.appendChild(path);
  }
  wins.forEach((w, i) => {
    const path = svg.children[i];
    const a = fsn.project(w.anchor.x, w.anchor.y, w.anchor.z); // file box, physical px
    const r = w.el.getBoundingClientRect();                    // includes the float transform
    if (a && r.width > 0) {
      const sx = a[0] * rx, sy = a[1] * ry;
      // attach to the window's nearest vertical edge, at bar height — but the
      // cable end TRAILS the window slightly (exp smoothing), so drags and the
      // float read as the cable catching up: the fluid feel.
      const eyT = r.top + 16;
      const exT = sx < r.left + r.width / 2 ? r.left : r.right;
      const now = performance.now();
      const tdt = Math.min((now - (w._tt || now)) / 1000, 0.1);
      w._tt = now;
      if (w._tx === undefined) { w._tx = exT; w._ty = eyT; }
      const k = 1 - Math.exp(-tdt * 9);
      w._tx += (exT - w._tx) * k;
      w._ty += (eyT - w._ty) * k;
      const ex = w._tx, ey = w._ty;
      // a slack cable: sag scales with distance (capped) and BREATHES gently
      const dist = Math.hypot(ex - sx, ey - sy);
      const sag = Math.min(90, dist * 0.22) + (reducedMotion ? 0 : Math.sin(now / 900 + w.phase) * 4);
      const c1x = sx + (ex - sx) * 0.28, c1y = sy + sag;
      const c2x = ex - (ex - sx) * 0.28, c2y = ey + sag * 0.55;
      path.setAttribute('d', `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`);
      path.style.display = '';
    } else {
      path.style.display = 'none';
    }
  });
}

/** Stage 7: drop every tower wire when the tag-construct takes over. */
export function fsnClearWires() {
  bloomWires = [];
  const el = document.getElementById('fsn-wires');
  if (el) el.replaceChildren();
}

// Easy full-screen / exit toggle for a bloomed node (the user's Stage 4b requirement):
// zoom the (Neurite-owned) camera so the node fills the view; toggle again to fly back.
let fsFullscreenSaved = null;
export function fsnToggleNodeFullscreen() {
  const w = topDocWindow();
  if (w) toggleMaximize(w);
}

// Design B Stage 4d: fsn actions injected into Neurite's native right-click menu.
// customcontextmenu.js calls window.fsnMenuActions for the canvas/background and
// window.fsnNodeMenuActions for a bloomed file-node.
function fsnRecenterPan() { const G = globalThis.Graph; if (G && G.pan) { G.pan.x = 0; G.pan.y = 0; } }

/** Right-click the fsn landscape: Open(bloom)/Copy-path for a file under the cursor, Descend for a
 *  floor, Ascend when not at the root. Prepended to the menu; returns true if it added any item. */
export function fsnMenuActions(menu, x, y) {
  const h = fsnHandle();
  if (!h) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = x * dpr, py = y * dpr;
  let added = false;
  const fileJson = h.pick_file_at ? h.pick_file_at(px, py) : '';
  if (fileJson) {
    let f = null; try { f = JSON.parse(fileJson); } catch (e) {}
    if (f) {
      // zoom the right-clicked file toward focus while the menu is showing
      if (globalThis.fsnFlyFocus) globalThis.fsnFlyFocus({ file: f });
      menu.menu.append(menu.option('\u2922 Open  ' + f.name, () => fsnBloomFile(fileJson)));
      menu.menu.append(menu.option('\u29c9 Copy path', () => { if (navigator.clipboard) navigator.clipboard.writeText(f.path || ''); }));
      added = true;
    }
  } else {
    const floor = h.pick_at ? h.pick_at(px, py) : -1;
    if (floor >= 1) {
      // EXPAND (user-corrected 2026-08-18: the tower re-root was wrong): bloom
      // the directory's DIRECT documents out from its base as z-space cards —
      // tethered to their file boxes, floating in Neurite space (camera zoom
      // scales them up to reading size). Subfolders stay collapsed.
      const row = document.querySelector('#tree-rows .row[data-index="' + floor + '"]');
      const rpath = row && row.dataset ? row.dataset.path || '' : '';
      const rname = row && row.dataset ? row.dataset.name || rpath : rpath;
      const rsrc = row && row.dataset ? row.dataset.source || '' : '';
      if (rpath && rpath !== '/') {
        // zoom the right-clicked tower toward focus while the menu is showing
        if (globalThis.fsnFlyFocus) globalThis.fsnFlyFocus({ ped: floor });
        menu.menu.append(menu.option('⌁ Expand documents  ' + rname, () => {
          const n = expandDirDocs(rsrc, rpath);
          if (!n && globalThis.fsnEnterPathSynced) globalThis.fsnEnterPathSynced(rpath); // no docs in scene -> enter instead
        }));
        added = true;
      }
    }
  }
  const cur = h.current_path ? h.current_path() : '';
  if (cur && cur.indexOf('/') !== -1) {
    menu.menu.append(menu.option('\u25b3 Ascend to parent', () => { h.ascend(); fsnRecenterPan(); }));
    added = true;
  }
  const blooms = docWindows.size;
  if (constructActive) {
    menu.menu.append(menu.option('◉ Exit construct', () => fsnExitConstruct()));
    added = true;
  } else if (blooms >= 1) {
    menu.menu.append(menu.option('⊞ Construct: correlate ' + blooms + ' open doc' + (blooms === 1 ? '' : 's'), () => fsnEnterConstruct('open documents')));
    added = true;
  }
  return added;
}

/** Right-click a bloomed file-node: fsn items atop Neurite's node menu. */
export function fsnNodeMenuActions(menu, node) {
  if (!node) return false;
  menu.menu.append(menu.option('\u2922 Fullscreen / exit', () => fsnToggleNodeFullscreen(node)));
  if (constructActive) menu.menu.append(menu.option('◉ Exit construct', () => fsnExitConstruct()));
  else menu.menu.append(menu.option('⊞ Correlate in construct', () => fsnEnterConstruct('open documents')));
  return true;
}

// ---------------------------------------------------------------------------
// Design B Stage 7 — the tag "CONSTRUCT". Selecting a tag/keyword (or "correlate
// the open documents") DROPS the 3D towers into a matrix void: the fsn canvas dims,
// the tower wires drop, and the bloomed document nodes are pulled out of their
// hierarchy into a correlation ring where their links take UI precedence. It is a
// view toggle inside the SAME Neurite z-space (the z-camera is kept), so exiting
// restores the towers exactly where they were.
let constructActive = false;
let constructNodes = [];
let constructSaved = null; // { view, pos[] } to restore on exit

export function fsnInConstruct() { return constructActive; }

/** Open document windows (the floating readers). */
export function fsnDocCount() { return docWindows.size; }

export function fsnEnterConstruct(label) {
  if (constructActive) return false;
  const entries = [...docWindows.entries()];
  if (entries.length < 1) return false; // nothing open to correlate yet
  constructActive = true;
  constructSaved = entries.map(([id, w]) => ({ id, home: { ...w.home }, maximized: w.maximized }));
  const c = document.getElementById('fsn-canvas');
  if (c) c.style.opacity = '0.1';
  document.documentElement.classList.add('fsn-construct');
  // ring the open documents around the viewport centre (screen space)
  const cx = Math.max(innerWidth / 2, 380), cy = innerHeight / 2;
  const R = Math.min(innerWidth, innerHeight) * 0.28 + entries.length * 14;
  entries.forEach(([id, w], i) => {
    if (w.minimized) restoreDocWindow(w); // correlating = showing them
    if (w.maximized) { w.maximized = false; w.el.classList.remove('maximized'); }
    const a = (i / entries.length) * Math.PI * 2 - Math.PI / 2;
    const r = w.el.getBoundingClientRect();
    w.home = {
      x: Math.max(10, Math.min(innerWidth - r.width - 10, cx + Math.cos(a) * R - r.width / 2)),
      y: Math.max(46, Math.min(innerHeight - r.height - 10, cy + Math.sin(a) * R - r.height / 2)),
    };
    w.el.classList.add('cx-move'); // CSS-transitioned glide into the ring
    w.el.style.left = w.home.x + 'px';
    w.el.style.top = w.home.y + 'px';
    setTimeout(() => w.el.classList.remove('cx-move'), 600);
  });
  showConstructBanner(label || 'open documents', entries.length);
  return true;
}

export function fsnExitConstruct() {
  if (!constructActive) return;
  const c = document.getElementById('fsn-canvas');
  if (c) c.style.opacity = '';
  document.documentElement.classList.remove('fsn-construct');
  for (const saved of constructSaved || []) {
    const w = docWindows.get(saved.id);
    if (!w) continue;
    w.home = { ...saved.home };
    w.el.classList.add('cx-move');
    w.el.style.left = w.home.x + 'px';
    w.el.style.top = w.home.y + 'px';
    setTimeout(() => w.el.classList.remove('cx-move'), 600);
  }
  constructActive = false; constructSaved = null;
  hideConstructBanner();
  clearConstructLinks();
}

function fsnConstructSvg() {
  let el = document.getElementById('fsn-constructlinks');
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.id = 'fsn-constructlinks';
    el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2;';
    document.body.appendChild(el);
  }
  return el;
}
function clearConstructLinks() { const el = document.getElementById('fsn-constructlinks'); if (el) el.replaceChildren(); }

// Correlation links: a complete graph over the construct docs (screen-space, like the tower
// wires). MVP = "all RAG files correlated against each other"; later, weight/prune by shared
// tags + LocalRecall relatedness.
export function fsnUpdateConstructLinks() {
  if (!constructActive) return;
  const svg = fsnConstructSvg();
  const cts = [...docWindows.values()].map((w) => {
    const r = w.el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const pairs = [];
  for (let i = 0; i < cts.length; i++) for (let j = i + 1; j < cts.length; j++) pairs.push([i, j]);
  while (svg.children.length > pairs.length) svg.removeChild(svg.lastChild);
  while (svg.children.length < pairs.length) {
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('stroke', '#7fffe0'); ln.setAttribute('stroke-width', '1'); ln.setAttribute('stroke-opacity', '0.45');
    svg.appendChild(ln);
  }
  pairs.forEach(([i, j], k) => {
    const ln = svg.children[k], a = cts[i], b = cts[j];
    ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y); ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
  });
}

function showConstructBanner(label, n) {
  let b = document.getElementById('fsn-construct-banner');
  if (!b) { b = document.createElement('div'); b.id = 'fsn-construct-banner'; document.body.appendChild(b); }
  b.innerHTML = '<span class="cx-dot">◉</span> CONSTRUCT · correlating <b>' + n + '</b> document' + (n === 1 ? '' : 's') +
    ' · <span class="cx-tag">' + String(label).replace(/</g, '') + '</span>' +
    '<button id="fsn-construct-exit">exit ⏎</button>';
  b.style.display = 'flex';
  const btn = document.getElementById('fsn-construct-exit');
  if (btn) btn.onclick = () => { if (globalThis.fsnExitConstruct) globalThis.fsnExitConstruct(); };
}
function hideConstructBanner() { const b = document.getElementById('fsn-construct-banner'); if (b) b.style.display = 'none'; }

export function fsnBloomFile(fileJson) {
  // User direction 2026-08-16: documents open as the ORIGINAL fsn reader window
  // (floating, fixed pixel scale, a reading tool) — not a Neurite text node
  // (janky chrome, Graph-zoom-coupled scaling). The window keeps the slight
  // ambient float and a fluid tether to its file box (fsn-docwin.js).
  if (!fsn) return null;
  let f; try { f = JSON.parse(fileJson); } catch { return null; }
  return openDocWindow(f);
}

function fsnBufferSize() {
  const c = document.getElementById('fsn-canvas');
  return c ? [c.width, c.height] : [globalThis.innerWidth, globalThis.innerHeight];
}
