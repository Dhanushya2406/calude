# Snackable — Project Context

## What this is
A personal YouTube/podcast consumption tool. The problem it solves: YouTube is built for infinite scroll — when I have free time, I open it and lose the time to doomscrolling. Snackable inverts that: I curate a queue in advance (via YouTube's native Watch Later), and when I actually have time, I consume intentionally from that queue instead of the YouTube homepage.

Notes and highlights captured while watching are the most important feature — the whole point is to walk away with something, not just watched time.

## Why it's built the way it is (read this before suggesting changes)
- **No manual URL pasting.** Adding a video to the queue must be zero-friction — I already use YouTube's native "Save to Watch Later" button, so Snackable should just pick up whatever's already there.
- **No cookie scraping.** Considered and explicitly rejected — pulling account cookies to auth as me is a real security tradeoff I don't want.
- **No external backend/database.** I want this fast, free, and low-maintenance. No Supabase/Firebase/servers.
- **Fully offline was considered and shelved** — it conflicts with wanting the queue to sync across devices (phone adds → desktop sees it). Revisit only if I explicitly ask.
- **Design aesthetic:** warm, fintech-inspired, dark mode (Wint Wealth is the visual reference).
- **Stack preference:** originally scoped for Next.js, but the current build is a Chrome extension because that's what solved the sync problem for free — see **Known issue** below, this is currently broken.
- **No external backend/database** now has one narrow exception: `docs/player.html`, a stateless static page on GitHub Pages that only relays YouTube postMessage traffic (see v1.4.0 note below). No data storage, no server logic — still consistent with the spirit of the rule.

## ⚠️ Repo visibility — now public
The `calude` repo was switched from private to public on 2026-09-18 specifically because GitHub Pages (needed for the embed fix below) isn't available on private repos under the current GitHub plan. All source code, including this file, is now publicly visible. Revisit if that's not acceptable long-term (a paid plan would allow Pages on a private repo again).

## ⚠️ Known issue — cross-device sync is currently broken
The original design (see above) depends on `chrome.storage.sync` to get free cross-device sync. **The actual v1.3 code uses `chrome.storage.local` everywhere** (queue, notes, highlights, analyticsTotals) — likely swapped in to avoid `storage.sync`'s ~100KB quota once `durationSec`/`embeddable` fields and notes grew the payload. This means the extension currently only works on a single device/browser profile; the core "add from phone, see it on desktop" promise does not hold today.

Not yet resolved — options when revisited: shard data across `storage.sync` keys to stay under quota, sync only lightweight fields (ids/metadata) via `storage.sync` and keep bulky notes/highlights in `storage.local`, or accept single-device and find another sync path.

## How data gets in (the key architectural decision)
YouTube's Watch Later playlist is **account-tied and syncs automatically across every device already** — add from phone, it's there on desktop. The YouTube Data API has never allowed third-party read/write access to this specific playlist (confirmed via research, deprecated since 2016) — but a browser extension can just *read the rendered page* (`youtube.com/playlist?list=WL`) since it's a normal logged-in page view, no API needed.

Once read, the plan was for `chrome.storage.sync` to auto-sync that data across every Chrome browser signed into the same Google account, replacing the need for a custom backend/database. **This part isn't working today** — see Known Issue above.

## Current State — v1.4.0 (Manifest V3 Chrome extension + a GitHub Pages relay)
Two extension parts, plus one small hosted page:

1. **`background.js`** — service worker. Every 15 min (`chrome.alarms`), opens Watch Later in a hidden background tab, runs a DOM-scraping function (`chrome.scripting.executeScript`) to extract `{id, title, channel, url, durationSec}` per video (duration parsed from the thumbnail overlay text), dedupes/backfills against the existing queue, saves to `chrome.storage.local`, closes the tab. Also registers `declarativeNetRequest` rules to set a `Referer` header on embedded-player requests — this predates the v1.4.0 fix below and is now mostly vestigial for the main embed path, left in place as a harmless no-op/fallback. Separately checks embeddability per video via the YouTube oEmbed endpoint (batches of 5, throttled) and stores `embeddable: true/false/null`.
2. **`dashboard.html/js/css`** — the app UI, opened from the toolbar icon. Four tabs:
   - **Queue** — unwatched videos, with a **session-time filter** ("I have 30/60/90/120 min" → greedily fills the list up to the budget using `durationSec`, unknown-duration videos always included), an "Embeddable only" toggle to hide videos with embedding disabled, category dropdown per video, "Watch" button
   - **Watch** — embeds via `docs/player.html` (see below), not YouTube directly. Custom `postMessage` protocol for tracking current playback time (NOT the official `iframe_api` script — that's blocked by MV3's CSP, which disallows remote scripts in extension pages), timestamped note capture and highlights built with Shoelace components (`<sl-card>`/`<sl-badge>`/`<sl-textarea>`, see below) whose timestamp badges seek the player on click, best-effort **chapters** fetched from the video's watch-page JSON (`loadChapters()`/`extractChaptersFromWatchHtml()` in dashboard.js — same fragility class as the Watch Later scraper: YouTube can change this internal structure, and chapters just silently stop appearing rather than erroring), "Mark as watched," and fallback panels: an immediate one for the two unambiguous fatal error codes (101/150 = creator disabled embedding, 100 = video removed/private), and a delayed one (4s grace period, only if no real player telemetry arrives) for any other error code, since those aren't reliably fatal in this hand-rolled setup
   - **History** — watched videos, sorted newest first, showing category/note count/highlight count/watched date, "Review" (reopen in Watch tab) and "↩ move back to queue"
   - **Analytics** — hours consumed by category (bar chart) built from `analyticsTotals`, which heartbeats +30s every 30s while a video is open in the Watch tab
3. **`docs/player.html`**, served via GitHub Pages at `https://dhanushya2406.github.io/calude/player.html` — a stateless relay page. **Why it exists:** YouTube's player-config check appears to flatly reject `chrome-extension://` as an embedding origin (confirmed empirically: YouTube's own player rendered "This video is unavailable — Error code 152" for multiple videos with no server-side embedding restriction, unaffected by the Referer fix or an explicit `origin=` param). Loading YouTube from a real `https://` page instead — and relaying `postMessage` traffic both ways between the extension and that page's embedded YouTube iframe — works around it. `dashboard.js`'s `PLAYER_ORIGIN`/`PLAYER_PAGE` constants point at this URL.

### UI components — Shoelace (vendored, self-hosted)
`vendor/shoelace/` holds a locally-vendored copy of [Shoelace](https://shoelace.style) (MIT licensed, pulled directly from the npm tarball — no CDN reference, since MV3's default CSP blocks loading remote scripts in extension pages). `dashboard.html` loads it via the autoloader (`/vendor/shoelace/shoelace-autoloader.js`, `type="module"`, **root-relative src — see pitfall below**), which lazy-registers only the `<sl-*>` custom elements actually used on the page — no bundler/build step needed. `shoelace-theme.css` remaps Shoelace's design tokens onto the existing warm/fintech dark palette from `dashboard.css` (`--sl-color-primary-*` → the accent orange, `--sl-color-neutral-*` → the existing surface/border/text scale) so components look native instead of Shoelace's default blue theme.

**⚠️ Pitfall already hit once (v1.5.1 fix):** the autoloader's `<script src="...">` must be a root-relative path (starts with `/`). It reads its own `src` attribute back via `getAttribute("src")` to build paths for the dynamic `import()` calls it makes per component. A plain relative path (no leading `/` or `./`) is an invalid bare module specifier with no import map present — every component import throws, and Shoelace's autoloader catches all of those internally via `Promise.allSettled`, so **nothing appears in the console**. Symptom: every `<sl-*>` element silently stays unstyled/unregistered (buttons render as plain inline text) with zero errors anywhere. `dashboard.js` has a startup canary (checks `customElements.get("sl-button")` after 3s) specifically so this can't regress silently again.

As of v1.6.0, the whole dashboard uses Shoelace components — tabs (`sl-tab-group`/`sl-tab`/`sl-tab-panel`, replacing the old manual `.tab-btn`/`.panel` class-toggling — panel switching is now handled by Shoelace internally via `mainTabs.show("panelName")`, listen for `sl-tab-show` to react to changes), Queue/History cards (`sl-card`/`sl-select`/`sl-badge`/`sl-button`), Analytics (`sl-progress-bar` instead of hand-rolled div bars), and the Watch tab's Notes/Highlights panel (`sl-card`/`sl-badge`/`sl-textarea`, done in v1.5.0). Note: Shoelace form controls fire `sl-change`/`sl-blur`/etc., not native `change`/`blur` — code listening to them must use the `sl-`-prefixed event names.

One class (`.watch-btn`) is intentionally still used by both a couple of plain `<a>`/`<button>` elements (the Watch-tab error fallback panels) *and* an `<sl-button>` in the Queue — this is safe, not an oversight: Shadow DOM encapsulation means non-part-scoped rules like `background`/`padding` on the host element are inert no-ops for the `sl-button`, while they still work normally on the plain elements.

### v1.7.0 — sidebar layout + stat cards
The first Shoelace pass (v1.5.0/v1.6.0) got the *components* right but not the actual visual design — flat single-column layout, no hierarchy, no shadows. v1.7.0 restructures around a real dashboard pattern (sidebar nav + stat cards + card shadows), closer to typical modern SaaS admin UIs:
- `sl-tab-group[placement="start"]` now renders as a **left sidebar** (220px), not top tabs — the brand and a "Sync now" button (pinned to the bottom via `margin-top: auto`) are slotted into `slot="nav"` alongside the `sl-tab` elements themselves, since Shoelace's nav slot will render arbitrary content, not just tabs.
- Nav icons are emoji (📥▶️🕐📊), matching the emoji-forward style already established elsewhere (🍿✓📝✨) rather than pulling in an icon font/library.
- Each tab-panel (except Watch) now has a real `<h1>` + subtitle page header, instead of relying on the sidebar label alone.
- New stat-card row at the top of Queue (`renderStats()` in dashboard.js): in-queue count, watched count, hours consumed, notes+highlights captured. Recomputes on any relevant `chrome.storage.onChanged` event (queue/notes/highlights/analyticsTotals), not just queue.
- All `sl-card` instances now get a consistent shadow + 14px radius globally (`sl-card::part(base) { border-radius: var(--radius); box-shadow: var(--shadow); }` in dashboard.css) instead of the flat-bordered look from the first Shoelace pass.

### YouTube Premium ad-free playback (v1.7.0)
`docs/player.html` switched its embed domain from `youtube-nocookie.com` to plain `youtube.com`. The nocookie domain deliberately never sends cookies, so it can never recognize a logged-in/Premium session and always shows ads regardless of the viewer's actual account status — that was the real cause, not a bug in Snackable's code. Plain `youtube.com` can honor Premium ad-free playback, but only if the viewer is logged into that Google account in the same Chrome browser, and only if Chrome's current third-party cookie policy allows the relay page (`dhanushya2406.github.io`) to see that login state when embedding YouTube — this part is genuinely untested/unconfirmed, not guaranteed.

### Storage shape (currently `chrome.storage.local` — see Known Issue)
```
queue: [{ id, title, channel, url, category, addedAt, watched, watchedAt, durationSec, embeddable }]
notes: { [videoId]: [{ ts, text }] }
highlights: { [videoId]: [{ start, end, label }] }
analyticsTotals: { [category]: totalSeconds }
```

## Known limitations (don't relitigate these, just work around them)
- **Cross-device sync is broken** — see Known Issue above. This is the most important one.
- **YouTube's DOM can change** — the scraper depends on current HTML structure (`ytd-playlist-video-renderer`, `ytd-thumbnail-overlay-time-status-renderer`, etc.). If videos or durations stop appearing, check selectors first.
- **Mobile app Watch Later additions still land in the queue fine on next sync** (Watch Later itself is account-wide), but there's no mobile *viewing* experience yet — the dashboard only exists as a Chrome extension page today.
- **`analyticsTotals` heartbeat is coarse** — +30s is credited every 30s the Watch tab is open on that video, even if the tab is backgrounded/not actually being watched.

## Not yet built (roadmap, in priority order)
- P1 (done): ~~Session mode~~ — implemented in v1.3
- P1 (done): ~~Watch log UI~~ — implemented in v1.3 as the History tab
- P0 (new, higher priority than anything below): Fix cross-device sync — see Known Issue
- P2 (done): ~~Chapter markers~~ — implemented in v1.5.0, scraped from watch-page JSON rather than the postMessage API (that channel doesn't actually expose them)
- P2: Extend the Shoelace component redesign to Queue/History/Analytics (only the Watch tab's Notes/Highlights got it in v1.5.0)
- P2: Queue health score (nudge to prune stale unwatched videos)
- P2: Insight surfacing (patterns across notes/categories over time)
- Mobile-viewable dashboard (open question — no solution decided yet)

## How I want to work on this
- Move fast, keep it simple — no over-engineering, no unnecessary infra
- Explain trade-offs plainly before building, don't just execute
- Flag when something I'm asking for won't actually work (like the cookie/API dead ends already ruled out above) rather than building it anyway
- Before starting a roadmap item, check the actual code first — this doc has drifted from reality before (see git history)
