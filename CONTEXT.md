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
- P2 (done): ~~Extend the Shoelace component redesign to Queue/History/Analytics~~ — v1.6.0, then a real visual pass (sidebar, stat cards, shadows) in v1.7.0
- P2: Queue health score (nudge to prune stale unwatched videos)
- P2: Insight surfacing (patterns across notes/categories over time)
- Mobile-viewable dashboard (open question — no solution decided yet)

### v1.7.1 — real icons, real typeface, an a11y fix
- **Icons**: the emoji icon set from v1.7.0 wasn't good enough. Replaced with [Lucide](https://lucide.dev) (ISC licensed, same permissive spirit as MIT) — vendored as individual raw SVG files in `icons/ui/` (popcorn, inbox, circle-play, list-checks, chart-column, refresh-cw, circle-check-big, clock, notebook-pen, sparkles — fetched directly from Lucide's GitHub repo, not a CDN), rendered via Shoelace's `<sl-icon src="icons/ui/name.svg">` rather than the full default icon library (which would've meant vendoring ~8.4MB of icons we don't need). Each SVG uses `stroke="currentColor"`, so icon color follows the surrounding CSS `color` like text does.
- **Font**: DM Sans, self-hosted (not a live Google Fonts dependency) at `fonts/dm-sans/` — two variable-font woff2 files (latin + latin-ext, pulled once via Google's CSS2 API) plus `dm-sans.css` with the `@font-face` rules. Both `dashboard.css`'s `body` and `shoelace-theme.css`'s `--sl-font-sans` token needed updating — Shoelace components use the token internally, not the inherited body font-family, so changing only one of the two silently misses all Shoelace-rendered text (buttons, tabs, cards, badges).
- **Fixed a real a11y bug**, not just noise: Chrome was warning `aria-hidden` was set on a tab-panel that still contained a focused element. Cause: clicking "Watch" or "Mark as watched" calls `mainTabs.show(...)` immediately, while the just-clicked button (inside the panel about to become `aria-hidden`) still has DOM focus. Fixed by calling `document.activeElement?.blur()` right before both `mainTabs.show(...)` calls.
- **Not bugs, safe to ignore**: `ERR_BLOCKED_BY_CLIENT` on `doubleclick.net`/`youtube.com/generate_204`/`youtubei/v1/log_event`, and a CORS error on `googleads.g.doubleclick.net/pagead/viewthroughconversion` — these are the browser's own ad blocker (if one is installed) blocking YouTube's ad/conversion-tracking calls from inside their player. Nothing in Snackable's code causes or can meaningfully change this.

### v1.8.0 — Queue as a card grid
Queue moved from a row list to a card grid (`.queue-grid` in dashboard.html/css), matching a reference screenshot: thumbnail fills the top of each card edge-to-edge, a white (not dark-themed) info panel sits below it with a bold title and muted subtitle, deliberately breaking from the app's dark theme *on this one element* for contrast — same pattern as notification-style cards in consumer fintech apps. A `<button class="qi-play">` overlays the thumbnail (icon fades in on hover) as the click-to-watch target, replacing the separate "Watch" button; the category `<sl-select>` moved into the white footer and got its `combobox`/`display-input` parts re-themed light to match, since the rest of Shoelace still runs dark globally (the select's popup listbox itself stays dark-themed — a Shoelace app-wide setting, not overridable per-instance without more work than this was worth).

**History intentionally still uses the old row-list layout** (`.queue-list`/`.queue-item` — not touched), a different visual language from Queue's cards. Same underlying `sl-card` class name serves both; the card-grid-specific rules are scoped with a `.queue-grid` ancestor selector so they only apply to Queue.

**Pitfall avoided, worth knowing for next time:** the new `.qi-play` overlay button shared a class with the old generic `.watch-btn` rule (background/padding/color for the plain-element Watch-tab fallback buttons). Since both were single-class selectors, whichever rule appeared later in dashboard.css would silently win per-property in the cascade — checked source order before shipping and renamed rather than assuming it'd be fine.

### v1.8.1 — undo the white card panel, redo category as a tag
v1.8.0's literal white info-panel (copying the reference screenshot exactly) clashed with the rest of the dark app rather than reading as intentional contrast — reverted to `var(--surface)` background with the normal `--text`/`--muted` palette, keeping only the *structural* pattern (thumbnail-top, info-bottom) from the reference, not its literal light-mode colors. Also replaced the boxy `sl-select` category control (too heavy for a small card footer) with a compact `sl-dropdown` + `sl-badge` "tag" trigger + `sl-menu` — click the pill, pick from the menu, badge updates immediately (before the storage round-trip finishes, to avoid flicker) and `chrome.storage.onChanged` reconciles the full re-render shortly after regardless.

### v1.8.2 — sticky header, Netflix-style card hover
- **Header**: `.page-header` (Queue/History/Analytics) was just inline content that scrolled away with everything else — not really a "header" at all. Made it `position: sticky; top: 0` with its own background and a `border-bottom`, so it now behaves like a standard persistent dashboard header while the content beneath scrolls. Implementation note: it uses negative margins (`margin: -36px -44px 28px`) to cancel `.main-tabs::part(body)`'s own padding so the header can span full-bleed edge-to-edge while everything else keeps its normal inset — avoids needing to restructure every panel's HTML with an extra wrapper div. Watch tab deliberately has no page-header — the video title already serves that role, and stacking a redundant "Watch" bar above the player would just cost vertical space.
- **Card hover**: Queue cards now scale up (`transform: scale(1.08)`) with a stronger shadow and accent-colored border on hover, `z-index` raised so the enlarged card isn't clipped by neighbors — the Netflix-tile-hover pattern. Grid row gap increased (18px → 28px vertical, column gap unchanged) to give the scaled-up card room without excessive overlap into the row below. The play-icon overlay now reveals on hovering the whole card, not just the exact button hitbox.

### v1.9.0 — History and Analytics upgraded, Queue hover smoothed
- **Queue hover**: removed the `.qi-play` overlay button entirely per feedback (it "ruined" the interaction) — the whole card is now the click target (`role="button" tabindex="0"`, keyboard-accessible too), with the category-dropdown click excluded via `e.target.closest(".category-dropdown")` so picking a category doesn't also trigger "watch". Scale reduced from 1.08→1.035, duration 280ms→200ms with a snappier easing curve, `will-change: transform` + `translateZ(0)` added for GPU compositing — meant to fix "not smooth" specifically, can't be verified without a live browser, worth confirming.
- **History** (`renderHistory()`): rebuilt from a bare `.queue-item`/`.thumb-wrap` row (shared, ad hoc classes) into its own `.history-card`/`.hc-*` component family — icon-labelled note/highlight/date stats (`notebook-pen`/`sparkles`/`calendar`) instead of emoji, Review/Unwatch as circular icon buttons (`eye`/`undo-2`) instead of bordered text buttons, subtle lift-on-hover (`translateY` + shadow, not the Queue's scale — a dense list shouldn't jump around like a tile grid).
- **Analytics** (`renderAnalytics()`): added a stat row (reusing the same `.stat-row`/`.stat-card` component as Queue — hours consumed, videos watched, categories tracked, top category by name). Per-category breakdown cards now each get a distinct color from a small fixed palette (`CATEGORY_COLORS` in dashboard.js, 6 colors, cycled by sort-rank) applied to both an icon chip and that row's `sl-progress-bar` — previously every bar was the same flat accent color, which read as visually monotonous for what's supposed to be a breakdown. Removed the old plain-text summary card in favor of the stat row.

### v1.9.1 — sidebar nav: gradient, smoother switch animation, "filled" active icons
Reference was a notification/toast card screenshot (gradient dark card, purple circular icon chip, soft depth) — not a nav pattern directly, so this translates its *visual language* (gradient depth, colored icon chip) onto the sidebar rather than literally copying a notification card:
- `.main-tabs::part(nav)` background is now a subtle top-to-bottom gradient (`#241f18` → `var(--surface)` → `var(--bg)`) instead of a flat surface color, for the same layered-depth quality the reference had.
- Re-enabled Shoelace's native `active-tab-indicator` (previously `display: none` since v1.7.0 in favor of a background pill) as a thin accent bar that slides smoothly between tabs — Shoelace animates its position/size internally via CSS `translate`/`height`, so this comes "for free" once un-hidden; just themed and given an explicit transition.
- **"Filled" active icons**: Lucide is stroke-only — confirmed no `-fill` variants exist for any of our icon names (checked directly, all 404). True filled-icon swapping isn't available without switching icon sets entirely, so the active tab's icon instead gets a solid accent-colored rounded chip behind it with the icon's own stroke color flipped to the dark bg color (`.main-tabs sl-tab[active] .nav-icon`) — reads as "filled/emphasized" without needing filled source assets. Revisit only if a literal filled icon per nav item is required later (would mean sourcing a second icon set, e.g. Heroicons solid, alongside Lucide).

### v2.0.0 — back to top navigation, Render-style breadcrumb + tabs
The same reference image came back cropped wider, making clear it wasn't a notification card at all — it was a screenshot of a dashboard's **top navigation**: a thin breadcrumb/identity bar ("‹ / [icon] production ‹") above a row of plain-text tabs ("Commands Logs Metrics ..."), from what's recognizably Render.com's own dashboard chrome (the "Hibernation" copy matches their free-tier messaging verbatim). Asked to match this "exactly."

This reverses the v1.7.0–v1.9.1 sidebar direction back to a two-row top nav:
- **`.breadcrumb-bar`**: a thin top row (icon + "Snackable" wordmark on the left, Sync button on the right) with the same gradient treatment the sidebar had. Deliberately did *not* add a fake dropdown chevron/environment-switcher like the reference's "production ⌃" — there's nothing in Snackable for it to switch between, and a non-functional affordance would be misleading.
- **`sl-tab-group` placement reverted to `"top"`** (was `"start"` since v1.7.0). Tabs are now plain text, no icons, no background pill, no colored chip — just color/weight change plus Shoelace's native sliding underline indicator, matching the reference's minimal "Commands Logs Metrics" style closely.
- This incidentally resolves the v1.9.1 "no filled icon variant exists" limitation by removing tab icons entirely rather than working around it.

Page-level content (stat rows, page headers, card grids) is unaffected — only the nav chrome changed. `.sidebar-brand`/`.nav-icon`/`.sidebar-footer` classes from the sidebar era are gone from both HTML and CSS, not just hidden.

### v2.0.1 — the indicator styling in v2.0.0 was mostly a no-op, fixed properly
Checked Shoelace's actual `tab-group` source (`vendor/shoelace/chunks/chunk.GYJIQCRZ.js`) instead of guessing at part names. Finding: `active-tab-indicator` is **not** rendered via `background`/`height` on that part at all — Shoelace draws it as a `border-bottom: solid var(--track-width) var(--indicator-color)` (for top placement), positioned by JS setting `style.translate`/`style.width` directly (see `tab-group.component`'s `syncIndicator()`-equivalent, around the `this.indicator.style.width/translate` assignments). v2.0.0's `::part(active-tab-indicator) { background: var(--accent); height: 2px; }` did nothing — the color/thickness visible were Shoelace's own defaults (`--sl-color-primary-600` from the theme remap, `--track-width: 2px`) by coincidence, not that rule.

Correct fix: set `--indicator-color`/`--track-width` as custom properties on `.main-tabs` itself (the host element — custom properties cross the shadow boundary by design, unlike `background`/`height` which the shadow template never reads for this part). For the animation itself, Shoelace's own base stylesheet already transitions `translate`/`width` using its `--sl-transition-fast` token by default — `::part(active-tab-indicator) { transition: ... }` **does** correctly override that (part-selectors from light DOM can override shadow-internal rules for that part), so the transition-tuning part of v2.0.0 was legitimate; only the color/thickness properties were the no-op. Landed on `.38s cubic-bezier(.65, 0, .35, 1)` targeting exactly `translate`/`width` (matching what Shoelace's JS actually changes — no `transform`/`height` in the list this time, since those aren't the properties being set). Also added a `prefers-reduced-motion: reduce` override since I was touching this rule anyway.

**Lesson for next time touching vendored Shoelace internals**: check `vendor/shoelace/chunks/*.js` for the component's actual JS/CSS before writing `::part()` overrides, rather than assuming a part behaves like a plain styled div — several Shoelace parts (this indicator included) render via CSS custom properties or borders rather than the properties you'd naively reach for.

### v2.0.2 — the "Mark as watched" aria-hidden warning came back, fixed the actual race
The v1.7.1 fix for this (blur before `mainTabs.show(...)`) recurred specifically on `markWatchedBtn`, not `openWatch()`. Difference between the two call sites: `openWatch()` blurs and calls `mainTabs.show("watch")` back-to-back with no `await` in between — no race possible. `markWatchedBtn`'s handler had `document.activeElement?.blur()` positioned *after* two `await chrome.storage.local.get/set(...)` calls — during that gap, something (plausibly Shoelace's own focus handling, not confirmed) could re-affirm focus on the button before the blur line ran, leaving a real race window between "storage write completes" and "blur happens."

Fixed by moving the blur to the very first line of the handler — `e.currentTarget.blur()`, executed synchronously on click before any `await`, so focus is cleared long before the panel-hiding logic runs later, not right before it.

### v2.1.0 — replaced Shoelace's indicator with a fully custom one
v2.0.1/v2.0.2 tuned Shoelace's built-in `active-tab-indicator` (correct custom properties, correct transitioned properties per its actual source) but the user reported no visible change at all — rather than keep tuning a mechanism that wasn't visibly working for unconfirmed reasons, replaced it outright with a fully custom implementation, per explicit spec:

- `#tabIndicator` (`.tab-indicator` in dashboard.css) — a single `<div slot="nav">`, sibling to the `sl-tab` elements, never recreated. Shoelace's own indicator is now `display: none`.
- `moveTabIndicator()` in dashboard.js measures the active tab (`mainTabs.querySelector("sl-tab[active]")`) via `offsetLeft`/`offsetWidth`, and sets the indicator's `transform: translateX()` + `width` to match. Both resolve against `.main-tabs::part(tabs)` (given `position: relative` for exactly this), which is the same container the indicator is slotted into, so the two coordinate systems line up.
- Runs on every `sl-tab-show` (fires identically for clicks, keyboard-arrow navigation, and programmatic `mainTabs.show(...)` calls like `openWatch()`/`markWatchedBtn` use — one code path for all of them, not handled separately per trigger).
- Initial placement covered by a double `requestAnimationFrame` (sl-tab needs to upgrade and lay out first — its `offsetWidth` is 0/wrong before that) plus a `document.fonts.ready` re-measure (DM Sans loading late can shift tab widths after the first measurement) and a `resize` listener.
- `.5s cubic-bezier(.16, 1, .3, 1)` — a springy-but-controlled ease-out, within the requested 400–600ms range.

## How I want to work on this
- Move fast, keep it simple — no over-engineering, no unnecessary infra
- Explain trade-offs plainly before building, don't just execute
- Flag when something I'm asking for won't actually work (like the cookie/API dead ends already ruled out above) rather than building it anyway
- Before starting a roadmap item, check the actual code first — this doc has drifted from reality before (see git history)
