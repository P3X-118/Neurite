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

/** True when fsn is the active substrate (feature flag). Off => fractal, unchanged. */
export function isFsnActive() {
  return (
    fsn !== null &&
    (globalThis.FSN_SUBSTRATE === true ||
      new URLSearchParams(location.search).get('substrate') === 'fsn')
  );
}

/** One-time init: bind fsn to a canvas layered under Neurite's #nodes overlay. */
export async function initFsnSubstrate(canvas) {
  await init(wasmUrl);
  fsn = await FsnEmbed.create(canvas);
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
}

/** Feed Neurite's pan/zoom input to fsn's orbit camera. */
export function fsnOrbit(dx, dy) {
  if (fsn) fsn.orbit(dx, dy);
}
export function fsnZoom(delta) {
  if (fsn) fsn.zoom(delta);
}
export function fsnResize(wPx, hPx) {
  if (fsn) fsn.resize(wPx, hPx);
}

function fsnBufferSize() {
  const c = document.getElementById('fsn-canvas');
  return c ? [c.width, c.height] : [globalThis.innerWidth, globalThis.innerHeight];
}
