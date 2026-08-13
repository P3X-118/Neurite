// Additive bootstrap: when the fsn substrate flag is on, mount an fsn canvas as
// the background layer and start rendering it. Non-invasive — imports cleanly and
// does NOTHING unless `?substrate=fsn` (or window.FSN_SUBSTRATE=true) is set, so
// the fractal build is byte-for-byte unaffected when off.
//
// The node-placement + camera-input swaps are the documented core edits (README);
// this file gets the fsn landscape drawing so those edits have something to ride on.

import {
  isFsnActive, isFractalActive, initFsnSubstrate, fsnStep, fsnDriveView, fsnOrbit, fsnZoom, fsnResize,
  fsnDescendAt, fsnAscend, fsnCurrentPath, fsnHandle,
  fsnFromZtoUV, fsnProjectPx, fsnXyToZ,
} from './fsn-substrate.js';

// Bridge the ESM shims into Neurite's GLOBAL scope — its core files are classic
// scripts (loaded dynamically by main.js's PageLoad), so they can't `import`.
// Attached unconditionally (cheap; they no-op/return null until fsn is ready).
Object.assign(globalThis, { isFsnActive, isFractalActive, fsnFromZtoUV, fsnProjectPx, fsnXyToZ, fsnHandle, fsnDescendAt, fsnAscend, fsnCurrentPath });

// IRIX frame: stamp `html.irix` when fsn is the substrate so the scoped IRIX
// theme stylesheet (js/fsn/irix.css) cleanly takes over Neurite's chrome —
// a single structural toggle, not per-element style hacks.
if (isFsnActive()) document.documentElement.classList.add('irix');

// The fractal is FUNCTIONALLY DISABLED (not CSS-hidden) when fsn is the substrate:
// the render loop skips it (js/nodes/nodeinteraction/nodestep.js) and any startup
// render is gated too, so no fractal compute runs — nothing to hide.

export async function bootFsnSubstrate() {
  if (!isFsnActive()) return null;

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

  await initFsnSubstrate(canvas);

  // Own render loop for the substrate (the node layer's placement is swapped
  // separately, in Node.draw — see README).
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    fsnDriveView(); // Design B: fsn camera tracks Graph.pan/zoom
    autoDescend();  // zoom-threshold descent (continuous infinite-zoom into the structure)
    fsnStep(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Design B: Neurite owns left-drag (pan) + wheel (infinite zoom) — they mutate
  // Graph.pan/zoom, and fsn's camera tracks them via fsnDriveView() in the loop.
  // fsn's own orbit (rotate the current structure) rides RIGHT-drag so it can't
  // fight Neurite's pan.
  let orbiting = false, lx = 0, ly = 0;
  addEventListener('pointerdown', (e) => { if (e.button === 2) { orbiting = true; lx = e.clientX; ly = e.clientY; } });
  addEventListener('pointermove', (e) => {
    if (!orbiting) return;
    fsnOrbit((e.clientX - lx) * dpr, (e.clientY - ly) * dpr);
    lx = e.clientX; ly = e.clientY;
  });
  addEventListener('pointerup', () => { orbiting = false; });
  addEventListener('contextmenu', (e) => { if (orbiting) e.preventDefault(); });
  addEventListener('resize', () => { sizeBuffer(); fsnResize(canvas.width, canvas.height); });

  // Design B descent: a left-CLICK (no drag) on a floor re-roots the tower onto that
  // subfolder; Backspace ascends. Camera is Graph-driven, so recenter pan on the new
  // tower (which build_level always places at the origin). fly-by-wire framing.
  const recenter = () => { const G = globalThis.Graph; if (G && G.pan) { G.pan.x = 0; G.pan.y = 0; } };
  // Zoom-threshold AUTO-descend: wheel-zoom TOWARD a floor (Neurite zooms at the cursor)
  // past DESCEND_ZOOM re-roots the tower onto it, then rebases zoom to the new tower's
  // overview so you can keep zooming down — a continuous, stepped infinite-zoom descent.
  // (Seamless re-basing is Stage 5; this is the stepped version.)
  let curX = innerWidth / 2, curY = innerHeight / 2;
  addEventListener('pointermove', (e) => { curX = e.clientX; curY = e.clientY; });
  const DESCEND_ZOOM = 0.3;
  const autoDescend = () => {
    const G = globalThis.Graph;
    if (!G || !G.zoom || Math.hypot(G.zoom.x, G.zoom.y) > DESCEND_ZOOM) return;
    const path = fsnDescendAt(curX, curY, dpr);
    if (path) { G.pan.x = 0; G.pan.y = 0; G.zoom.x = 1; G.zoom.y = 0; console.log('[fsn] zoom-descend ->', path); }
  };
  let dX = 0, dY = 0, dT = 0;
  addEventListener('pointerdown', (e) => { if (e.button === 0) { dX = e.clientX; dY = e.clientY; dT = performance.now(); } });
  addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - dX, e.clientY - dY) > 6 || performance.now() - dT > 500) return; // drag/hold, not a click
    const path = fsnDescendAt(e.clientX, e.clientY, dpr);
    if (path) { recenter(); console.log('[fsn] descended ->', path); }
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
