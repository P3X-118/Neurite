// Additive bootstrap: when the fsn substrate flag is on, mount an fsn canvas as
// the background layer and start rendering it. Non-invasive — imports cleanly and
// does NOTHING unless `?substrate=fsn` (or window.FSN_SUBSTRATE=true) is set, so
// the fractal build is byte-for-byte unaffected when off.
//
// The node-placement + camera-input swaps are the documented core edits (README);
// this file gets the fsn landscape drawing so those edits have something to ride on.

import {
  isFsnActive, isFractalActive, initFsnSubstrate, fsnStep, fsnDriveView, fsnOrbit, fsnZoom, fsnResize,
  fsnDescendAt, fsnAscend, fsnCurrentPath, fsnHandle, fsnPickFileAt, fsnBloomFile, fsnMenuActions, fsnNodeMenuActions,
  fsnEnterConstruct, fsnExitConstruct, fsnInConstruct,
  fsnTakeFocus, fsnTakeRecenter, fsnPedestalPan,
  fsnFromZtoUV, fsnProjectPx, fsnXyToZ,
} from './fsn-substrate.js';
import { mountFsnConsole } from './fsn-console.js';
import { initMosaic, isMosaicFollower } from './fsn-mosaic.js';

// Bridge the ESM shims into Neurite's GLOBAL scope — its core files are classic
// scripts (loaded dynamically by main.js's PageLoad), so they can't `import`.
// Attached unconditionally (cheap; they no-op/return null until fsn is ready).
Object.assign(globalThis, { isFsnActive, isFractalActive, fsnFromZtoUV, fsnProjectPx, fsnXyToZ, fsnHandle, fsnDescendAt, fsnAscend, fsnCurrentPath, fsnPickFileAt, fsnBloomFile, fsnMenuActions, fsnNodeMenuActions, fsnEnterConstruct, fsnExitConstruct, fsnInConstruct });

// IRIX frame: stamp `html.irix` when fsn is the substrate so the scoped IRIX
// theme stylesheet (js/fsn/irix.css) cleanly takes over Neurite's chrome —
// a single structural toggle, not per-element style hacks.
if (isFsnActive()) document.documentElement.classList.add('irix');

// The fractal is FUNCTIONALLY DISABLED (not CSS-hidden) when fsn is the substrate:
// the render loop skips it (js/nodes/nodeinteraction/nodestep.js) and any startup
// render is gated too, so no fractal compute runs — nothing to hide.

export async function bootFsnSubstrate() {
  if (!isFsnActive()) return null;

  // The fsn CONSOLE shell (panel/labels/reader markup + CSS + chrome script)
  // must exist BEFORE create_console — the Rust web_ui binds to these ids.
  await mountFsnConsole();
  // Stage 8: an auxiliary mosaic window renders the landscape only — the
  // console chrome hides (CSS on html.fsn-follower); the leader keeps the panel.
  if (isMosaicFollower()) document.documentElement.classList.add('fsn-follower');

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.id = 'fsn-canvas';
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    zIndex: '0', // behind Neurite's #nodes / edges overlay
    display: 'block',
  });
  const sizeBuffer = () => {
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
  };
  sizeBuffer();
  document.body.insertBefore(canvas, document.body.firstChild);

  await initFsnSubstrate(canvas, { console: true });

  // Own render loop for the substrate (the node layer's placement is swapped
  // separately, in Node.draw — see README).
  let last = performance.now();
  // Camera flights: the panel's fly-to (tree row / board switch / by-ref) eases
  // the CAMERA AUTHORITY (Graph.pan/zoom) — fsn stays slaved via fsnDriveView,
  // exactly the standalone feel (click → fly, Esc → overview) in z-space.
  let flight = null; // { t0, dur, fp:{x,y}, tp:{x,y}, fz, tz }
  const zoomMag = () => { const G = globalThis.Graph; return G ? Math.hypot(G.zoom.x, G.zoom.y) : 1; };
  const flyPanTo = (tp, tzMag) => {
    const G = globalThis.Graph;
    if (!G || !tp) return;
    flight = { t0: performance.now(), dur: 900, fp: { x: G.pan.x, y: G.pan.y }, tp, fz: zoomMag(), tz: tzMag };
  };
  const stepFlight = (now) => {
    const G = globalThis.Graph;
    if (!flight || !G) return;
    let t = (now - flight.t0) / flight.dur;
    if (t >= 1) t = 1;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad
    G.pan.x = flight.fp.x + (flight.tp.x - flight.fp.x) * e;
    G.pan.y = flight.fp.y + (flight.tp.y - flight.fp.y) * e;
    const m = flight.fz + (flight.tz - flight.fz) * e;
    const cur = zoomMag() || 1; // rescale, preserving zoom rotation
    G.zoom.x *= m / cur; G.zoom.y *= m / cur;
    if (t >= 1) flight = null;
  };
  const flyToPedestal = (i) => { const tp = fsnPedestalPan(i); if (tp) flyPanTo(tp, 0.45); };
  const flyOverview = () => flyPanTo({ x: 0, y: 0 }, 1.0);

  // Stage 8 mosaic: shared world, N viewports. The leader broadcasts the camera
  // + board; followers adopt them and every window renders its own off-axis
  // sub-rect of the union desktop area (fsnMosaic.mosaicRect -> set_mosaic_rect).
  let lastBoardSent = -1;
  const activeBoardIdx = () =>
    [...document.querySelectorAll('#board-rows .board-row')].findIndex((r) => r.classList.contains('active'));
  const mosaic = initMosaic({
    onCamera: (m) => {
      const G = globalThis.Graph, h = fsnHandle();
      if (!G || !h) return;
      G.pan.x = m.pan.x; G.pan.y = m.pan.y;
      G.zoom.x = m.zoom.x; G.zoom.y = m.zoom.y;
      if (h.set_orbit_angles) h.set_orbit_angles(m.yaw, m.pitch);
    },
    onWorld: (m) => {
      const h = fsnHandle();
      if (h && h.switch_board && m.board >= 0 && m.board !== activeBoardIdx()) h.switch_board(m.board);
    },
  });
  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const fi = fsnTakeFocus();          // panel fly-to → ease Graph there
    if (fi >= 0) flyToPedestal(fi);
    if (fsnTakeRecenter()) flyOverview(); // board switch → overview
    stepFlight(now);
    fsnDriveView(); // Design B: fsn camera tracks Graph.pan/zoom
    { // Stage 8 mosaic duties
      const G = globalThis.Graph, h = fsnHandle();
      if (G && h) {
        mosaic.applyMosaicRect(h);
        if (h.orbit_angles) {
          const [yaw, pitch] = h.orbit_angles();
          mosaic.broadcastCamera({ x: G.pan.x, y: G.pan.y }, { x: G.zoom.x, y: G.zoom.y }, yaw, pitch);
        }
        const b = activeBoardIdx();
        if (b !== lastBoardSent && b >= 0) { lastBoardSent = b; mosaic.broadcastWorld(b); }
      }
    }
    fsnStep(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // CONSOLE CONTROLS — standalone-app parity (the 2026-08-14 regression fix):
  // LEFT-drag = orbit (stopPropagation so Neurite never pans on it), wheel =
  // zoom (Neurite's infinite z-zoom), click dir = fly, Esc = overview. Right-drag
  // also orbits (kept from Design B dev).
  let orbiting = false, moved = 0, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    orbiting = true; moved = 0; lx = e.clientX; ly = e.clientY;
    flight = null;               // user input interrupts a flight
    e.stopPropagation();         // keep Neurite's pan/node-create off left-drag
  });
  addEventListener('pointerdown', (e) => { if (e.button === 2) { orbiting = true; moved = 0; lx = e.clientX; ly = e.clientY; } });
  addEventListener('pointermove', (e) => {
    if (!orbiting) return;
    moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
    fsnOrbit((e.clientX - lx) * dpr, (e.clientY - ly) * dpr);
    lx = e.clientX; ly = e.clientY;
  });
  addEventListener('pointerup', (e) => {
    if (!orbiting) return;
    orbiting = false;
    // a left press that never dragged is a CLICK → fly to the dir under it
    if (e.button === 0 && moved < 6) {
      const h = fsnHandle();
      const i = h && h.pick_at ? h.pick_at(e.clientX * dpr, e.clientY * dpr) : -1;
      if (i >= 0) flyToPedestal(i);
    }
  });
  addEventListener('wheel', () => { flight = null; }, { passive: true });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !fsnInConstruct() && !/^(INPUT|TEXTAREA)$/.test(e.target && e.target.tagName || '')) {
      flyOverview(); // standalone parity: Esc returns to the overview
    }
  });
  addEventListener('contextmenu', (e) => { if (orbiting) e.preventDefault(); });
  addEventListener('resize', () => { sizeBuffer(); fsnResize(canvas.width, canvas.height); });

  // Design B descent: a left-CLICK (no drag) on a floor re-roots the tower onto that
  // subfolder; Backspace ascends. Camera is Graph-driven, so recenter pan on the new
  // tower (which build_level always places at the origin). fly-by-wire framing.
  const recenter = () => { const G = globalThis.Graph; if (G && G.pan) { G.pan.x = 0; G.pan.y = 0; } };
  // Option C: wheel-zoom is free "approach" (no auto-descend — Neurite's 2D zoom does not
  // cleanly select a vertical floor). Descent is a DELIBERATE double-click on a floor
  // (subfolder) → re-roots the tower onto it. (File double-click → the bloom, Stage 4b.)
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fsnInConstruct()) { e.preventDefault(); e.stopPropagation(); fsnExitConstruct(); }
  }, true);
  addEventListener('dblclick', (e) => {
    const path = fsnDescendAt(e.clientX, e.clientY, dpr);
    if (path) { recenter(); console.log('[fsn] descended ->', path); return; }
    const fileJson = fsnPickFileAt(e.clientX, e.clientY, dpr);
    if (fileJson) { fsnBloomFile(fileJson); console.log('[fsn] bloomed', fileJson); }
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !/^(INPUT|TEXTAREA)$/.test(e.target && e.target.tagName || '')) {
      const path = fsnAscend();
      if (path) { e.preventDefault(); recenter(); console.log('[fsn] ascended ->', path); }
    }
  });

  console.log('[fsn] substrate active — landscape mounted behind the node layer');
  return canvas;
}

// Auto-boot when this module is loaded (no-ops unless ?substrate=fsn is set).
bootFsnSubstrate();
