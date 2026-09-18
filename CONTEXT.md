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

## ⚠️ Known issue — cross-device sync is currently broken
The original design (see above) depends on `chrome.storage.sync` to get free cross-device sync. **The actual v1.3 code uses `chrome.storage.local` everywhere** (queue, notes, highlights, analyticsTotals) — likely swapped in to avoid `storage.sync`'s ~100KB quota once `durationSec`/`embeddable` fields and notes grew the payload. This means the extension currently only works on a single device/browser profile; the core "add from phone, see it on desktop" promise does not hold today.

Not yet resolved — options when revisited: shard data across `storage.sync` keys to stay under quota, sync only lightweight fields (ids/metadata) via `storage.sync` and keep bulky notes/highlights in `storage.local`, or accept single-device and find another sync path.

## How data gets in (the key architectural decision)
YouTube's Watch Later playlist is **account-tied and syncs automatically across every device already** — add from phone, it's there on desktop. The YouTube Data API has never allowed third-party read/write access to this specific playlist (confirmed via research, deprecated since 2016) — but a browser extension can just *read the rendered page* (`youtube.com/playlist?list=WL`) since it's a normal logged-in page view, no API needed.

Once read, the plan was for `chrome.storage.sync` to auto-sync that data across every Chrome browser signed into the same Google account, replacing the need for a custom backend/database. **This part isn't working today** — see Known Issue above.

## Current State — v1.3 (Manifest V3 Chrome extension)
Two parts:

1. **`background.js`** — service worker. Every 15 min (`chrome.alarms`), opens Watch Later in a hidden background tab, runs a DOM-scraping function (`chrome.scripting.executeScript`) to extract `{id, title, channel, url, durationSec}` per video (duration parsed from the thumbnail overlay text), dedupes/backfills against the existing queue, saves to `chrome.storage.local`, closes the tab. Also registers `declarativeNetRequest` rules to set a `Referer` header on embedded-player requests (MV3 extension pages don't send one by default, which otherwise breaks playback with error 152/153). Separately checks embeddability per video via the YouTube oEmbed endpoint (batches of 5, throttled) and stores `embeddable: true/false/null`.
2. **`dashboard.html/js/css`** — the app UI, opened from the toolbar icon. Four tabs:
   - **Queue** — unwatched videos, with a **session-time filter** ("I have 30/60/90/120 min" → greedily fills the list up to the budget using `durationSec`, unknown-duration videos always included), an "Embeddable only" toggle to hide videos with embedding disabled, category dropdown per video, "Watch" button
   - **Watch** — embedded YouTube iframe (`youtube-nocookie.com/embed/{id}?enablejsapi=1`), custom `postMessage` protocol for tracking current playback time (NOT the official `iframe_api` script — that's blocked by MV3's CSP, which disallows remote scripts in extension pages), timestamped note capture, highlight start/end marking, "Mark as watched," and a fallback panel if embedding fails (error codes 101/150/152) linking out to YouTube while still allowing notes
   - **History** — watched videos, sorted newest first, showing category/note count/highlight count/watched date, "Review" (reopen in Watch tab) and "↩ move back to queue"
   - **Analytics** — hours consumed by category (bar chart) built from `analyticsTotals`, which heartbeats +30s every 30s while a video is open in the Watch tab

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
- P2: Chapter markers (YouTube exposes these via the postMessage API already in use)
- P2: Queue health score (nudge to prune stale unwatched videos)
- P2: Insight surfacing (patterns across notes/categories over time)
- Mobile-viewable dashboard (open question — no solution decided yet)

## How I want to work on this
- Move fast, keep it simple — no over-engineering, no unnecessary infra
- Explain trade-offs plainly before building, don't just execute
- Flag when something I'm asking for won't actually work (like the cookie/API dead ends already ruled out above) rather than building it anyway
- Before starting a roadmap item, check the actual code first — this doc has drifted from reality before (see git history)
