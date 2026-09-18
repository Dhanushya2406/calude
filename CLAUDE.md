# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Snackable — a personal Manifest V3 Chrome extension that turns YouTube's Watch Later playlist into an intentional watch queue with notes, highlights, chapters, and per-category analytics. Full product rationale, every non-obvious design decision, and a version-by-version history of what was tried and why is in `CONTEXT.md` — **read it before making UI, storage, or embedding changes**; several things that look like bugs on first read are deliberate, and several things that look fine are known-broken (see "Known issues" there).

## Commands

There is no build step, no package.json, no bundler, no test suite, and no linter. This is plain HTML/CSS/JS loaded directly by Chrome as an unpacked extension.

**Development loop:**
1. Edit `background.js`, `dashboard.{html,js,css}`, or anything under `vendor/`/`icons/`/`fonts/` directly.
2. In Chrome, go to `chrome://extensions`, find Snackable, click the reload icon to pick up the change.
3. Click the toolbar icon to open/refresh `dashboard.html` and test manually — there is no automated test suite.
4. For `background.js` changes, also check its console via `chrome://extensions` → Snackable → "service worker" link (not the dashboard page's own console).

**`docs/player.html` is the one exception** — it's not loaded from disk. It's served live via GitHub Pages at `https://dhanushya2406.github.io/calude/player.html`, and `dashboard.js` embeds videos through that URL, not the local file. Changes to it only take effect after `git push` to `main` and a GitHub Pages rebuild (poll `curl -s https://dhanushya2406.github.io/calude/player.html` for the change to confirm it's live — rebuilds have taken anywhere from ~10s to ~2min in practice).

No CI, no `npm install`, nothing else to run.

## Architecture

Three parts:

1. **`background.js`** (service worker) — every 15 min, opens `youtube.com/playlist?list=WL` in a hidden tab, scrapes it via `chrome.scripting.executeScript` (selectors like `ytd-playlist-video-renderer` — fragile by nature, check these first if sync stops picking up videos), dedupes into `chrome.storage.local`, and separately checks embeddability per video via YouTube's oEmbed endpoint.
2. **`dashboard.html`/`dashboard.js`/`dashboard.css`** — the whole UI, opened from the toolbar icon. One `sl-tab-group[placement="start"]` (left sidebar nav) with four panels: Queue (card grid), Watch (embedded player + notes/highlights/chapters), History, Analytics.
3. **`docs/player.html`** — a stateless relay page hosted on GitHub Pages (see Commands above for why it can't just be a local file). YouTube's player-config check rejects `chrome-extension://` as an embedding origin outright, so the Watch tab embeds *this* page instead of YouTube directly, and this page embeds the actual YouTube iframe and relays `postMessage` traffic both ways. `dashboard.js`'s `PLAYER_ORIGIN`/`PLAYER_PAGE` constants point at it.

**No build tooling anywhere in the dependency chain** — this is deliberate, not incomplete:
- **UI components**: Shoelace, vendored at `vendor/shoelace/` (pulled from its npm tarball directly, not a CDN — MV3's default CSP blocks remote scripts in extension pages). Loaded via its autoloader, which lazy-registers only the `<sl-*>` tags actually used. **The autoloader's `<script src="...">` in `dashboard.html` must be root-relative (`/vendor/...`)** — a plain relative path breaks its internal dynamic `import()` calls with zero console output (see `CONTEXT.md`'s v1.5.1 entry for the exact mechanism). Before writing any `::part()` override, check `vendor/shoelace/chunks/*.js` for how that part actually renders — several (the tab indicator among them) don't work the way a plain styled `<div>` would, and guessing has cost real time more than once (see the v2.0.1/v2.0.2/v2.2.0 entries).
- **Icons**: individual Lucide SVGs vendored at `icons/ui/` (not the full default icon set — that's ~8.4MB), rendered via `<sl-icon src="icons/ui/name.svg">`.
- **Font**: DM Sans, self-hosted at `fonts/dm-sans/` (two variable-font woff2 files, no live Google Fonts dependency). Setting `dashboard.css`'s `body` font-family alone isn't enough — Shoelace components read `shoelace-theme.css`'s `--sl-font-sans` token internally, not the inherited value, so both need updating together.

**Storage** (`chrome.storage.local`, not `.sync` — see "Known issues" below):
```
queue: [{ id, title, channel, url, category, addedAt, watched, watchedAt, durationSec, embeddable }]
notes: { [videoId]: [{ ts, text }] }
highlights: { [videoId]: [{ start, end, label }] }
analyticsTotals: { [category]: totalSeconds }
```

**Watch tab player bridge**: no official YouTube `iframe_api` script is used (CSP-blocked in MV3 extension pages) — `dashboard.js` speaks the raw `postMessage` protocol directly (`postToPlayer()`/the `window.addEventListener("message", ...)` handler), including a custom timeline that polls `getCurrentTime` on an interval since there's no synchronous API available. `docs/player.html`'s embed URL carries `controls=0&rel=0&iv_load_policy=3` to suppress YouTube's own control bar in favor of the custom one — the YouTube logo/watermark itself cannot be removed by any embed parameter, that's contractual on YouTube's side.

**Panel layout**: each `sl-tab-panel` splits into a non-scrolling `.page-header` followed by a `.panel-scroll` div (the only element with `overflow-y: auto`) — this is a real structural separation, not a `position: sticky` trick (an earlier sticky-header approach had a persistent, hard-to-pin-down ghosting bug; see `CONTEXT.md`'s v2.5.0 entry before reintroducing `position: sticky` anywhere in this layout).

## Known issues (don't re-diagnose these, they're already understood — see CONTEXT.md for full detail)

- **Cross-device sync is broken.** The whole point of the Chrome-extension architecture was free sync via `chrome.storage.sync`, but the actual code uses `chrome.storage.local` everywhere (likely swapped in to dodge `storage.sync`'s ~100KB quota). Single-device only today.
- **The GitHub repo (`calude`) is public**, specifically because GitHub Pages isn't available on private repos under the current plan.
- **YouTube Premium ad-free playback is not guaranteed** even though the embed uses `youtube.com` (not `youtube-nocookie.com`) specifically to allow it — it depends on the viewer being logged in and on Chrome's current third-party-cookie policy allowing the relay page to see that session.
