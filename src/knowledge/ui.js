// Wires tagStore + editor + graph into the DOM. Deliberately built as its
// own module (not spliced into dashboard.js) — "create reusable components
// rather than putting everything inside the existing note page."
import { tagStore } from "./tagStore.js";
import { createNoteEditor, extractRelationships } from "./editor.js";
import { buildGraph, renderGraph } from "./graph.js";

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

export async function mountKnowledgeView(root) {
  root.innerHTML = `
    <div class="kg-layout">
      <div class="kg-composer">
        <input id="kgNoteTitle" class="kg-title-input" placeholder="Note title" />
        <div id="kgEditor" class="kg-editor"></div>
        <div class="kg-composer-hint">Type <code>#tag</code> for a shared concept, <code>[[Note Title]]</code> to link directly to another note.</div>
        <div class="kg-composer-actions">
          <button id="kgSaveNote" class="kg-save-btn">Save note</button>
          <button id="kgNewNote" class="kg-new-btn">+ New</button>
        </div>
      </div>
      <div class="kg-notes-panel">
        <h4>Notes</h4>
        <div id="kgNotesList" class="kg-notes-list"></div>
      </div>
      <div class="kg-related-panel" id="kgRelatedPanel" style="display:none;">
        <div class="kg-related-header">
          <h4 id="kgRelatedTitle"></h4>
          <button id="kgRelatedClose" class="kg-related-close">&times;</button>
        </div>
        <div id="kgRelatedList"></div>
      </div>
      <div class="kg-graph-panel">
        <div class="kg-graph-controls">
          <div class="kg-graph-controls-row">
            <button data-mode="global" class="kg-mode-btn active">Global</button>
            <button data-mode="local" class="kg-mode-btn">Local</button>
            <label class="kg-depth-control">
              Depth
              <input type="number" id="kgDepth" min="1" max="4" value="1" />
            </label>
            <input type="text" id="kgSearch" class="kg-search-input" placeholder="Search notes…" />
          </div>
          <div class="kg-graph-controls-row">
            <label class="kg-toggle"><input type="checkbox" id="kgShowTags" checked /> Tags</label>
            <label class="kg-toggle"><input type="checkbox" id="kgShowLinks" checked /> Links</label>
            <label class="kg-toggle"><input type="checkbox" id="kgShowArrows" checked /> Arrows</label>
            <label class="kg-slider-control">
              Node size
              <input type="range" id="kgNodeSize" min="0.5" max="2" step="0.1" value="1" />
            </label>
            <label class="kg-slider-control">
              Link width
              <input type="range" id="kgLinkWidth" min="0.5" max="3" step="0.1" value="1" />
            </label>
          </div>
          <span id="kgGraphModeLabel" class="kg-graph-mode-label"></span>
        </div>
        <div id="kgGraphContainer" class="kg-graph-container"></div>
      </div>
    </div>
  `;

  let editor = null;
  let editingNoteId = null;
  let graphMode = "global"; // "global" | "local"
  let graphFocusKey = null; // "note:<id>" | "tag:<id>"
  let sigmaInstance = null;

  function currentFilters() {
    return {
      search: document.getElementById("kgSearch").value,
      showTags: document.getElementById("kgShowTags").checked,
      showLinks: document.getElementById("kgShowLinks").checked,
    };
  }

  function currentStyleOptions() {
    return {
      nodeSizeScale: Number(document.getElementById("kgNodeSize").value),
      linkThickness: Number(document.getElementById("kgLinkWidth").value),
      showArrows: document.getElementById("kgShowArrows").checked,
    };
  }

  function startNewNote() {
    editingNoteId = null;
    document.getElementById("kgNoteTitle").value = "";
    editor?.destroy();
    editor = createNoteEditor(document.getElementById("kgEditor"), {
      noteId: null,
      onTagClick: (tagId) => showRelatedNotes(tagId),
      onNoteLinkClick: (noteId) => openNote(noteId),
    });
  }

  async function refreshNotesList() {
    const notes = await tagStore.getNotes();
    const list = document.getElementById("kgNotesList");
    const entries = Object.values(notes).sort((a, b) => b.updatedAt - a.updatedAt);
    list.innerHTML =
      entries
        .map(
          (n) => `
        <div class="kg-note-row" data-id="${n.id}">
          <div class="kg-note-row-title">${escapeHtml(n.title)}</div>
          <div class="kg-note-row-excerpt">${escapeHtml((n.bodyText || "").slice(0, 80))}</div>
        </div>`
        )
        .join("") || `<div class="muted">No notes yet — try "#brain" in the editor above.</div>`;

    list.querySelectorAll(".kg-note-row").forEach((row) => {
      row.addEventListener("click", () => openNote(row.dataset.id));
    });
  }

  async function openNote(noteId) {
    const notes = await tagStore.getNotes();
    const note = notes[noteId];
    if (!note) return;
    document.getElementById("kgRelatedPanel").style.display = "none";
    editingNoteId = note.id;
    document.getElementById("kgNoteTitle").value = note.title;
    editor?.destroy();
    editor = createNoteEditor(document.getElementById("kgEditor"), {
      content: note.bodyHTML,
      noteId: note.id,
      onTagClick: (tagId) => showRelatedNotes(tagId),
      onNoteLinkClick: (linkedId) => openNote(linkedId),
    });
    graphMode = "local";
    graphFocusKey = `note:${note.id}`;
    setActiveModeButton();
    await refreshGraph();
  }

  async function saveCurrentNote() {
    if (!editor) return;
    const title = document.getElementById("kgNoteTitle").value.trim() || "Untitled";
    const { tagIds, links } = extractRelationships(editor);
    const note = await tagStore.saveNote({
      id: editingNoteId,
      title,
      bodyHTML: editor.getHTML(),
      bodyText: editor.getText(),
      tagIds,
      links,
    });
    editingNoteId = note.id;
    await refreshNotesList();
    await refreshGraph();
  }

  async function showRelatedNotes(tagId) {
    const tags = await tagStore.getTags();
    const tag = tags[tagId];
    if (!tag) return;
    const notes = await tagStore.getNotesForTag(tagId);
    const panel = document.getElementById("kgRelatedPanel");
    document.getElementById("kgRelatedTitle").textContent = `#${tag.name} (${notes.length} note${notes.length !== 1 ? "s" : ""}, used ${tag.usageCount}x)`;
    document.getElementById("kgRelatedList").innerHTML = notes
      .map((n) => {
        const idx = n.bodyText.toLowerCase().indexOf(`#${tag.name}`.toLowerCase());
        const excerpt = idx >= 0 ? n.bodyText.slice(Math.max(0, idx - 30), idx + 60) : n.bodyText.slice(0, 90);
        return `
        <div class="kg-related-row" data-id="${n.id}">
          <div class="kg-note-row-title">${escapeHtml(n.title)}</div>
          <div class="kg-note-row-excerpt">…${escapeHtml(excerpt)}…</div>
        </div>`;
      })
      .join("");
    panel.querySelectorAll(".kg-related-row").forEach((row) => {
      row.addEventListener("click", () => openNote(row.dataset.id));
    });
    panel.style.display = "block";

    // Selecting a tag also focuses the graph on it — "selecting a tag
    // should not destroy the current note" is satisfied because this only
    // swaps the graph view and opens the related-notes panel; the editor
    // and whatever note is currently open are untouched.
    graphMode = "local";
    graphFocusKey = `tag:${tagId}`;
    setActiveModeButton();
    await refreshGraph();
  }

  function setActiveModeButton() {
    document.querySelectorAll(".kg-mode-btn").forEach((b) => b.classList.remove("active"));
    const label = document.getElementById("kgGraphModeLabel");
    if (graphMode === "global") {
      document.querySelector('.kg-mode-btn[data-mode="global"]').classList.add("active");
      label.textContent = "";
    } else {
      document.querySelector('.kg-mode-btn[data-mode="local"]').classList.add("active");
      label.textContent = graphFocusKey?.startsWith("tag:") ? "local: tag-focused" : "local: note-focused";
    }
  }

  async function refreshGraph() {
    const [notes, tags] = await Promise.all([tagStore.getNotes(), tagStore.getTags()]);
    const depth = Math.max(1, Number(document.getElementById("kgDepth").value) || 1);
    const graph = buildGraph({
      notes,
      tags,
      mode: graphMode,
      focusKey: graphFocusKey,
      depth,
      filters: currentFilters(),
    });
    sigmaInstance?.kill();
    const container = document.getElementById("kgGraphContainer");
    if (graph.order === 0) {
      container.innerHTML = `<div class="muted kg-graph-empty">Nothing to show yet.</div>`;
      sigmaInstance = null;
      return;
    }
    container.innerHTML = "";
    sigmaInstance = renderGraph(container, graph, {
      styleOptions: currentStyleOptions(),
      initialSelectedKey: graphFocusKey,
      onNodeClick: (type, refId) => {
        if (type === "note") openNote(refId);
        else showRelatedNotes(refId);
      },
    });
  }

  document.getElementById("kgSaveNote").addEventListener("click", saveCurrentNote);
  document.getElementById("kgNewNote").addEventListener("click", startNewNote);
  document.getElementById("kgRelatedClose").addEventListener("click", () => {
    document.getElementById("kgRelatedPanel").style.display = "none";
  });
  document.querySelector('.kg-mode-btn[data-mode="global"]').addEventListener("click", async () => {
    graphMode = "global";
    graphFocusKey = null;
    setActiveModeButton();
    await refreshGraph();
  });
  document.querySelector('.kg-mode-btn[data-mode="local"]').addEventListener("click", async () => {
    // "Local" with nothing focused yet falls back to whatever note is
    // currently open; if none, there's nothing to be local to.
    if (!graphFocusKey && editingNoteId) graphFocusKey = `note:${editingNoteId}`;
    if (!graphFocusKey) return;
    graphMode = "local";
    setActiveModeButton();
    await refreshGraph();
  });

  // Filters/style controls all just trigger a rebuild — graph state itself
  // (mode/focus) is untouched by any of these.
  ["kgDepth", "kgSearch", "kgShowTags", "kgShowLinks", "kgShowArrows", "kgNodeSize", "kgLinkWidth"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener(el.type === "text" || el.type === "number" ? "input" : "change", refreshGraph);
  });

  startNewNote();
  await refreshNotesList();
  await refreshGraph();
}
