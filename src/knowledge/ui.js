// Wires tagStore + editor + graph into the DOM. Deliberately built as its
// own module (not spliced into dashboard.js) — "create reusable components
// rather than putting everything inside the existing note page."
import { tagStore } from "./tagStore.js";
import { createNoteEditor, extractTagIds } from "./editor.js";
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
          <button data-mode="global" class="kg-mode-btn active">Global</button>
          <span id="kgGraphModeLabel" class="kg-graph-mode-label"></span>
        </div>
        <div id="kgGraphContainer" class="kg-graph-container"></div>
      </div>
    </div>
  `;

  let editor = null;
  let editingNoteId = null;
  let graphMode = "global";
  let graphFocusId = null;
  let sigmaInstance = null;

  function startNewNote() {
    editingNoteId = null;
    document.getElementById("kgNoteTitle").value = "";
    editor?.destroy();
    editor = createNoteEditor(document.getElementById("kgEditor"), {
      onTagClick: (tagId) => showRelatedNotes(tagId),
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
    editingNoteId = note.id;
    document.getElementById("kgNoteTitle").value = note.title;
    editor?.destroy();
    editor = createNoteEditor(document.getElementById("kgEditor"), {
      content: note.bodyHTML,
      onTagClick: (tagId) => showRelatedNotes(tagId),
    });
    graphMode = "note";
    graphFocusId = note.id;
    setActiveModeButton();
    await refreshGraph();
  }

  async function saveCurrentNote() {
    if (!editor) return;
    const title = document.getElementById("kgNoteTitle").value.trim() || "Untitled";
    const tagIds = extractTagIds(editor);
    const note = await tagStore.saveNote({
      id: editingNoteId,
      title,
      bodyHTML: editor.getHTML(),
      bodyText: editor.getText(),
      tagIds,
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
      row.addEventListener("click", () => {
        panel.style.display = "none";
        openNote(row.dataset.id);
      });
    });
    panel.style.display = "block";

    // Selecting a tag also focuses the graph on it — "selecting a tag
    // should not destroy the current note" is satisfied because this only
    // swaps the graph view and opens the related-notes panel; the editor
    // and whatever note is currently open are untouched.
    graphMode = "tag";
    graphFocusId = tagId;
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
      label.textContent = graphMode === "tag" ? "tag-focused" : "note-focused";
    }
  }

  async function refreshGraph() {
    const [notes, tags] = await Promise.all([tagStore.getNotes(), tagStore.getTags()]);
    const graph = buildGraph({ notes, tags, mode: graphMode, focusId: graphFocusId });
    sigmaInstance?.kill();
    const container = document.getElementById("kgGraphContainer");
    if (graph.order === 0) {
      container.innerHTML = `<div class="muted kg-graph-empty">Nothing to show yet.</div>`;
      sigmaInstance = null;
      return;
    }
    container.innerHTML = "";
    sigmaInstance = renderGraph(container, graph, {
      onNodeClick: (type, refId) => {
        if (type === "note") {
          document.getElementById("kgRelatedPanel").style.display = "none";
          openNote(refId);
        } else {
          showRelatedNotes(refId);
        }
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
    graphFocusId = null;
    setActiveModeButton();
    await refreshGraph();
  });

  startNewNote();
  await refreshNotesList();
  await refreshGraph();
}
