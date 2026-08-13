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
import wasmUrl from './pkg/fsn_bg.wasm?url'; // Vite: resolves to the served asset URL

// Neurite world units are ~O(1) around the origin; fsn's landscape spans tens of
// units. This bridges the two — TUNE against the running app.
const WORLD_SCALE = 12.0;

let fsn = null;

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

/** One-time init: bind fsn to a canvas layered under Neurite's #nodes overlay. */
export async function initFsnSubstrate(canvas) {
  await init(wasmUrl);
  fsn = await FsnEmbed.create_live(canvas);
  return fsn;
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
  fsnUpdateWires(); // Design B Stage 4b: keep bloomed-node -> tower wires attached
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
  return fsn.descend(i);
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
let bloomWires = []; // { node, fx, fy, fz }

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
  bloomWires = bloomWires.filter(w => w.node && !w.node.removed && w.node.content && document.body.contains(w.node.content));
  const el = document.getElementById('fsn-wires');
  if (bloomWires.length === 0) { if (el) el.replaceChildren(); return; }
  const svg = fsnWiresSvg();
  const c = document.getElementById('fsn-canvas');
  const rx = c && c.width ? c.clientWidth / c.width : 1, ry = c && c.height ? c.clientHeight / c.height : 1;
  while (svg.children.length > bloomWires.length) svg.removeChild(svg.lastChild);
  while (svg.children.length < bloomWires.length) {
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('stroke', '#5fe6d0'); ln.setAttribute('stroke-width', '1.5');
    ln.setAttribute('stroke-opacity', '0.65'); ln.setAttribute('stroke-dasharray', '5 4');
    svg.appendChild(ln);
  }
  bloomWires.forEach((w, i) => {
    const ln = svg.children[i];
    const p = fsn.project(w.fx, w.fy, w.fz); // file box -> physical px (or undefined: behind cam)
    const r = w.node.content.getBoundingClientRect();
    if (p && r.width > 0) {
      ln.setAttribute('x1', p[0] * rx); ln.setAttribute('y1', p[1] * ry);
      ln.setAttribute('x2', r.x + r.width / 2); ln.setAttribute('y2', r.y + r.height / 2);
      ln.style.display = '';
    } else {
      ln.style.display = 'none';
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
export function fsnToggleNodeFullscreen(node) {
  const G = globalThis.Graph;
  if (!node || !G || !G.pan || !G.zoom) return;
  if (!fsFullscreenSaved) {
    fsFullscreenSaved = { px: G.pan.x, py: G.pan.y, zx: G.zoom.x, zy: G.zoom.y };
    const A = globalThis.NeuriteAnimation; // Neurite's Animation class (globalThis.Animation is the DOM built-in)
    if (A && A.zoomToNodeTitle) A.zoomToNodeTitle(node, 1.0);
  } else {
    const v = fsFullscreenSaved; fsFullscreenSaved = null;
    if (globalThis.Autopilot && globalThis.Autopilot.reset) globalThis.Autopilot.reset();
    G.pan.x = v.px; G.pan.y = v.py; G.zoom.x = v.zx; G.zoom.y = v.zy;
  }
}

export function fsnBloomFile(fileJson) {
  if (!fsn || typeof globalThis.createTextNodeWithPosAndScale !== 'function') return null;
  let f; try { f = JSON.parse(fileJson); } catch { return null; }
  const c = document.getElementById('fsn-canvas');
  const rx = c && c.width ? c.clientWidth / c.width : 1, ry = c && c.height ? c.clientHeight / c.height : 1;
  const G = globalThis.Graph;
  const sp = fsn.project(f.x, f.y, f.z); // [sx,sy] physical px, or undefined (behind camera)
  // Bloom just above the file box, CLAMPED so the ~130px node stays fully on-screen (top-floor
  // files sit near the top edge). Map that screen point to z-space with Neurite's OWN inverse
  // (Graph.xyToZ = inverse of Node.draw's fromZtoUV) so it lands there + passes draw()'s
  // visibility gate. (fsn.unproject_ground is a DIFFERENT ground-plane transform -> off-screen.)
  let sx, sy;
  if (sp) { sx = sp[0] * rx + 100; sy = sp[1] * ry - 40; } // up-and-right: wire reads as a diagonal
  else { sx = window.innerWidth / 2; sy = window.innerHeight / 2; }
  sx = Math.max(90, Math.min(window.innerWidth - 90, sx));
  sy = Math.max(80, Math.min(window.innerHeight - 90, sy));
  const z = (G && G.xyToZ) ? G.xyToZ(sx, sy) : (G && G.pan ? { x: G.pan.x, y: G.pan.y } : { x: 0, y: 0 });
  const scale = (G && G.zoom) ? Math.hypot(G.zoom.x, G.zoom.y) * 0.5 : 0.5;
  const content = '# ' + f.name + '\n\n`' + (f.path || '') + '`\n\n_(content loads from FileBrowser at the jp deploy; placeholder at hal)_';
  const node = globalThis.createTextNodeWithPosAndScale(f.name, content, scale, z.x, z.y);
  if (node && node.draw) node.draw();
  if (node) {
    bloomWires.push({ node, fx: f.x, fy: f.y, fz: f.z }); // keep it wired to the tower (fsnStep)
    if (node.content) node.content.addEventListener('dblclick', (ev) => {
      ev.stopPropagation(); fsnToggleNodeFullscreen(node); // easy full-screen / exit toggle
    });
  }
  return node;
}

function fsnBufferSize() {
  const c = document.getElementById('fsn-canvas');
  return c ? [c.width, c.height] : [globalThis.innerWidth, globalThis.innerHeight];
}
