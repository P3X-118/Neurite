// fsn CONSOLE for the Neurite host page (Design B Stage 6, done right):
// injects the standalone fsn app's shell — side-panel file tree, boards, session
// chip, labels layer, reader, context menu, login — into the page BEFORE the
// embed boots, so the REAL `web_ui` (Rust) drives the same DOM it drives in the
// standalone app. Markup + CSS are extracted from ~/apps/IRIX/index.html; the
// chrome script below is the same inline module that page ships (motion layer,
// mobile ☰ panel, Ctrl+M maximize), with the motion.dev import path localized.
import { animate } from './motion.mjs';

export async function mountFsnConsole() {
  if (document.getElementById('tree')) return; // already mounted
  // stylesheet first so the markup never flashes unstyled
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./fsn-console.css', import.meta.url);
  document.head.appendChild(link);
  const html = await (await fetch(new URL('./fsn-console.html', import.meta.url))).text();
  document.body.insertAdjacentHTML('beforeend', html);
  wireChrome();
}

// ---- the standalone page's chrome script (ported verbatim, import fixed) ----
function wireChrome() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Entrance animations on show (class 'hidden' removed).
  const entrances = [
    ['reader', { opacity: [0, 1], scale: [0.965, 1], y: [10, 0] }, 0.25],
    ['ctxmenu', { opacity: [0, 1], scale: [0.94, 1] }, 0.15],
    ['ephem', { opacity: [0, 1], y: [6, 0] }, 0.2],
  ];
  for (const [id, keyframes, duration] of entrances) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (id === 'ctxmenu') el.style.transformOrigin = 'top left';
    new MutationObserver(() => {
      if (el.classList.contains('hidden') || reduced) return;
      animate(el, keyframes, { duration, ease: [0.2, 0.8, 0.2, 1] });
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  // Mobile ☰: toggle the off-canvas panel; choosing a row closes it.
  const panelToggle = document.getElementById('panel-toggle');
  panelToggle?.addEventListener('click', () => document.body.classList.toggle('panel-open'));
  document.getElementById('tree')?.addEventListener('click', (e) => {
    if (!matchMedia('(max-width: 700px)').matches) return;
    if (e.target.closest('.row, .board-row')) document.body.classList.remove('panel-open');
  });

  // Ctrl+M: maximize/restore the reader, FLIP-animated.
  const flipToggle = (el, cls) => {
    const before = el.getBoundingClientRect();
    el.classList.toggle(cls);
    if (reduced) return;
    const after = el.getBoundingClientRect();
    if (after.width === 0 || after.height === 0) return;
    el.style.transformOrigin = 'top left';
    animate(
      el,
      {
        x: [before.left - after.left, 0],
        y: [before.top - after.top, 0],
        scaleX: [before.width / after.width, 1],
        scaleY: [before.height / after.height, 1],
      },
      { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }
    );
  };
  const onCtrlM = (e) => {
    if (!e.ctrlKey || (e.key !== 'm' && e.key !== 'M')) return;
    // a floating document window takes priority — it IS the reading surface
    if (globalThis.fsnToggleNodeFullscreen && globalThis.fsnDocCount && globalThis.fsnDocCount() > 0) {
      e.preventDefault();
      globalThis.fsnToggleNodeFullscreen();
      return;
    }
    const reader = document.getElementById('reader');
    if (!reader || reader.classList.contains('hidden')) return;
    e.preventDefault();
    flipToggle(reader, 'maximized');
  };
  addEventListener('keydown', onCtrlM);
  const frame = document.getElementById('reader-frame');
  if (frame) frame.addEventListener('load', () => {
    try { frame.contentDocument?.addEventListener('keydown', onCtrlM); } catch {}
  });

  // ---- navigator motion (user-directed 2026-08-16): more screen space for
  // documents. The whole panel retracts behind an edge tab, and tree folders
  // expand/retract — both motion-animated, reduced-motion aware. ----
  const tab = document.createElement('button');
  tab.id = 'panel-collapse';
  tab.type = 'button';
  tab.title = 'collapse / expand the navigator (more room to read)';
  tab.textContent = '⟨';
  tab.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('panel-collapsed');
    tab.textContent = collapsed ? '⟩' : '⟨';
  });
  document.body.appendChild(tab);

  // Folder expand/retract: rows are a FLAT list built by the Rust web_ui — the
  // hierarchy is recovered from data-path prefixes, so the wasm stays unaware.
  // A caret is injected per directory row; clicking it toggles the subtree
  // (staggered fade), clicking the row body still flies. Collapsed state is
  // remembered across panel refreshes (board switches re-render the rows).
  const collapsedDirs = new Set();
  const rowsBox = document.getElementById('tree-rows');
  const keyOf = (r) => (r.dataset.source || '') + '::' + (r.dataset.path || '');
  const isUnder = (r, src, path) =>
    r.dataset.source === src && (r.dataset.path || '').startsWith(path.replace(/\/$/, '') + '/');
  const applyCollapsed = () => {
    if (!rowsBox) return;
    const rows = [...rowsBox.children];
    for (const r of rows) r.classList.remove('collapsed-away');
    for (const key of collapsedDirs) {
      const [src, path] = key.split('::');
      for (const r of rows) if (isUnder(r, src, path)) r.classList.add('collapsed-away');
    }
  };
  const decorate = () => {
    if (!rowsBox) return;
    const rows = [...rowsBox.children];
    rows.forEach((r, i) => {
      if (r.querySelector('.row-caret')) return;
      const next = rows[i + 1];
      const isDir = !!next && isUnder(next, r.dataset.source, r.dataset.path || '/');
      if (!isDir) return;
      const caret = document.createElement('button');
      caret.type = 'button';
      caret.className = 'row-caret';
      caret.textContent = collapsedDirs.has(keyOf(r)) ? '▸' : '▾';
      caret.addEventListener('click', (e) => {
        e.stopPropagation(); // the row body still flies; the caret only folds
        const key = keyOf(r);
        const closing = !collapsedDirs.has(key);
        if (closing) collapsedDirs.add(key); else collapsedDirs.delete(key);
        caret.textContent = closing ? '▸' : '▾';
        const kids = [...rowsBox.children].filter((k) => isUnder(k, r.dataset.source, r.dataset.path || '/'));
        if (reduced) { applyCollapsed(); return; }
        if (closing) {
          kids.forEach((k, j) => animate(k, { opacity: [1, 0], x: [0, -8] }, { duration: 0.14, delay: j * 0.012 }));
          setTimeout(applyCollapsed, 150 + kids.length * 12);
        } else {
          applyCollapsed();
          const shown = kids.filter((k) => !k.classList.contains('collapsed-away'));
          shown.forEach((k, j) => animate(k, { opacity: [0, 1], x: [-8, 0] }, { duration: 0.16, delay: j * 0.012 }));
        }
      });
      r.prepend(caret);
    });
    applyCollapsed();
  };
  if (rowsBox) {
    decorate();
    new MutationObserver(() => decorate()).observe(rowsBox, { childList: true });
  }

  // Stage 8 mosaic: "expand view" opens an auxiliary window that tiles into the
  // same landscape (hidden on followers via html.fsn-follower CSS).
  const ex = document.createElement('button');
  ex.id = 'mosaic-expand';
  ex.type = 'button';
  ex.textContent = '⧉ expand view';
  ex.title = 'Open another window that extends this landscape (drag it to a second screen)';
  ex.addEventListener('click', () => { if (globalThis.fsnMosaic) globalThis.fsnMosaic.openFollowerWindow(); });
  document.body.appendChild(ex);
}
