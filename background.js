// Snackable — background.js (v1.3)
// Job: periodically open Watch Later in a hidden tab, read the video list
// off the page (including duration), dedupe against what we already have,
// check embeddability for new items, and store everything.

const SYNC_ALARM = "snackable-sync";
const WATCH_LATER_URL = "https://www.youtube.com/playlist?list=WL";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 15 });
  registerRefererFixRule();
  syncWatchLater();
});

chrome.runtime.onStartup.addListener(() => {
  registerRefererFixRule();
  syncWatchLater();
});

// Chrome extension pages don't send a Referer header on outgoing requests,
// and YouTube's embedded player requires one — without it, playback fails
// with Error 153 or 152. Uses DYNAMIC rules so the fix persists across
// service worker restarts (MV3 workers die after ~30s idle).
async function registerRefererFixRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Referer", operation: "set", value: "https://www.youtube.com/" }],
          },
          condition: {
            urlFilter: "||youtube.com/embed/",
            resourceTypes: ["sub_frame"],
            initiatorDomains: [chrome.runtime.id],
          },
        },
        {
          id: 2,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Referer", operation: "set", value: "https://www.youtube.com/" }],
          },
          condition: {
            urlFilter: "||youtube-nocookie.com/embed/",
            resourceTypes: ["sub_frame"],
            initiatorDomains: [chrome.runtime.id],
          },
        },
      ],
    });
    const active = await chrome.declarativeNetRequest.getDynamicRules();
    console.log("Snackable: Referer fix rules active:", active.map((r) => r.id));
  } catch (e) {
    console.warn("Snackable: failed to register Referer rule:", e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncWatchLater();
});

// Let the dashboard trigger a manual sync and open the dashboard from the toolbar icon.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SNACKABLE_SYNC_NOW") {
    syncWatchLater().then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// Injected into the actual youtube.com/playlist?list=WL tab.
// Must be self-contained — chrome.scripting.executeScript serializes it.
function extractWatchLaterFromPage() {
  const rows = document.querySelectorAll("ytd-playlist-video-renderer");
  const items = [];
  rows.forEach((row) => {
    const titleEl = row.querySelector("#video-title");
    const channelEl = row.querySelector("ytd-channel-name a, ytd-channel-name yt-formatted-string");
    const href = titleEl?.getAttribute("href") || "";
    const match = href.match(/v=([^&]+)/);
    const videoId = match ? match[1] : null;
    if (!videoId) return;

    // Duration lives in the thumbnail overlay — text like "12:34" or "1:02:15"
    const durationEl = row.querySelector(
      "ytd-thumbnail-overlay-time-status-renderer #text, " +
      "ytd-thumbnail-overlay-time-status-renderer .ytd-thumbnail-overlay-time-status-renderer"
    );
    let durationSec = 0;
    if (durationEl) {
      const raw = (durationEl.textContent || "").trim();
      const parts = raw.split(":").map(Number);
      if (parts.length === 3) durationSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) durationSec = parts[0] * 60 + parts[1];
      else if (parts.length === 1) durationSec = parts[0];
    }

    items.push({
      id: videoId,
      title: (titleEl?.textContent || "").trim(),
      channel: (channelEl?.textContent || "").trim(),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      durationSec,
    });
  });
  return items;
}

async function syncWatchLater() {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: WATCH_LATER_URL, active: false });
    await waitForTabLoad(tab.id);
    // Give YouTube's client-side rendering a moment to populate the list.
    await new Promise((r) => setTimeout(r, 2500));

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractWatchLaterFromPage,
    });

    await mergeIntoQueue(result || []);
  } catch (e) {
    console.warn("Snackable sync failed:", e);
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 8000);
  });
}

async function mergeIntoQueue(scrapedItems) {
  const { queue = [] } = await chrome.storage.local.get("queue");
  const existingIds = new Set(queue.map((v) => v.id));
  const now = Date.now();

  const newItems = scrapedItems
    .filter((v) => !existingIds.has(v.id))
    .map((v) => ({
      ...v,
      category: "Uncategorized",
      addedAt: now,
      watched: false,
      embeddable: null, // null = unknown / not checked yet
    }));

  // Also backfill duration on existing items if we scraped a non-zero value and they're missing it
  let updated = false;
  for (const scraped of scrapedItems) {
    const existing = queue.find((q) => q.id === scraped.id);
    if (existing && !existing.durationSec && scraped.durationSec) {
      existing.durationSec = scraped.durationSec;
      updated = true;
    }
  }

  if (newItems.length === 0 && !updated) return;

  const updatedQueue = [...newItems, ...queue];
  await chrome.storage.local.set({ queue: updatedQueue });

  if (newItems.length > 0) {
    chrome.action.setBadgeText({ text: String(newItems.length) });
    chrome.action.setBadgeBackgroundColor({ color: "#D97757" });
  }

  // Check embeddability for new items + any with null embeddable status (async, non-blocking)
  checkEmbeddabilityBatch(updatedQueue.filter((v) => v.embeddable === null || v.embeddable === undefined));
}

// YouTube oEmbed: returns 200 + JSON if embeddable, non-200 (401/403/404) if not.
async function checkEmbeddability(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const resp = await fetch(url, { method: "HEAD" });
    return resp.ok;
  } catch {
    return null; // network error → unknown, don't mark either way
  }
}

async function checkEmbeddabilityBatch(items) {
  if (!items.length) return;
  // Process in small batches to avoid hammering YouTube
  const BATCH_SIZE = 5;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((v) => checkEmbeddability(v.id)));

    const { queue = [] } = await chrome.storage.local.get("queue");
    for (let j = 0; j < batch.length; j++) {
      const inQueue = queue.find((q) => q.id === batch[j].id);
      if (inQueue && results[j] !== null) {
        inQueue.embeddable = results[j];
      }
    }
    await chrome.storage.local.set({ queue });

    // Small delay between batches to be polite
    if (i + BATCH_SIZE < items.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
