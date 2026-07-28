// Additive bootstrap: when the fsn substrate flag is on, mount an fsn canvas as
// the background layer and start rendering it. Non-invasive — imports cleanly and
// does NOTHING unless `?substrate=fsn` (or window.FSN_SUBSTRATE=true) is set, so
// the fractal build is byte-for-byte unaffected when off.
//
// The node-placement + camera-input swaps are the documented core edits (README);
// this file gets the fsn landscape drawing so those edits have something to ride on.

import {
  isFsnActive, isFractalActive, initFsnSubstrate, fsnStep, fsnOrbit, fsnZoom, fsnResize,
  fsnFromZtoUV, fsnProjectPx, fsnXyToZ,
} from './fsn-substrate.js';

// Bridge the ESM shims into Neurite's GLOBAL scope — its core files are classic
// scripts (loaded dynamically by main.js's PageLoad), so they can't `import`.
// Attached unconditionally (cheap; they no-op/return null until fsn is ready).
Object.assign(globalThis, { isFsnActive, isFractalActive, fsnFromZtoUV, fsnProjectPx, fsnXyToZ });

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
    fsnStep(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Route drag/wheel to fsn's orbit camera (until Neurite's own camera input is
  // rewired per the README).
  let dragging = false, lx = 0, ly = 0;
  addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    fsnOrbit((e.clientX - lx) * dpr, (e.clientY - ly) * dpr);
    lx = e.clientX; ly = e.clientY;
  });
  addEventListener('pointerup', () => { dragging = false; });
  addEventListener('wheel', (e) => fsnZoom(-e.deltaY * 0.01), { passive: true });
  addEventListener('resize', () => { sizeBuffer(); fsnResize(canvas.width, canvas.height); });

  console.log('[fsn] substrate active — landscape mounted behind the node layer');
  return canvas;
}

// Auto-boot when this module is loaded (no-ops unless ?substrate=fsn is set).
bootFsnSubstrate();
