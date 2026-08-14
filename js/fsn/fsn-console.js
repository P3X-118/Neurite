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
}
