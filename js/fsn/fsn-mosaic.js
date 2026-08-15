// fsn MOSAIC (Stage 8 scaffold — NOT yet imported by fsn-bootstrap): N browser
// windows composing ONE cohesive landscape. Each window is a viewport into the
// same shared scene; the union of window rects on the desktop is the VIRTUAL
// CANVAS, and every window renders the shared camera through an off-axis
// sub-frustum for its rect — so edges line up across monitors/bezels.
//
// Plan: ~/apps/IRIX/docs/PROJECT-TRACK.md "Stage 8". Increments:
//   8a fsn crate: camera off-center projection + FsnEmbed.set_mosaic_rect(x,y,w,h)
//   8b this module: bus + leader election + pose + follower boot + expand button
//   8c input forwarding, bloom mirroring, Window Management API, WS relay.
//
// Protocol (BroadcastChannel 'fsn-mosaic', same-origin/profile; later the same
// messages over a WS relay for cross-browser/machine):
//   {t:'hello', id, pose}              window joined (leader replies with world)
//   {t:'pose',  id, pose}              desktop rect changed (~1 Hz poll)
//   {t:'cam',   id, pan, zoom, yaw, pitch, seq}   leader camera (rAF-throttled)
//   {t:'world', id, board, curPath, blooms}       leader world state on change
//   {t:'beat',  id, leader}            heartbeat (2 s); missed 3 → re-elect
//   {t:'bye',   id}                    window closing
// pose = { x: screenX, y: screenY, w: innerWidth, h: innerHeight, dpr }

const CH_NAME = 'fsn-mosaic';
const BEAT_MS = 2000;
const POSE_MS = 1000;

export const mosaicState = {
  id: Math.random().toString(36).slice(2, 10),
  role: null,            // 'leader' | 'follower' | null (single-window)
  windows: new Map(),    // id -> { pose, lastSeen, leader }
  channel: null,
  seq: 0,
};

/** True when this window was opened as an auxiliary viewport. */
export function isMosaicFollower() {
  return new URLSearchParams(location.search).get('mosaic') === 'follower';
}

/** Desktop-space rect of this window (no-permission pose; WM API is the 8c upgrade). */
export function windowPose() {
  return {
    x: window.screenX, y: window.screenY,
    w: window.innerWidth, h: window.innerHeight,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  };
}

/** Union bounding box of all live windows — the virtual canvas. */
export function virtualCanvas() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const mine = windowPose();
  const all = [mine, ...[...mosaicState.windows.values()].map((w) => w.pose)];
  for (const p of all) {
    if (!p) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, mine };
}

/** This window's sub-rect as fractions of the virtual canvas — feeds
 * FsnEmbed.set_mosaic_rect (8a). Identity rect when single-window. */
export function mosaicRect() {
  if (mosaicState.windows.size === 0) return { x: 0, y: 0, w: 1, h: 1 };
  const v = virtualCanvas();
  return {
    x: (v.mine.x - v.x) / v.w,
    y: (v.mine.y - v.y) / v.h,
    w: v.mine.w / v.w,
    h: v.mine.h / v.h,
  };
}

/** 8b entry point (to be called from fsn-bootstrap once 8a lands):
 * joins the bus, elects a role, starts pose/beat loops, and returns hooks the
 * render loop calls each frame. All TODOs are the 8b implementation. */
export function initMosaic({ onCamera, onWorld } = {}) {
  mosaicState.channel = new BroadcastChannel(CH_NAME);
  mosaicState.role = isMosaicFollower() ? 'follower' : 'leader'; // TODO: real election + takeover
  const ch = mosaicState.channel;
  const say = (m) => ch.postMessage({ ...m, id: mosaicState.id });
  ch.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.id === mosaicState.id) return;
    const w = mosaicState.windows.get(m.id) || { pose: null, lastSeen: 0, leader: false };
    w.lastSeen = performance.now();
    if (m.t === 'hello' || m.t === 'pose') w.pose = m.pose;
    if (m.t === 'beat') w.leader = m.leader;
    if (m.t === 'bye') { mosaicState.windows.delete(m.id); return; }
    if (m.t === 'cam' && mosaicState.role === 'follower' && onCamera) onCamera(m);
    if (m.t === 'world' && mosaicState.role === 'follower' && onWorld) onWorld(m);
    mosaicState.windows.set(m.id, w);
  };
  say({ t: 'hello', pose: windowPose() });
  setInterval(() => say({ t: 'pose', pose: windowPose() }), POSE_MS);
  setInterval(() => {
    say({ t: 'beat', leader: mosaicState.role === 'leader' });
    const dead = performance.now() - 3 * BEAT_MS;
    for (const [id, w] of mosaicState.windows) if (w.lastSeen < dead) mosaicState.windows.delete(id);
    // TODO 8b: leader takeover when the leader's beat goes silent.
  }, BEAT_MS);
  addEventListener('beforeunload', () => say({ t: 'bye' }));
  return {
    /** Leader: broadcast the camera each frame (throttle upstream). */
    broadcastCamera(pan, zoom, yaw, pitch) {
      if (mosaicState.role !== 'leader') return;
      mosaicState.seq++;
      say({ t: 'cam', pan, zoom, yaw, pitch, seq: mosaicState.seq });
    },
    /** Both roles: push this window's sub-rect into the embed (8a API). */
    applyMosaicRect(fsn) {
      const r = mosaicRect();
      if (fsn && fsn.set_mosaic_rect) fsn.set_mosaic_rect(r.x, r.y, r.w, r.h);
    },
  };
}

/** Console affordance (8b): open a pre-positioned follower window. */
export function openFollowerWindow() {
  const p = windowPose();
  // Best-effort placement to the right; WM API (8c) makes this exact per-screen.
  window.open(`${location.pathname}?mosaic=follower`, '_blank',
    `popup=yes,left=${p.x + p.w + 16},top=${p.y},width=${p.w},height=${p.h}`);
}
