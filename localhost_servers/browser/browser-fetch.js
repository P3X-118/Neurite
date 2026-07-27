// Secure headless-browser fetch service for the Neurite/krang stack.
//
// A single real headless Chromium with an EPHEMERAL context per request (no
// cookie/session bleed between callers). Because it executes JS with a genuine
// browser TLS/UA fingerprint, it defeats both:
//   * WAFs / JS-challenges (Cloudflare, dodcio.defense.gov-style 403s) that a
//     plain `node-fetch` scraper cannot pass; and
//   * X-Frame-Options (we return DOM/text/pixels, not a live cross-origin
//     iframe — so the hostile page never runs in Neurite's origin).
//
// One engine, three consumers (this MVP = fetch mode): WAF-proof doc fetch for
// the webscrape/RAG pipeline, per-node interactive view (screenshot/CDP later),
// and agent automation.
//
// ISOLATION IS A DEPLOY CONCERN, not code: on hal this must run in a hardened
// container (non-root, --cap-drop=ALL, no-new-privileges, read-only rootfs, hard
// --memory/--pids caps to avoid OOM contention with LocalAI) behind a uid/cgroup
// nftables EGRESS FENCE (deny loopback + RFC1918 + link-local so a hostile page
// can't reach LocalAI/ai-proxy/DirectAccess on host-net). Kernel support for
// this was verified present. Keep bound to loopback; never a public open proxy.

const express = require('express');
const { chromium } = require('playwright');

const PORT = process.env.BROWSER_FETCH_PORT || 7072;
const NAV_TIMEOUT = Number(process.env.BROWSER_FETCH_TIMEOUT_MS || 60000);
const MAX_BYTES = Number(process.env.BROWSER_FETCH_MAX_BYTES || 80 * 1024 * 1024);
// A real, current desktop-Chrome UA (Playwright's default UA advertises
// HeadlessChrome, which some WAFs flag).
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    // Launch the FULL browser headed, not chrome-headless-shell. Hardened WAFs
    // (Akamai Bot Manager on dodcio.defense.gov) specifically flag the headless
    // shell and 403 it; the full Chromium under a virtual display (run the
    // process with `xvfb-run`) passes. Verified 2026-07-26.
    browserPromise = chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    });
  }
  return browserPromise;
}

// Realistic context so we look like a normal desktop browser, not automation.
function contextOptions() {
  return {
    userAgent: UA,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    acceptDownloads: false,
  };
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /browser/fetch
 * { url, want: "text"|"html"|"screenshot"|"binary", referer?, waitUntil?, timeoutMs? }
 *
 * want=binary : download a file (e.g. a WAF-protected PDF). Optionally pass a
 *   `referer` page to visit first — the ephemeral context reuses those cookies +
 *   the browser fingerprint on the file request, which is what gets past a WAF
 *   that blocks bare fetchers. Returns the raw bytes.
 * want=text|html|screenshot : navigate and return rendered content.
 */
app.post('/browser/fetch', async (req, res) => {
  const {
    url,
    want = 'text',
    referer,
    waitUntil = 'domcontentloaded',
    timeoutMs = NAV_TIMEOUT,
  } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'valid http(s) url required' });
  }

  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext(contextOptions());
    context.setDefaultTimeout(timeoutMs);

    if (want === 'binary' || want === 'pdf') {
      if (referer) {
        const p = await context.newPage();
        await p.goto(referer, { waitUntil, timeout: timeoutMs }).catch(() => {});
        await p.close();
      }
      const r = await context.request.get(url, { timeout: timeoutMs });
      if (!r.ok()) return res.status(502).json({ error: 'upstream', status: r.status() });
      const buf = await r.body();
      if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'too large', bytes: buf.length });
      res.setHeader('Content-Type', r.headers()['content-type'] || 'application/octet-stream');
      return res.end(buf);
    }

    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil, timeout: timeoutMs });
    const status = resp ? resp.status() : 0;

    if (want === 'html') {
      return res.json({ status, url: page.url(), html: await page.content() });
    }
    if (want === 'screenshot') {
      const b = await page.screenshot({ fullPage: false });
      return res.json({ status, url: page.url(), screenshot_b64: b.toString('base64') });
    }
    // default: readable text over the RENDERED DOM
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return res.json({ status, url: page.url(), title: await page.title(), text });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log('browser-fetch on 127.0.0.1:' + PORT));
}
module.exports = app;
