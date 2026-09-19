// Entry point for the bundle (see build.mjs). Exposes a single init
// function on window so dashboard.js — which has no bundler and can't
// `import` this — can call it directly once the Notes tab is opened.
import { mountKnowledgeView } from "./ui.js";

let mounted = false;

window.SnackableKnowledge = {
  async init(containerEl) {
    if (mounted) return; // lazy-init once; ui.js's own refresh*() calls keep it in sync after that
    mounted = true;
    try {
      await mountKnowledgeView(containerEl);
    } catch (err) {
      mounted = false;
      containerEl.innerHTML = `<div class="kg-error">Knowledge graph failed to load: ${err.message}. Check the console.</div>`;
      console.error("Snackable Knowledge init failed:", err);
    }
  },
};
