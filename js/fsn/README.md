# fsn substrate for Neurite

Replaces Neurite's Mandelbrot fractal with the **fsn** 3D filesystem landscape as the
spatial substrate the node/graph layer rides on. fsn is a Rust/wasm/wgpu app
(`~/apps/IRIX`) built as an embeddable library (`FsnEmbed`); its wasm is vendored in
`./pkg` here.

## Files
- `pkg/` — vendored `FsnEmbed` wasm (build: `cd ~/apps/IRIX && wasm-pack build --target web
  --out-dir <this>/pkg`). Regenerate when fsn changes.
- `fsn-substrate.js` — the transform-contract shims over `FsnEmbed` + the `isFsnActive()` flag.
- `fsn-bootstrap.js` — additive: mounts the fsn canvas + render loop when the flag is on.
  Does nothing when off (fractal build unchanged).

## Activate
`?substrate=fsn` in the URL, or `window.FSN_SUBSTRATE = true` before boot. Then call
`bootFsnSubstrate()` once (e.g. from `js/main.js` `App.init`).

## Status
Engine + shims land and build. `bootFsnSubstrate()` renders the fsn landscape behind the node
layer. **The three core seams below are the remaining in-place swap** — each is gated so the
fractal path is untouched when the flag is off. `WORLD_SCALE` (in `fsn-substrate.js`) and the
ground-plane mapping need live tuning against the running app.

## The three core seams to swap (mapped from Neurite source)
The node layer consumes the substrate through exactly these points — swap each behind
`isFsnActive()`:

1. **Node placement** — `js/nodes/nodeclass.js` `Node.draw` (~line 105-124), the only caller of
   `fromZtoUV`. Replace `const p = fromZtoUV(this.pos)` with
   `const p = isFsnActive() ? fsnFromZtoUV(this.pos) : fromZtoUV(this.pos)` (import from
   `fsn-substrate.js`). `fsnFromZtoUV` returns normalized UV {x,y} matching `fromZtoUV`'s shape;
   the existing UV→px step (reading `svg.getBoundingClientRect()`) then works — but point it at
   the `#fsn-canvas` rect, or hide the node when it returns null (behind camera).

2. **Screen→world** — `js/nodes/nodeutilities.js` `Graph.xyToZ` (~line 171) and `vecToZ`
   (node create/drag/pick). Route through `fsnXyToZ(px, py, dpr)` when active.

3. **Per-frame camera/redraw** — `js/nodes/nodeinteraction/nodestep.js` `NodeSimulation.nodeStep`
   (~line 148-167): guard `Svg.updateViewbox()` and `Fractal.render_hair`/`updateMousePath` with
   `!isFsnActive()`, and let `fsn-bootstrap.js`'s loop own fsn's `render()`. Also stub
   `Node.applyMandelbrotForce` (`nodeclass.js` ~157) — `Fractal.grad` has no fsn analogue; return
   zero force (or map to fsn terrain later).

Prereq for a clean cut-over: **extract `vec2` + the transform fns out of `js/mandelbrot/mandelbrot.js`**
(the file to eventually drop) into a shared module, since the whole app depends on `vec2`.

See `~/apps/IRIX/docs/ARCHITECTURE.md` and memory `krang-neurite-fsn-fusion` for the full map.
