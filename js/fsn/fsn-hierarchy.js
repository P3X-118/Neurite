// fsn-hierarchy.js — Design B Stage 2: map the FileBrowser hierarchy into Neurite's
// z-space via SCALE-RELATIVE nesting, so directories/floors/files literally ARE the
// zoom levels. city(scale 1) -> dir-tower(k) -> floor(k^2) -> file(k^3) -> content(k^4).
// Each child sits in its parent's LOCAL frame (offset * parent.scale) and is k x smaller,
// so you must zoom in one level to bring the next to readable size (the "structured fractal").
//
// LOCKED/PRIVATE nodes are INCEPTION BOUNDARIES: their subtree is a SEPARATE incepted
// fractal filesystem, loaded (re-rooted) on entry — NOT placed inline here. The mapper marks
// the boundary and stops; Stage 3-5 loads the incepted section as a fresh root when you cross
// (access-gated). This is the sovereign-pod federation rendered spatially.

export const HIER = {
  K: 0.22,        // per-level shrink (child.scale = parent.scale * K)
  RING_R: 1.15,   // base ring radius in parent-local units (scaled by parent.scale)
  MAX_DEPTH: 6,   // safety cap; re-basing + inception extend true depth beyond this
};

const isInceptionBoundary = (n) => !!(n && (n.locked || n.private));

// dirs first (towers/floors), then files (blocks) — tolerate {children:[]} and/or {files:[]}
function childrenOf(node) {
  const kids = node.children || [];
  const dirs = kids.filter((c) => c.isDir !== false && !c.__isFile);
  const files = kids.filter((c) => c.isDir === false || c.__isFile)
    .concat((node.files || []).map((f) => ({ ...f, isDir: false })));
  return dirs.concat(files);
}

function place(node, pos, scale, depth, out, cfg) {
  const path = node.path || '/';
  const boundary = isInceptionBoundary(node);
  out.set(path, {
    path,
    name: node.name || '/',
    source: node.source || '',
    pos: { x: pos.x, y: pos.y },
    scale,
    depth,
    kind: node.isDir === false ? 'file' : 'dir',
    boundary,        // true => a separate incepted filesystem lives inside; load on entry
    locked: !!node.locked,
    private: !!node.private,
  });
  // Stop descending at an inception boundary (its subtree is a separate section) or the cap.
  if (boundary || depth >= cfg.MAX_DEPTH) return;
  const kids = childrenOf(node);
  const n = kids.length;
  kids.forEach((child, i) => {
    // ring placement in the parent's LOCAL frame, scaled by the parent's scale
    const a = n === 1 ? 0 : (2 * Math.PI * i) / n;
    const off = { x: Math.cos(a) * cfg.RING_R, y: Math.sin(a) * cfg.RING_R };
    const childPos = { x: pos.x + off.x * scale, y: pos.y + off.y * scale };
    place(child, childPos, scale * cfg.K, depth + 1, out, cfg);
  });
}

/** Build the z-space placement datum for one tree (one fractal section).
 * Returns { root, byPath: Map<path, placement> }. Later stages read this to render
 * towers (fsn), fly-to on descent (Autopilot), and bloom a file's document nodes. */
export function buildHierarchy(tree, opts = {}) {
  const cfg = { ...HIER, ...opts };
  const out = new Map();
  if (tree) place(tree, { x: 0, y: 0 }, 1.0, 0, out, cfg);
  return { root: (tree && tree.path) || '/', byPath: out, cfg };
}

// --- self-test (node fsn-hierarchy.js) ---
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('fsn-hierarchy.js')) {
  const tree = {
    name: '/', path: '/', isDir: true, children: [
      { name: 'community', path: '/community', isDir: true, children: [
        { name: 'compliance', path: '/community/compliance', isDir: true, children: [
          { name: 'SOURCES.txt', path: '/community/compliance/SOURCES.txt', isDir: false },
        ], files: [{ name: 'README.md', path: '/community/compliance/README.md' }] },
      ] },
      { name: 'private-pod', path: '/private-pod', isDir: true, locked: true, children: [
        { name: 'secret', path: '/private-pod/secret', isDir: true, children: [] }, // must NOT be placed
      ] },
    ],
  };
  const { byPath } = buildHierarchy(tree);
  const g = (p) => byPath.get(p);
  const A = (c, m) => console.log((c ? 'PASS' : 'FAIL') + ' ' + m);
  A(g('/').scale === 1, 'root scale = 1');
  A(Math.abs(g('/community').scale - HIER.K) < 1e-9, `dir at depth1 scale = k (${g('/community').scale})`);
  A(Math.abs(g('/community/compliance').scale - HIER.K ** 2) < 1e-9, 'depth2 scale = k^2');
  A(Math.abs(g('/community/compliance/SOURCES.txt').scale - HIER.K ** 3) < 1e-9, 'file depth3 scale = k^3');
  A(g('/community/compliance/SOURCES.txt').kind === 'file', 'file marked kind=file');
  // child sits in parent's local frame: |childPos - parentPos| ≈ RING_R * parentScale
  const cp = g('/community').pos, rp = g('/').pos;
  const d = Math.hypot(cp.x - rp.x, cp.y - rp.y);
  A(Math.abs(d - HIER.RING_R * 1.0) < 1e-9, `depth1 offset = RING_R*parentScale (${d.toFixed(3)})`);
  A(g('/private-pod').boundary === true, 'locked node marked as inception boundary');
  A(!byPath.has('/private-pod/secret'), 'inception boundary children NOT placed inline');
  A(g('/community/compliance/README.md').kind === 'file', 'files[] entry placed as file');
  console.log(`placed ${byPath.size} nodes`);
}
