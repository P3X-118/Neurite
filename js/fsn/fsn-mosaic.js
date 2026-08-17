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
  role: null,            // 'leader' | 'follower' — DYNAMIC (8d takeover)
  windows: new Map(),    // id -> { pose, lastSeen, leader }
  channel: null,
  relay: null,           // optional cross-machine WebSocket transport (8d seam)
  leaderLastSeen: 0,
  seq: 0,
};

/** True when this window was opened as an auxiliary viewport. */
export function isMosaicFollower() {
  return new URLSearchParams(location.search).get('mosaic') === 'follower';
}

/** Desktop-space rect of this window (no-permission pose; WM API is the 8c upgrade).
 * `?mosaicpose=x,y` overrides the position — headless windows all report
 * screenX/Y 0, so verification (and kiosks without a WM) can pin poses. */
export function windowPose() {
  let x = window.screenX, y = window.screenY;
  const ov = new URLSearchParams(location.search).get('mosaicpose');
  if (ov) { const p = ov.split(',').map(Number); if (p.length >= 2 && p.every(Number.isFinite)) { x = p[0]; y = p[1]; } }
  return {
    x, y,
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
export function initMosaic({ onCamera, onWorld, onInput, onRole, onDocs, onDocRestore } = {}) {
  mosaicState.channel = new BroadcastChannel(CH_NAME);
  mosaicState.role = isMosaicFollower() ? 'follower' : 'leader';
  mosaicState.leaderLastSeen = performance.now(); // grace at boot
  const ch = mosaicState.channel;

  // 8d relay seam (cross-machine): mirror the bus over a WebSocket when a relay
  // is configured (?relay=wss://… or window.FSN_MOSAIC_RELAY). Inert otherwise;
  // the relay server itself is estate infra (a follow-up service at the origin).
  const relayUrl = new URLSearchParams(location.search).get('relay') || globalThis.FSN_MOSAIC_RELAY || '';
  const connectRelay = () => {
    if (!relayUrl) return;
    try {
      const ws = new WebSocket(relayUrl);
      ws.onmessage = (ev) => { try { handle(JSON.parse(ev.data)); } catch (e) {} };
      ws.onclose = () => { mosaicState.relay = null; setTimeout(connectRelay, 3000 + Math.random() * 2000); };
      ws.onopen = () => { mosaicState.relay = ws; };
    } catch (e) { /* bad url — stay local */ }
  };
  connectRelay();

  const say = (m) => {
    const msg = { ...m, id: mosaicState.id };
    ch.postMessage(msg);
    if (mosaicState.relay && mosaicState.relay.readyState === 1) {
      try { mosaicState.relay.send(JSON.stringify(msg)); } catch (e) {}
    }
  };

  const adoptRole = (r) => {
    if (mosaicState.role === r) return;
    mosaicState.role = r;
    if (onRole) onRole(r);
    console.log('[fsn-mosaic] role ->', r);
  };

  const handle = (m) => {
    if (!m || m.id === mosaicState.id) return;
    const w = mosaicState.windows.get(m.id) || { pose: null, lastSeen: 0, leader: false };
    w.lastSeen = performance.now();
    if (m.t === 'hello' || m.t === 'pose') w.pose = m.pose;
    if (m.t === 'beat') {
      w.leader = m.leader;
      if (m.leader) {
        mosaicState.leaderLastSeen = performance.now();
        // two leaders (e.g. the original reopened after a takeover): LOWEST id
        // keeps the chair, the other demotes — deterministic on every window.
        if (mosaicState.role === 'leader' && m.id < mosaicState.id) adoptRole('follower');
      }
    }
    if (m.t === 'bye') { mosaicState.windows.delete(m.id); return; }
    if (m.t === 'cam' && mosaicState.role === 'follower' && onCamera) onCamera(m);
    if (m.t === 'world' && mosaicState.role === 'follower' && onWorld) onWorld(m);
    // 8c: followers forward input INTENTS; only the leader applies them.
    if (m.t === 'input' && mosaicState.role === 'leader' && onInput) onInput(m);
    // 8d: every window shares its document state; chips render everywhere.
    if (m.t === 'docs' && onDocs) onDocs(m.id, m.docs || []);
    if (m.t === 'docrestore' && m.owner === mosaicState.id && onDocRestore) onDocRestore(m.path);
    mosaicState.windows.set(m.id, w);
  };
  ch.onmessage = (ev) => handle(ev.data || {});

  say({ t: 'hello', pose: windowPose() });
  setInterval(() => say({ t: 'pose', pose: windowPose() }), POSE_MS);
  setInterval(() => {
    say({ t: 'beat', leader: mosaicState.role === 'leader' });
    const dead = performance.now() - 3 * BEAT_MS;
    for (const [id, w] of mosaicState.windows) if (w.lastSeen < dead) mosaicState.windows.delete(id);
    // 8d TAKEOVER: the leader's beat has gone silent — the lowest live id
    // promotes (deterministic, no coordination needed).
    if (mosaicState.role === 'follower' && performance.now() - mosaicState.leaderLastSeen > 3 * BEAT_MS) {
      const liveIds = [mosaicState.id, ...[...mosaicState.windows.entries()]
        .filter(([, w2]) => !w2.leader).map(([id2]) => id2)].sort();
      if (liveIds[0] === mosaicState.id) {
        adoptRole('leader');
        mosaicState.leaderLastSeen = performance.now();
      }
    }
  }, BEAT_MS);
  addEventListener('beforeunload', () => say({ t: 'bye' }));
  const api = {
    /** Leader: broadcast the camera each frame (throttle upstream). */
    broadcastCamera(pan, zoom, yaw, pitch) {
      if (mosaicState.role !== 'leader') return;
      mosaicState.seq++;
      say({ t: 'cam', pan, zoom, yaw, pitch, seq: mosaicState.seq });
    },
    /** Leader: broadcast world state (board + descent path) on change. */
    broadcastWorld(board, curPath) {
      if (mosaicState.role !== 'leader') return;
      say({ t: 'world', board, curPath });
    },
    /** Follower: forward an input intent to the leader. */
    sendInput(payload) {
      if (mosaicState.role !== 'follower') return;
      say({ t: 'input', ...payload });
    },
    /** Any window: share this window's document state (8d chip mirroring). */
    broadcastDocs(docs) { say({ t: 'docs', docs }); },
    /** Any window: ask the OWNER window to restore a docked document. */
    requestDocRestore(owner, path) { say({ t: 'docrestore', owner, path }); },
    /** Both roles: push this window's sub-rect into the embed (8a API). */
    applyMosaicRect(fsn) {
      const r = mosaicRect();
      if (fsn && fsn.set_mosaic_rect) fsn.set_mosaic_rect(r.x, r.y, r.w, r.h);
    },
  };
  // expose the live api on the probe bridge too — dock-chip handlers (and any
  // console chrome) reach it via globalThis.fsnMosaic, not the bootstrap's var
  if (globalThis.fsnMosaic) Object.assign(globalThis.fsnMosaic, api);
  return api;
}

// Probe/debug bridge (also used by the verification suite).
if (typeof globalThis !== 'undefined') {
  globalThis.fsnMosaic = { state: mosaicState, windowPose, virtualCanvas, mosaicRect, openFollowerWindow, isMosaicFollower };
}

/** Console affordance: open a pre-positioned follower window. With the Window
 * Management API (Chromium; permission-prompted) the follower FILLS the next
 * screen; otherwise a best-effort placement to the right of this window. */
export async function openFollowerWindow() {
  const p = windowPose();
  let feat = `popup=yes,left=${p.x + p.w + 16},top=${p.y},width=${p.w},height=${p.h}`;
  try {
    if ('getScreenDetails' in window) {
      const d = await window.getScreenDetails();
      const other = d.screens.find((sc) => sc !== d.currentScreen);
      if (other) feat = `popup=yes,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
    }
  } catch (e) { /* permission declined — heuristic placement stands */ }
  window.open(`${location.pathname}?mosaic=follower`, '_blank', feat);
}
