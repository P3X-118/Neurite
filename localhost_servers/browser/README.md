# browser-fetch — secure headless-browser sidecar

A single **full** Chromium (headed, under `xvfb`) with an ephemeral context per
request. Defeats X-Frame-Options (returns DOM/text/pixels, not a live iframe)
and most WAFs/JS-challenges that `node-fetch` cannot.

`POST /browser/fetch { url, want: text|html|screenshot|binary, referer?, waitUntil?, timeoutMs? }`

## Run
`npm ci && npm start`  (start = `xvfb-run -a node browser-fetch.js`; needs xvfb + a
Playwright-deps browser image, e.g. `mcr.microsoft.com/playwright`).

## Verified finding (2026-07-27) — headed-under-xvfb, NOT headless-shell
`dodcio.defense.gov` is behind **Akamai Bot Manager** (`errors.edgesuite.net`,
"Access Denied"). `chrome-headless-shell` gets **403**; the **full Chromium headed
under xvfb** with a realistic context (viewport/locale/timezone/Accept-Language)
gets **200**. Hence `headless:false` + `xvfb-run`. Proven by fetching 4 DoD CMMC
PDFs past the WAF.

## Deploy hardening (hal) — NOT in code, container/host concerns
Run in a hardened container: non-root, `--cap-drop=ALL`, `--security-opt no-new-privileges`,
read-only rootfs + tmpfs, hard `--memory`/`--pids` caps (OOM contention with LocalAI on the
Jetson). Bind loopback only; NEVER a public open proxy. Put a **uid/cgroup nftables egress
fence** in front (deny loopback + RFC1918 + link-local) so a hostile page can't reach
LocalAI/ai-proxy/DirectAccess on host-net — kernel support verified present. See memory
`krang-neurite-fsn-fusion` / `neurite-ai-proxy-hal-gaps`.
