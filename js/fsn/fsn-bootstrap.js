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
  fsnEnterConstruct, fsnExitConstruct, fsnInConstruct, fsnDocCount, fsnToggleNodeFullscreen,
  fsnTakeFocus, fsnTakeRecenter, fsnPedestalPan, fsnWorldToPan, fsnWorldBase,
  fsnFromZtoUV, fsnProjectPx, fsnXyToZ,
} from './fsn-substrate.js';
import { mountFsnConsole } from './fsn-console.js';
import { initMosaic, isMosaicFollower } from './fsn-mosaic.js';

// Bridge the ESM shims into Neurite's GLOBAL scope — its core files are classic
// scripts (loaded dynamically by main.js's PageLoad), so they can't `import`.
// Attached unconditionally (cheap; they no-op/return null until fsn is ready).
Object.assign(globalThis, { isFsnActive, isFractalActive, fsnFromZtoUV, fsnProjectPx, fsnXyToZ, fsnHandle, fsnDescendAt, fsnAscend, fsnCurrentPath, fsnPickFileAt, fsnBloomFile, fsnMenuActions, fsnNodeMenuActions, fsnEnterConstruct, fsnExitConstruct, fsnInConstruct, fsnDocCount, fsnToggleNodeFullscreen });

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
  // (the mosaic onRole callback keeps this class in sync after takeovers)

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
  let lastPathSent = '';
  let lastDocsSent = '';
  const activeBoardIdx = () =>
    [...document.querySelectorAll('#board-rows .board-row')].findIndex((r) => r.classList.contains('active'));
  // 8d: the role is DYNAMIC (leader takeover) — consult it live, never capture.
  const isFol = () => (globalThis.fsnMosaic && globalThis.fsnMosaic.state.role) === 'follower';
  const mosaic = initMosaic({
    onRole: (r) => {
      // promotion grows the console chrome; demotion hides it again
      document.documentElement.classList.toggle('fsn-follower', r === 'follower');
    },
    onDocs: (owner, docs) => {
      const dw = globalThis.fsnSetRemoteDocs;
      if (dw) dw(owner, docs);
    },
    onDocRestore: (path) => {
      const r = globalThis.fsnRestoreByPath;
      if (r) r(path);
    },
    onCamera: (m) => {
      const G = globalThis.Graph, h = fsnHandle();
      if (!G || !h) return;
      G.pan.x = m.pan.x; G.pan.y = m.pan.y;
      G.zoom.x = m.zoom.x; G.zoom.y = m.zoom.y;
      if (m.base) { // Stage 5: the epoch travels with the camera
        fsnWorldBase.ox = m.base.ox; fsnWorldBase.oy = m.base.oy; fsnWorldBase.mul = m.base.mul;
      }
      if (h.set_orbit_angles) h.set_orbit_angles(m.yaw, m.pitch);
    },
    onWorld: (m) => {
      const h = fsnHandle();
      if (!h) return;
      if (h.switch_board && m.board >= 0 && m.board !== activeBoardIdx()) h.switch_board(m.board);
      // 8c: converge on the leader's descent path (embed: root = the landscape)
      if (m.curPath && h.enter_path && h.current_path && m.curPath !== h.current_path()) {
        h.enter_path(m.curPath);
      }
    },
    // 8c: the LEADER applies followers' input intents to the single authority;
    // the per-frame camera/world broadcasts reflect them back to every window.
    onInput: (m) => {
      const G = globalThis.Graph, h = fsnHandle();
      if (!G || !h) return;
      if (m.kind === 'orbit') fsnOrbit(m.dx, m.dy);
      else if (m.kind === 'zoom' && m.factor > 0) { G.zoom.x *= m.factor; G.zoom.y *= m.factor; flight = null; }
      else if (m.kind === 'flyTo') flyToPedestal(m.i);
      else if (m.kind === 'flyPan' && m.tp) flyPanTo(m.tp, m.tz || 0.45);
      else if (m.kind === 'enterPath' && m.path && h.enter_path) { h.enter_path(m.path); recenter(); }
    },
  });
  // Stage 5 — Z-SPACE REBASING (truly-infinite depth): float64 exhausts near
  // |zoom| ~ 1e-15, where every z-anchored artifact (nodes, grouped windows,
  // bloom cards) degrades. When |zoom| leaves [1/64, 64] the space renormalizes
  // to unity via T(z) = (z - pan)/s — nodes, anchors and group refs transform
  // with it (pixel-invariant), and the 3D camera keeps absolute continuity
  // through fsnWorldBase (abs = off + rel·mul). The fractal's recenter trick,
  // ported to the whole hybrid.
  const rebaseIfNeeded = () => {
    const G = globalThis.Graph;
    if (!G || !G.pan || !G.zoom) return;
    const s = Math.hypot(G.zoom.x, G.zoom.y);
    if (s > 1 / 64 && s < 64) return;
    const pan = { x: G.pan.x, y: G.pan.y };
    const exp = (globalThis.settings && globalThis.settings.zoomContentExp) || 0.5;
    const nodeScaleK = Math.pow(s, -2 * exp); // keeps Node.draw's rendered size invariant
    if (G.nodes) {
      for (const n of Object.values(G.nodes)) {
        if (!n || !n.pos) continue;
        n.pos.x = (n.pos.x - pan.x) / s; n.pos.y = (n.pos.y - pan.y) / s;
        if (n.anchor && n.anchor.x !== undefined) {
          n.anchor.x = (n.anchor.x - pan.x) / s; n.anchor.y = (n.anchor.y - pan.y) / s;
        }
        if (typeof n.scale === 'number') n.scale *= nodeScaleK;
      }
    }
    if (globalThis.fsnRebaseDocState) globalThis.fsnRebaseDocState(pan, s);
    G.zoom.x /= s; G.zoom.y /= s;
    G.pan.x = 0; G.pan.y = 0;
    fsnWorldBase.ox += pan.x * fsnWorldBase.mul;
    fsnWorldBase.oy += pan.y * fsnWorldBase.mul;
    fsnWorldBase.mul *= s;
    flight = null; // a flight's from/to snapshots are epoch-bound
    globalThis.__fsnRebases = (globalThis.__fsnRebases || 0) + 1;
    console.log('[fsn] z-rebase s=' + s.toFixed(5) + ' mul=' + fsnWorldBase.mul.toExponential(2));
  };
  const loop = (now) => {
    globalThis.__fsnFrames = (globalThis.__fsnFrames || 0) + 1; // loop liveness (debug)
    rebaseIfNeeded();
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
          mosaic.broadcastCamera({ x: G.pan.x, y: G.pan.y }, { x: G.zoom.x, y: G.zoom.y }, yaw, pitch,
            { ox: fsnWorldBase.ox, oy: fsnWorldBase.oy, mul: fsnWorldBase.mul });
        }
        const b = activeBoardIdx();
        const cp = h.current_path ? h.current_path() : '';
        if ((b !== lastBoardSent && b >= 0) || cp !== lastPathSent) {
          lastBoardSent = b; lastPathSent = cp;
          mosaic.broadcastWorld(b, cp);
        }
        // 8d: share this window's document state when it changes (chips mirror)
        const dsj = globalThis.fsnDocsStateJson ? globalThis.fsnDocsStateJson() : '';
        if (dsj && dsj !== lastDocsSent) { lastDocsSent = dsj; mosaic.broadcastDocs(JSON.parse(dsj)); }
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
  // REAL events land on Neurite's full-viewport #svg_bg, which sits ABOVE the
  // fsn canvas — canvas-scoped listeners never fire for actual input (found
  // 2026-08-16 with Input.dispatchMouseEvent; synthetic canvas-targeted events
  // had masked it). So: listen at WINDOW level and claim only BACKGROUND
  // presses by target — presses on nodes / panel / labels target those elements
  // and are ignored here. Neurite's own camera-drag is gated at the source
  // (interface.js onMouseDown, fsnOwnsCamera), so no propagation games.
  // An INERT document window is background as far as the camera is concerned:
  // its frame ignores the pointer, so a drag across it must orbit the world
  // rather than die on the window (the iframe used to swallow it entirely).
  // The bar stays excluded — that is the window's own drag handle.
  const isInertDoc = (t) => {
    const w = t && t.closest && t.closest('.fsn-docwin');
    return !!w && !w.classList.contains('content-active') && !(t.closest('.dw-bar'));
  };
  const isBackground = (t) => t === canvas || (t && t.id === 'svg_bg') || t === document.body || isInertDoc(t);
  // Neurite's zoom listens on the SVG element (On.wheel(svg,...)), and a wheel
  // over a doc window's <section> — a SIBLING of the svg — never reaches it, so
  // zoom died over windows even after drags learned to pass through. Forward
  // the wheel from an INERT window to the svg; an armed (reading) window keeps
  // its wheel for scrolling the document.
  addEventListener('wheel', (e) => {
    if (!isInertDoc(e.target)) return;
    const svg = document.getElementById('svg_bg');
    if (!svg) return;
    e.preventDefault();
    svg.dispatchEvent(new WheelEvent('wheel', e));
  }, { capture: true, passive: false });
  let orbiting = false, btn = 0, moved = 0, px0 = 0, py0 = 0, lx = 0, ly = 0;
  let pendingFileZoom = 0; // single-click file-zoom, cancelled by dblclick-open
  // TOUCH: pointers on the background are tracked for gestures — one finger
  // orbits (same path as mouse drag), TWO fingers pinch-zoom the z-camera at
  // the pinch midpoint (the phone's wheel). Mouse buttons flow through the
  // same handlers (pointer events unify them).
  const bgPointers = new Map(); // pointerId -> {x, y}
  let pinch = null;             // { d0 } while two background pointers are down
  const zoomAtPoint = (cx, cy, factor) => {
    const G = globalThis.Graph;
    if (!G || !G.xyToZ) return;
    const z = G.xyToZ(cx, cy);
    // keep the z under the fingers fixed: pan' = z + (pan - z) * factor
    G.zoom.x *= factor; G.zoom.y *= factor;
    G.pan.x = z.x + (G.pan.x - z.x) * factor;
    G.pan.y = z.y + (G.pan.y - z.y) * factor;
  };
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (isBackground(e.target) && globalThis.fsnDisarmContent) globalThis.fsnDisarmContent();
    if (!isBackground(e.target)) return;
    bgPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Drag-THROUGH (user-directed 2026-08-17): capture the pointer on the
    // background element so the orbit keeps receiving events even when the
    // drag crosses an open document window — iframes otherwise swallow the
    // pointer stream and the motion stalls mid-gesture.
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* non-element target */ }
    if (bgPointers.size === 2) { // second finger: orbit ends, pinch begins
      orbiting = false;
      const [a, b] = [...bgPointers.values()];
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) };
      flight = null;
      return;
    }
    orbiting = true; btn = e.button; moved = 0;
    px0 = lx = e.clientX; py0 = ly = e.clientY;
    flight = null; // user input interrupts a camera flight
  });
  addEventListener('pointermove', (e) => {
    if (bgPointers.has(e.pointerId)) bgPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && bgPointers.size >= 2) {
      const [a, b] = [...bgPointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 20 && pinch.d0 > 20) {
        if (isFol()) mosaic.sendInput({ kind: 'zoom', factor: pinch.d0 / d });
        else zoomAtPoint((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.d0 / d);
        pinch.d0 = d;
      }
      return;
    }
    if (!orbiting) return;
    if (isFol()) mosaic.sendInput({ kind: 'orbit', dx: (e.clientX - lx) * dpr, dy: (e.clientY - ly) * dpr });
    else fsnOrbit((e.clientX - lx) * dpr, (e.clientY - ly) * dpr);
    lx = e.clientX; ly = e.clientY;
    // displacement from the PRESS (not summed jitter — a wobbly click stays a click)
    moved = Math.max(moved, Math.hypot(e.clientX - px0, e.clientY - py0));
  });
  const endPointer = (e) => {
    bgPointers.delete(e.pointerId);
    if (bgPointers.size < 2) pinch = null;
  };
  addEventListener('pointercancel', endPointer);
  addEventListener('pointerup', (e) => {
    endPointer(e);
    if (!orbiting) return;
    orbiting = false;
    // a left press that never really moved is a CLICK → fly to what's under it:
    // a directory pedestal flies to the dir; a FILE zooms in close on the file
    // (user-directed 2026-08-16: "single clicking on files should zoom them to
    // view"). Double-click still OPENS the file as a document window.
    // Fingers wobble more than mice — a looser tap tolerance on touch.
    if (btn === 0 && moved < (e.pointerType === 'touch' ? 12 : 6)) {
      const h = fsnHandle();
      const i = h && h.pick_at ? h.pick_at(e.clientX * dpr, e.clientY * dpr) : -1;
      if (i >= 0 && e.detail < 2) {
        // DELAYED like the file zoom: the first click of a floor DOUBLE-click
        // (descend) must not start the fly, or the floor moves out from under
        // the second click. openAt cancels this on open/descend.
        clearTimeout(pendingFileZoom);
        pendingFileZoom = setTimeout(() => {
          if (isFol()) mosaic.sendInput({ kind: 'flyTo', i });
          else flyToPedestal(i);
        }, 280);
      } else if (h && h.pick_file_at && e.detail < 2) {
        // DELAYED so a double-click (open) isn't sabotaged: the first click of a
        // dblclick must NOT start the fly, or the file moves out from under the
        // second click. Cancelled by the dblclick handler below.
        const fj = h.pick_file_at(e.clientX * dpr, e.clientY * dpr);
        if (fj) {
          try {
            const f = JSON.parse(fj);
            clearTimeout(pendingFileZoom);
            pendingFileZoom = setTimeout(() => {
              if (isFol()) mosaic.sendInput({ kind: 'flyPan', tp: fsnWorldToPan(f.x, f.z), tz: 0.18 });
              else flyPanTo(fsnWorldToPan(f.x, f.z), 0.18);
            }, 280);
          } catch (err) { /* unparseable pick — ignore */ }
        }
      }
    }
    // a right-DRAG is an orbit, not a menu request — Neurite opens its menu on
    // mouseup regardless, so close it right after
    if (btn === 2 && moved >= 6) requestAnimationFrame(() => {
      const M = globalThis.App && globalThis.App.menuContext; if (M) M.hide();
    });
  });
  // Followers forward wheel-zoom (Neurite's local zoom + the broadcast stomp
  // feels dead). Registered ALWAYS, gated by LIVE role — takeover flips it.
  addEventListener('wheel', (e) => {
    if (!isFol()) return;
    e.stopPropagation();
    mosaic.sendInput({ kind: 'zoom', factor: Math.exp(e.deltaY * 0.0009) });
  }, { capture: true, passive: true });
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
  // The OPEN gesture (mouse double-click AND touch double-tap): a floor descends,
  // a file opens as a document window.
  const openAt = (x, y) => {
    clearTimeout(pendingFileZoom); // opening — don't also fly
    const path = fsnDescendAt(x, y, dpr);
    if (path) {
      recenter();
      if (isFol()) mosaic.sendInput({ kind: 'enterPath', path }); // 8c: all windows descend
      console.log('[fsn] descended ->', path);
      return true;
    }
    const fileJson = fsnPickFileAt(x, y, dpr);
    if (fileJson) { fsnBloomFile(fileJson); console.log('[fsn] bloomed', fileJson); return true; }
    return false;
  };
  addEventListener('dblclick', (e) => { openAt(e.clientX, e.clientY); });
  // Menu surface (right-click "Expand tower"): enter a directory path with the
  // same semantics as the open gesture — local view + mosaic sync + recenter.
  // Right-click focus (user-directed 2026-08-18): the clicked target eases
  // toward the camera while its context menu is up. Role-aware (mosaic).
  globalThis.fsnFlyFocus = (t) => {
    if (t && typeof t.ped === 'number') {
      if (isFol()) mosaic.sendInput({ kind: 'flyTo', i: t.ped });
      else flyToPedestal(t.ped);
    } else if (t && t.file) {
      const tp = fsnWorldToPan(t.file.x, t.file.z);
      if (isFol()) mosaic.sendInput({ kind: 'flyPan', tp, tz: 0.22 });
      else flyPanTo(tp, 0.22);
    }
  };
  globalThis.fsnEnterPathSynced = (path) => {
    const h = fsnHandle();
    if (!h || !h.enter_path || !path) return '';
    const r = h.enter_path(path);
    if (r) {
      recenter();
      if (isFol()) mosaic.sendInput({ kind: 'enterPath', path: r });
    }
    return r;
  };
  // Touch LONG-PRESS = the right-click menu (phones have no right-click; the
  // entire fsn action surface — Expand documents, Open, Construct — was
  // desktop-only). 550ms hold, <10px drift; the release is swallowed so the
  // menu isn't instantly dismissed by its own gesture.
  let lp = null; // { t, x, y }
  let lpSwallow = false;
  addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (e.target && e.target.closest && e.target.closest('#tree, .fsn-docwin, .fsn-dockchip, #reader, #ctxmenu, #login, #fsn-topbar, button, input')) return;
    lp = { x: e.clientX, y: e.clientY, t: setTimeout(() => {
      lpSwallow = true;
      // the release's COMPAT mouse events (mousedown fires after touchend and
      // Neurite hides the menu on any non-right mousedown) must die at the
      // source: preventDefault on the touchend cancels compat generation.
      addEventListener('touchend', (te) => { te.preventDefault(); }, { capture: true, once: true, passive: false });
      const target = document.elementFromPoint(lp.x, lp.y) || document.body;
      const M = globalThis.App && globalThis.App.menuContext;
      if (M) M.open(lp.x, lp.y, target);
    }, 550) };
  });
  addEventListener('pointermove', (e) => {
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) { clearTimeout(lp.t); lp = null; }
  });
  addEventListener('pointerup', (e) => {
    if (lp) { clearTimeout(lp.t); lp = null; }
    if (lpSwallow) {
      // the finger lifting off after the menu opened must not click-through
      const swallowClick = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      addEventListener('click', swallowClick, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallowClick, { capture: true }), 400);
      lpSwallow = false;
    }
  }, true);
  addEventListener('pointercancel', () => { if (lp) { clearTimeout(lp.t); lp = null; } });

  // Touch DOUBLE-TAP = the same open gesture (browsers don't synthesize dblclick
  // once touch-action is none). Window-level like the dblclick listener — a tap
  // often lands on a LABEL chip riding the file box, not the background — with
  // console UI surfaces excluded (they own their tap semantics).
  let lastTap = { t: 0, x: 0, y: 0 };
  addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    if (e.target && e.target.closest && e.target.closest('#tree, .fsn-docwin, .fsn-dockchip, #reader, #ctxmenu, #login, button, input')) {
      lastTap.t = 0;
      return;
    }
    const now = performance.now();
    if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      lastTap = { t: 0, x: 0, y: 0 };
      openAt(e.clientX, e.clientY);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !/^(INPUT|TEXTAREA)$/.test(e.target && e.target.tagName || '')) {
      const path = fsnAscend(); // embed: console root re-builds the LANDSCAPE
      if (path) {
        e.preventDefault(); recenter();
        if (isFol()) mosaic.sendInput({ kind: 'enterPath', path });
        console.log('[fsn] ascended ->', path);
      }
    }
  });

  console.log('[fsn] substrate active — landscape mounted behind the node layer');
  return canvas;
}

// Auto-boot when this module is loaded (no-ops unless ?substrate=fsn is set).
bootFsnSubstrate();
