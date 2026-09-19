// Snackable — dashboard.js (v1.3)
// Storage shape in chrome.storage.local:
//   queue: [{ id, title, channel, url, category, addedAt, watched, durationSec, embeddable }]
//   notes: { [videoId]: [{ ts, text }] }
//   highlights: { [videoId]: [{ start, end, label }] }
//   analyticsTotals: { [category]: totalSeconds }

const CATEGORIES = ["Uncategorized", "Design", "Business", "Tech", "Growth", "Personal"];

// YouTube rejects embeds from chrome-extension:// origins (seen as YouTube's
// own "This video is unavailable — Error code 152" rendered inside the
// iframe, not a client-side bug — confirmed across multiple videos,
// unaffected by the declarativeNetRequest Referer fix or an origin= param).
// Route through a relay page on a real https:// origin instead — see
// docs/player.html. It just forwards postMessage traffic both ways.
const PLAYER_ORIGIN = "https://dhanushya2406.github.io";
const PLAYER_PAGE = `${PLAYER_ORIGIN}/calude/player.html`;

let currentVideo = null;
let currentPlayerTime = 0;
let currentPlayerDuration = 0;
let timelinePollInterval = null;
let timelineDragging = false;
let isPlayerPlaying = false;
let pendingHighlightStart = null;
let watchLoadToken = 0;
let playbackConfirmed = false;
let pendingErrorTimer = null;

// ---------- Tabs ----------
const mainTabs = document.getElementById("mainTabs");
const tabIndicator = document.getElementById("tabIndicator");

// .sidebar-brand and .sidebar-footer are slotted into "nav" alongside the
// real <sl-tab> elements so they stack in one visual column — but
// Shoelace's getAllTabs() does `slot.assignedElements()` with NO
// tag-name filtering, so without this they'd be walked as phantom tabs
// by its own keyboard-nav indexing (findNextFocusableTab filters on
// `!el.disabled`, and Home/End index into that same filtered list).
// Setting the plain JS property here (not an HTML attribute, no visual
// effect on a div) makes Shoelace's own filter exclude them correctly.
document.getElementById("sidebarBrand").disabled = true;
document.getElementById("sidebarFooter").disabled = true;

// Custom tab indicator — a single element, never recreated, moved by
// measuring the active <sl-tab> and animating transform/height via CSS
// (see .tab-indicator). Shoelace's own built-in indicator is turned off
// (display: none) in favor of this.
//
// It's position: fixed and lives as a plain sibling of sl-tab-group, NOT
// slot="nav" (same phantom-tab reason as above). getBoundingClientRect()
// returns viewport coordinates, which line up directly with `fixed`
// positioning — no wrapper/ancestor math needed.
function moveTabIndicator() {
  const activeTab = mainTabs.querySelector("sl-tab[active]");
  if (!activeTab || !tabIndicator) return;
  const tabRect = activeTab.getBoundingClientRect();
  tabIndicator.style.height = `${tabRect.height}px`;
  tabIndicator.style.transform = `translateY(${tabRect.top}px)`;
}

mainTabs.addEventListener("sl-tab-show", (e) => {
  if (e.detail.name === "analytics") renderAnalytics();
  if (e.detail.name === "history") renderHistory();
  if (e.detail.name === "notes") loadKnowledgeTab();
  moveTabIndicator();
});

// The Tiptap/Sigma.js/Graphology bundle (dist/knowledge.bundle.js, built
// from src/knowledge/ via `npm run build` — the one part of Snackable that
// goes through an actual build step) is loaded lazily via dynamic import
// on first opening the Notes tab, not a static <script> tag — it's ~900KB,
// no reason to pay that cost for people who never open this tab. The
// browser caches the module after the first import(), so re-opening the
// tab is cheap; window.SnackableKnowledge.init() itself also no-ops after
// the first successful mount (see src/knowledge/index.js).
async function loadKnowledgeTab() {
  const root = document.getElementById("knowledgeRoot");
  try {
    await import("/dist/knowledge.bundle.js");
    await window.SnackableKnowledge.init(root);
  } catch (err) {
    console.error("Snackable: failed to load knowledge bundle", err);
    root.innerHTML = `<div class="empty-state">Couldn't load the Notes view. Check the console.</div>`;
  }
}

// Chrome's "aria-hidden on an element containing focus" warning: Shoelace's
// setActiveTab() (tab-group source) never blurs anything — it only flips
// `active` on tabs/panels and emits sl-tab-hide/sl-tab-show, leaving focus
// management entirely to the consumer. sl-tab-panel's active->aria-hidden
// reflection happens in its `watch("active")` handler, which (like all Lit
// reactive updates) runs on the NEXT microtask, not synchronously — so
// blurring here, synchronously inside the sl-tab-hide handler (which fires
// before that microtask), is guaranteed to land before aria-hidden is
// actually applied. This one handler covers every path that hides a panel
// (native tab clicks, keyboard nav, and our own programmatic
// mainTabs.show() calls in openWatch()/markWatchedBtn) instead of needing
// a blur() call duplicated at each call site — and native tab clicks
// specifically had NO blur handling at all before this.
mainTabs.addEventListener("sl-tab-hide", (e) => {
  const panel = mainTabs.querySelector(`sl-tab-panel[name="${e.detail.name}"]`);
  if (panel?.contains(document.activeElement)) {
    document.activeElement.blur();
  }
});

// Initial placement: sl-tab needs to be upgraded and laid out first (its
// rect is 0/wrong before that), and DM Sans loading late can also shift
// tab widths — cover both with a couple of rAFs plus a fonts-ready
// re-measure, all cheap and idempotent.
requestAnimationFrame(() => requestAnimationFrame(moveTabIndicator));
document.fonts?.ready?.then(moveTabIndicator);
window.addEventListener("resize", moveTabIndicator);

document.getElementById("syncNowBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const label = document.getElementById("syncBtnLabel");
  btn.loading = true;
  label.textContent = "Syncing…";
  await chrome.runtime.sendMessage({ type: "SNACKABLE_SYNC_NOW" });
  btn.loading = false;
  label.textContent = "Sync now";
  renderQueue();
  renderStats();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.queue) renderQueue();
  if (changes.queue || changes.notes || changes.highlights || changes.analyticsTotals) renderStats();
});

// ---------- Stat cards ----------
async function renderStats() {
  const row = document.getElementById("statRow");
  const { queue = [], notes = {}, highlights = {}, analyticsTotals = {} } = await chrome.storage.local.get([
    "queue",
    "notes",
    "highlights",
    "analyticsTotals",
  ]);
  const queueCount = queue.filter((v) => !v.watched).length;
  const watchedCount = queue.filter((v) => v.watched).length;
  const totalHours = Object.values(analyticsTotals).reduce((a, b) => a + b, 0) / 3600;
  const noteCount = Object.values(notes).reduce((a, list) => a + list.length, 0);
  const highlightCount = Object.values(highlights).reduce((a, list) => a + list.length, 0);

  const stats = [
    { icon: "inbox", label: "In queue", value: String(queueCount) },
    { icon: "circle-check-big", label: "Watched", value: String(watchedCount) },
    { icon: "clock", label: "Hours consumed", value: totalHours.toFixed(1) },
    { icon: "notebook-pen", label: "Notes captured", value: String(noteCount + highlightCount) },
  ];

  row.innerHTML = stats
    .map(
      (s) => `
      <sl-card class="stat-card">
        <div class="stat-icon"><sl-icon src="icons/ui/${s.icon}.svg"></sl-icon></div>
        <div class="stat-body">
          <div class="stat-value">${s.value}</div>
          <div class="stat-label">${s.label}</div>
        </div>
      </sl-card>`
    )
    .join("");
}

// ---------- Queue ----------
document.getElementById("sessionMinutes").addEventListener("sl-change", renderQueue);
document.getElementById("hideNonEmbeddable").addEventListener("sl-change", renderQueue);

async function renderQueue() {
  const { queue = [] } = await chrome.storage.local.get("queue");
  const list = document.getElementById("queueList");
  const fitCount = document.getElementById("sessionFitCount");
  list.innerHTML = "";

  const unwatched = queue.filter((v) => !v.watched);

  if (unwatched.length === 0) {
    list.innerHTML = `<div class="empty-state">Nothing here yet. Add a video to YouTube's Watch Later and it'll show up on the next sync.</div>`;
    fitCount.style.display = "none";
    return;
  }
  fitCount.style.display = "";

  const hideNonEmbed = document.getElementById("hideNonEmbeddable").checked;
  const sessionMin = parseInt(document.getElementById("sessionMinutes").value, 10);
  const sessionSec = sessionMin * 60;

  let filtered = unwatched;
  if (hideNonEmbed) {
    filtered = filtered.filter((v) => v.embeddable !== false);
  }

  // Session mode: accumulate duration and show only what fits
  let shown = filtered;
  if (sessionSec > 0) {
    let accumulated = 0;
    shown = [];
    for (const v of filtered) {
      const dur = v.durationSec || 0;
      if (dur === 0) {
        // Unknown duration — include it but don't count against budget
        shown.push(v);
        continue;
      }
      if (accumulated + dur <= sessionSec) {
        accumulated += dur;
        shown.push(v);
      }
    }
    const shownWithDur = shown.filter((v) => v.durationSec > 0);
    const totalMin = Math.round(shownWithDur.reduce((s, v) => s + (v.durationSec || 0), 0) / 60);
    fitCount.textContent = `— ${shownWithDur.length} video${shownWithDur.length !== 1 ? "s" : ""}, ~${totalMin} min`;
  } else {
    fitCount.textContent = `— ${filtered.length} video${filtered.length !== 1 ? "s" : ""}`;
  }

  list.innerHTML = shown
    .map((v) => {
      const embedBadge = v.embeddable === false
        ? `<sl-badge variant="warning" pill class="qi-embed-badge" title="Embedding disabled by creator">⊘ No embed</sl-badge>`
        : "";
      const durLabel = v.durationSec
        ? `<span class="duration-label">${formatDuration(v.durationSec)}</span>`
        : "";

      return `
        <sl-card class="queue-item" data-id="${v.id}" role="button" tabindex="0" aria-label="Watch ${escapeHtml(v.title)}">
          <div class="qi-media">
            <img src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="">
            ${embedBadge}
            ${durLabel}
          </div>
          <div class="qi-info">
            <h4>${escapeHtml(v.title)}</h4>
            <span class="qi-channel">${escapeHtml(v.channel)}</span>
            <sl-dropdown data-id="${v.id}" class="category-dropdown">
              <sl-badge slot="trigger" variant="neutral" pill class="category-badge">${escapeHtml(v.category)}</sl-badge>
              <sl-menu>
                ${CATEGORIES.map((c) => `<sl-menu-item value="${escapeHtml(c)}">${escapeHtml(c)}</sl-menu-item>`).join("")}
              </sl-menu>
            </sl-dropdown>
          </div>
        </sl-card>`;
    })
    .join("");

  list.querySelectorAll(".category-dropdown").forEach((dd) => {
    dd.addEventListener("sl-select", async (e) => {
      const category = e.detail.item.value;
      const { queue = [] } = await chrome.storage.local.get("queue");
      const v = queue.find((x) => x.id === dd.dataset.id);
      if (v) v.category = category;
      await chrome.storage.local.set({ queue });
      dd.querySelector(".category-badge").textContent = category;
    });
  });

  list.querySelectorAll(".queue-item").forEach((card) => {
    const trigger = async () => {
      const { queue = [] } = await chrome.storage.local.get("queue");
      const v = queue.find((x) => x.id === card.dataset.id);
      if (v) openWatch(v);
    };
    card.addEventListener("click", (e) => {
      if (e.target.closest(".category-dropdown")) return;
      trigger();
    });
    card.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.target.closest(".category-dropdown")) {
        e.preventDefault();
        trigger();
      }
    });
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

function formatDuration(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTime(sec) {
  return formatDuration(sec);
}

// ---------- Watch + custom postMessage player bridge ----------
function openWatch(video) {
  currentVideo = video;
  pendingHighlightStart = null;
  playbackConfirmed = false;
  currentPlayerTime = 0;
  currentPlayerDuration = 0;
  isPlayerPlaying = false;
  updatePlayPauseIcon();
  const token = ++watchLoadToken;
  clearTimeout(pendingErrorTimer);
  pendingErrorTimer = null;

  // Focus-before-hide is handled centrally by the sl-tab-hide listener
  // above — no need to blur here too.
  mainTabs.show("watch");
  document.getElementById("watchEmpty").style.display = "none";
  document.getElementById("watchActive").style.display = "flex";
  document.getElementById("watchTitle").textContent = video.title;
  document.getElementById("watchChannel").textContent = video.channel;
  document.getElementById("watchExternalLink").href = video.url;
  document.getElementById("markEnd").disabled = true;
  document.getElementById("highlightStatus").textContent = "";
  updateTimelineUI();

  const playerDiv = document.getElementById("player");
  playerDiv.innerHTML = `<iframe id="ytFrame"
    src="${PLAYER_PAGE}?v=${encodeURIComponent(video.id)}"
    referrerpolicy="strict-origin-when-cross-origin"
    allow="autoplay; encrypted-media" allowfullscreen></iframe>`;

  const frame = document.getElementById("ytFrame");
  frame.addEventListener("load", () => {
    postToPlayer({ event: "listening", id: "snackable" });
  });

  startTimelinePolling(video, token);
  renderNotesAndHighlights();
  trackWatchSession(video);
  loadChapters(video);
}

// Best-effort chapter extraction from YouTube's watch-page JSON (same class
// of fragility as background.js's DOM scraper — if YouTube changes this
// structure, chapters just silently stop appearing rather than erroring).
async function loadChapters(video) {
  const token = watchLoadToken;
  const section = document.getElementById("chapterSection");
  const list = document.getElementById("chapterList");
  section.style.display = "none";
  list.innerHTML = "";
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`);
    const html = await resp.text();
    if (token !== watchLoadToken) return; // user moved on to another video
    const chapters = extractChaptersFromWatchHtml(html);
    if (!chapters.length) return;
    list.innerHTML = chapters
      .map(
        (c) => `<div class="chapter-item" data-seek="${c.startSec}">
          <span class="chapter-time">${formatTime(c.startSec)}</span>
          <span class="chapter-title">${escapeHtml(c.title)}</span>
        </div>`
      )
      .join("");
    list.querySelectorAll(".chapter-item").forEach((el) => {
      el.addEventListener("click", () => seekTo(Number(el.dataset.seek)));
    });
    section.style.display = "block";
  } catch (e) {
    console.warn("Snackable: chapter fetch failed", e);
  }
}

function extractChaptersFromWatchHtml(html) {
  const match = html.match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{.+?\});/s);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  let found = [];
  (function walk(node) {
    if (found.length || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (Array.isArray(node.chapters) && node.chapters[0]?.chapterRenderer) {
      found = node.chapters
        .map((ch) => {
          const r = ch.chapterRenderer;
          return {
            title: r?.title?.simpleText || "",
            startSec: Math.round(Number(r?.timeRangeStartMillis || 0) / 1000),
          };
        })
        .filter((c) => c.title);
      return;
    }
    for (const key in node) walk(node[key]);
  })(data);
  return found;
}

function postToPlayer(msg) {
  const frame = document.getElementById("ytFrame");
  if (frame?.contentWindow) {
    // Goes to the relay page (docs/player.html), which forwards it into the
    // actual YouTube iframe it hosts.
    frame.contentWindow.postMessage(JSON.stringify(msg), PLAYER_ORIGIN);
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== PLAYER_ORIGIN) return;
  try {
    const data = JSON.parse(event.data);
    if (data.info && typeof data.info.currentTime === "number") {
      currentPlayerTime = data.info.currentTime;
      // Any real telemetry from the player means the postMessage channel is
      // alive and the video isn't actually stuck, regardless of stray error
      // events fired earlier during the handshake.
      playbackConfirmed = true;
      clearTimeout(pendingErrorTimer);
      pendingErrorTimer = null;
      if (typeof data.info.duration === "number" && data.info.duration > 0) {
        currentPlayerDuration = data.info.duration;
      }
      if (!timelineDragging) updateTimelineUI();
    }
    if (data.event === "onStateChange") {
      // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
      isPlayerPlaying = data.info === 1;
      updatePlayPauseIcon();
    }
    if (data.event === "onError") {
      const code = data.info;
      const token = watchLoadToken;
      console.warn("Snackable: YouTube player onError", code, "video:", currentVideo?.id);
      // 101/150 = owner disabled embedding — unambiguous, documented codes.
      // 100 = video removed/private — also unambiguous.
      // Everything else (2/5/152/153/other) isn't reliably fatal in this
      // hand-rolled setup (no official iframe_api — MV3 blocks loading it),
      // so wait for real playback telemetry before treating it as broken.
      if (code === 101 || code === 150) {
        showEmbedDisabledFallback();
      } else if (code === 100) {
        showPlaybackErrorFallback(code);
      } else {
        clearTimeout(pendingErrorTimer);
        pendingErrorTimer = setTimeout(() => {
          if (token === watchLoadToken && !playbackConfirmed) {
            showPlaybackErrorFallback(code);
          }
        }, 4000);
      }
    }
  } catch (_) {}
});

function showEmbedDisabledFallback() {
  if (!currentVideo) return;
  const playerDiv = document.getElementById("player");
  playerDiv.innerHTML = `
    <div class="embed-disabled">
      <div class="embed-disabled-icon">🚫</div>
      <h3>This creator disabled embedding for this video</h3>
      <p>Open it on YouTube — your notes and highlights will still save here.</p>
      <a href="${currentVideo.url}" target="_blank" class="watch-btn">Open on YouTube ↗</a>
    </div>
  `;
}

function showPlaybackErrorFallback(code) {
  if (!currentVideo) return;
  const video = currentVideo;
  const playerDiv = document.getElementById("player");
  const label = code === 100 ? "This video was removed or made private" : `Playback failed (error ${code})`;
  playerDiv.innerHTML = `
    <div class="embed-disabled">
      <div class="embed-disabled-icon">⚠️</div>
      <h3>${escapeHtml(label)}</h3>
      <p>${code === 100 ? "It's no longer available on YouTube." : "This is usually temporary, not a creator restriction — try again or open it on YouTube."} Your notes and highlights will still save here.</p>
      ${code === 100 ? "" : `<button id="retryPlaybackBtn" class="watch-btn">↻ Retry</button>`}
      <a href="${video.url}" target="_blank" class="watch-btn">Open on YouTube ↗</a>
    </div>
  `;
  document.getElementById("retryPlaybackBtn")?.addEventListener("click", () => openWatch(video));
}

// ---------- Mark as watched ----------
document.getElementById("markWatchedBtn").addEventListener("click", async () => {
  if (!currentVideo) return;
  // Focus-before-hide is handled centrally by the sl-tab-hide listener
  // above — no need to blur here too.
  const { queue = [] } = await chrome.storage.local.get("queue");
  const v = queue.find((x) => x.id === currentVideo.id);
  if (v) {
    v.watched = true;
    v.watchedAt = Date.now();
  }
  await chrome.storage.local.set({ queue });
  // Go back to queue
  currentVideo = null;
  clearInterval(timelinePollInterval);
  document.getElementById("watchActive").style.display = "none";
  document.getElementById("watchEmpty").style.display = "block";
  mainTabs.show("queue");
});

// ---------- Notes ----------
document.getElementById("captureNoteBtn").addEventListener("click", async () => {
  if (!currentVideo) return;
  const { notes = {} } = await chrome.storage.local.get("notes");
  const list = notes[currentVideo.id] || [];
  list.push({ ts: currentPlayerTime, text: "" });
  notes[currentVideo.id] = list;
  await chrome.storage.local.set({ notes });
  renderNotesAndHighlights();
});

// ---------- Highlights ----------
document.getElementById("markStart").addEventListener("click", () => {
  pendingHighlightStart = currentPlayerTime;
  document.getElementById("markEnd").disabled = false;
  document.getElementById("highlightStatus").textContent = `Start marked at ${formatTime(currentPlayerTime)}`;
});

document.getElementById("markEnd").addEventListener("click", async () => {
  if (pendingHighlightStart === null || !currentVideo) return;
  const label = prompt("Label this highlight (optional):", "") || "";
  const { highlights = {} } = await chrome.storage.local.get("highlights");
  const list = highlights[currentVideo.id] || [];
  list.push({ start: pendingHighlightStart, end: currentPlayerTime, label });
  highlights[currentVideo.id] = list;
  await chrome.storage.local.set({ highlights });
  pendingHighlightStart = null;
  document.getElementById("markEnd").disabled = true;
  document.getElementById("highlightStatus").textContent = "Highlight saved.";
  renderNotesAndHighlights();
});

function seekTo(seconds) {
  postToPlayer({ event: "command", func: "seekTo", args: [seconds, true] });
}

// ---------- Custom timeline (replaces YouTube's own control bar, which is
// suppressed via controls=0 in docs/player.html) ----------
function currentDuration() {
  return currentPlayerDuration > 0 ? currentPlayerDuration : currentVideo?.durationSec || 0;
}

function updateTimelineUI() {
  const duration = currentDuration();
  const pct = duration > 0 ? Math.min(100, (currentPlayerTime / duration) * 100) : 0;
  document.getElementById("timelineFill").style.width = `${pct}%`;
  document.getElementById("timelineHandle").style.left = `${pct}%`;
  document.getElementById("timelineCurrent").textContent = formatTime(currentPlayerTime);
  document.getElementById("timelineDuration").textContent = duration > 0 ? formatTime(duration) : "0:00";
}

// There's no synchronous getCurrentTime() available to us — no official
// iframe_api (CSP-blocked), just the raw postMessage protocol — so "polling
// getCurrentTime()" here means periodically asking the player to report it,
// same pattern as every other command already sent this way (seekTo, etc.).
// The actual value arrives back through the existing message listener,
// which updates currentPlayerTime/currentPlayerDuration and calls
// updateTimelineUI() itself.
function startTimelinePolling(video, token) {
  clearInterval(timelinePollInterval);
  timelinePollInterval = setInterval(() => {
    if (token !== watchLoadToken) {
      clearInterval(timelinePollInterval);
      return;
    }
    postToPlayer({ event: "command", func: "getCurrentTime", args: [] });
  }, 500);
}

function seekFromTimelineEvent(clientX) {
  const track = document.getElementById("timelineTrack");
  const duration = currentDuration();
  if (duration <= 0) return;
  const rect = track.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const target = frac * duration;
  currentPlayerTime = target;
  updateTimelineUI();
  seekTo(target);
}

function updatePlayPauseIcon() {
  const icon = document.getElementById("playPauseIcon");
  const btn = document.getElementById("playPauseBtn");
  icon.src = isPlayerPlaying ? "icons/ui/pause.svg" : "icons/ui/play.svg";
  btn.setAttribute("aria-label", isPlayerPlaying ? "Pause" : "Play");
}

document.getElementById("playPauseBtn").addEventListener("click", () => {
  // Optimistic — the real onStateChange event (handled above) reconciles
  // this shortly after, same pattern as the timeline's own optimistic seek.
  isPlayerPlaying = !isPlayerPlaying;
  updatePlayPauseIcon();
  postToPlayer({ event: "command", func: isPlayerPlaying ? "playVideo" : "pauseVideo", args: [] });
});

(() => {
  const track = document.getElementById("timelineTrack");
  track.addEventListener("pointerdown", (e) => {
    timelineDragging = true;
    track.classList.add("dragging");
    track.setPointerCapture(e.pointerId);
    seekFromTimelineEvent(e.clientX);
  });
  track.addEventListener("pointermove", (e) => {
    if (timelineDragging) seekFromTimelineEvent(e.clientX);
  });
  const endDrag = (e) => {
    if (!timelineDragging) return;
    timelineDragging = false;
    track.classList.remove("dragging");
    track.releasePointerCapture(e.pointerId);
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
})();

async function renderNotesAndHighlights() {
  if (!currentVideo) return;
  const { notes = {}, highlights = {} } = await chrome.storage.local.get(["notes", "highlights"]);

  const noteList = document.getElementById("noteList");
  const videoNotes = notes[currentVideo.id] || [];
  noteList.innerHTML = videoNotes
    .map(
      (n, i) => `
      <sl-card class="note-card">
        <sl-badge slot="header" variant="neutral" pill class="ts-badge" data-seek="${n.ts}">${formatTime(n.ts)}</sl-badge>
        <sl-textarea data-idx="${i}" rows="2" placeholder="What stood out?" resize="none"></sl-textarea>
      </sl-card>`
    )
    .join("") || `<div class="muted">No notes yet.</div>`;

  // Set via the property, not an HTML attribute, so note text containing
  // quotes/special characters can't break out of the markup.
  noteList.querySelectorAll("sl-textarea").forEach((ta) => {
    ta.value = videoNotes[Number(ta.dataset.idx)]?.text || "";
  });

  noteList.querySelectorAll("sl-textarea").forEach((ta) => {
    ta.addEventListener("sl-blur", async () => {
      const { notes = {} } = await chrome.storage.local.get("notes");
      const list = notes[currentVideo.id] || [];
      if (list[ta.dataset.idx]) list[ta.dataset.idx].text = ta.value;
      notes[currentVideo.id] = list;
      await chrome.storage.local.set({ notes });
    });
  });

  noteList.querySelectorAll(".ts-badge").forEach((badge) => {
    badge.addEventListener("click", () => seekTo(Number(badge.dataset.seek)));
  });

  const hlList = document.getElementById("highlightList");
  const videoHighlights = highlights[currentVideo.id] || [];
  hlList.innerHTML = videoHighlights
    .map(
      (h) => `
      <sl-card class="highlight-card">
        <div slot="header" class="highlight-card-header">
          <sl-badge variant="primary" pill class="ts-badge" data-seek="${h.start}">${formatTime(h.start)} – ${formatTime(h.end)}</sl-badge>
        </div>
        <div>${escapeHtml(h.label || "(no label)")}</div>
      </sl-card>`
    )
    .join("") || `<div class="muted">No highlights yet.</div>`;

  hlList.querySelectorAll(".ts-badge").forEach((badge) => {
    badge.addEventListener("click", () => seekTo(Number(badge.dataset.seek)));
  });
}

// ---------- Watch session → analytics ----------
function trackWatchSession(video) {
  const interval = setInterval(async () => {
    if (currentVideo?.id !== video.id) {
      clearInterval(interval);
      return;
    }
    const { analyticsTotals = {} } = await chrome.storage.local.get("analyticsTotals");
    analyticsTotals[video.category] = (analyticsTotals[video.category] || 0) + 30;
    await chrome.storage.local.set({ analyticsTotals });
  }, 30000);
}

// ---------- History (watched videos) ----------
async function renderHistory() {
  const { queue = [], notes = {}, highlights = {} } = await chrome.storage.local.get(["queue", "notes", "highlights"]);
  const list = document.getElementById("historyList");
  const watched = queue.filter((v) => v.watched).sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));

  if (watched.length === 0) {
    list.innerHTML = `<div class="empty-state">No videos watched yet. Start one from your Queue!</div>`;
    return;
  }

  list.innerHTML = watched
    .map((v) => {
      const noteCount = (notes[v.id] || []).length;
      const hlCount = (highlights[v.id] || []).length;
      const watchedDate = v.watchedAt ? new Date(v.watchedAt).toLocaleDateString() : "";
      const durLabel = v.durationSec ? formatDuration(v.durationSec) : "";

      return `
        <sl-card class="history-card">
          <div class="hc-thumb">
            <img src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="">
            ${durLabel ? `<span class="duration-label">${durLabel}</span>` : ""}
          </div>
          <div class="hc-info">
            <h4>${escapeHtml(v.title)}</h4>
            <span class="hc-channel">${escapeHtml(v.channel)}</span>
            <div class="hc-meta">
              <sl-badge variant="neutral" pill>${escapeHtml(v.category)}</sl-badge>
              ${noteCount ? `<span class="hc-stat"><sl-icon src="icons/ui/notebook-pen.svg"></sl-icon>${noteCount}</span>` : ""}
              ${hlCount ? `<span class="hc-stat"><sl-icon src="icons/ui/sparkles.svg"></sl-icon>${hlCount}</span>` : ""}
              ${watchedDate ? `<span class="hc-stat hc-date"><sl-icon src="icons/ui/calendar.svg"></sl-icon>${watchedDate}</span>` : ""}
            </div>
          </div>
          <div class="hc-actions">
            <button class="icon-btn review-btn" data-id="${v.id}" title="Review" aria-label="Review">
              <sl-icon src="icons/ui/eye.svg"></sl-icon>
            </button>
            <button class="icon-btn unwatch-btn" data-id="${v.id}" title="Move back to queue" aria-label="Move back to queue">
              <sl-icon src="icons/ui/undo-2.svg"></sl-icon>
            </button>
          </div>
        </sl-card>`;
    })
    .join("");

  list.querySelectorAll(".review-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { queue = [] } = await chrome.storage.local.get("queue");
      const v = queue.find((x) => x.id === btn.dataset.id);
      if (v) openWatch(v);
    });
  });

  list.querySelectorAll(".unwatch-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { queue = [] } = await chrome.storage.local.get("queue");
      const v = queue.find((x) => x.id === btn.dataset.id);
      if (v) {
        v.watched = false;
        delete v.watchedAt;
      }
      await chrome.storage.local.set({ queue });
      renderHistory();
    });
  });
}

// ---------- Analytics ----------
const CATEGORY_COLORS = ["#d97757", "#7ca8d9", "#7fae76", "#c99bde", "#d4a04a", "#e08cae"];

async function renderAnalytics() {
  const { analyticsTotals = {}, queue = [] } = await chrome.storage.local.get(["analyticsTotals", "queue"]);
  const totalSeconds = Object.values(analyticsTotals).reduce((a, b) => a + b, 0);
  const watchedCount = queue.filter((v) => v.watched).length;
  const entries = Object.entries(analyticsTotals).sort((a, b) => b[1] - a[1]);

  const statRow = document.getElementById("analyticsStatRow");
  const topCategory = entries[0]?.[0] || "—";
  const stats = [
    { icon: "clock", label: "Hours consumed", value: (totalSeconds / 3600).toFixed(1) },
    { icon: "circle-check-big", label: "Videos watched", value: String(watchedCount) },
    { icon: "tags", label: "Categories tracked", value: String(entries.length) },
    { icon: "trending-up", label: "Top category", value: topCategory, isText: true },
  ];
  statRow.innerHTML = stats
    .map(
      (s) => `
      <sl-card class="stat-card">
        <div class="stat-icon"><sl-icon src="icons/ui/${s.icon}.svg"></sl-icon></div>
        <div class="stat-body">
          <div class="stat-value${s.isText ? " stat-value-text" : ""}">${escapeHtml(s.value)}</div>
          <div class="stat-label">${s.label}</div>
        </div>
      </sl-card>`
    )
    .join("");

  const maxVal = Math.max(...entries.map(([, secs]) => secs), 1);
  const bars = document.getElementById("analyticsBars");

  if (entries.length === 0) {
    bars.innerHTML = `<div class="empty-state">No watch time recorded yet — open something from your Queue.</div>`;
    return;
  }

  bars.innerHTML = entries
    .map(([cat, secs], i) => {
      const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
      const pct = Math.round((secs / totalSeconds) * 100);
      return `
      <sl-card class="bar-row">
        <div class="bar-icon" style="background:${color}22; color:${color};"><sl-icon src="icons/ui/chart-column.svg"></sl-icon></div>
        <div class="bar-main">
          <div class="bar-top-row">
            <span class="bar-label">${escapeHtml(cat)}</span>
            <span class="bar-value">${(secs / 3600).toFixed(1)}h · ${pct}%</span>
          </div>
          <sl-progress-bar value="${Math.round((secs / maxVal) * 100)}" class="bar-track" style="--indicator-color:${color};"></sl-progress-bar>
        </div>
      </sl-card>`;
    })
    .join("");
}

renderQueue();
renderStats();

// Shoelace's autoloader swallows component-registration failures silently
// (no console error even when every <sl-*> element fails to upgrade — this
// bit us once already, see git history around v1.5.1). This is a canary:
// if sl-button still isn't defined after a few seconds, say so loudly.
setTimeout(() => {
  if (!customElements.get("sl-button")) {
    console.error(
      "Snackable: Shoelace components never registered — buttons/cards will render unstyled. " +
      "Check that vendor/shoelace/ files exist and that dashboard.html's autoloader <script src> is a root-relative path (starts with '/')."
    );
  }
}, 3000);
