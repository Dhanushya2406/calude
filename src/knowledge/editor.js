// Tiptap editor with TWO separate Suggestion/Mention triggers, per the
// explicit instruction to reuse Tiptap's own Suggestion architecture
// rather than hand-building autocomplete positioning:
//   "#"  -> tag/concept mentions (shared-concept relationships)
//   "[[" -> direct note-link mentions (Obsidian-style [[Note Title]])
// These are kept as two distinct Tiptap node types ("tag" and "noteLink")
// with separate storage fields (tagIds vs links) all the way through to
// graph.js's edge types — never merged into one generic "mention", because
// a shared tag and a direct link are different relationship types in the
// Obsidian model this is reproducing.
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { tagStore } from "./tagStore.js";

function buildDropdown(className) {
  const el = document.createElement("div");
  el.className = className;
  document.body.appendChild(el);
  return el;
}

function renderList(el, items, selectedIndex, onPick, itemClass, formatLabel) {
  el.innerHTML = items
    .map((item, i) => {
      const usage = !item.isNew && item.usageCount ? `<span class="tag-suggest-count">${item.usageCount}</span>` : "";
      return `<div class="${itemClass}${i === selectedIndex ? " active" : ""}" data-idx="${i}">${formatLabel(item)}${usage}</div>`;
    })
    .join("");
  el.querySelectorAll(`.${itemClass}`).forEach((row) => {
    row.addEventListener("mousedown", (e) => {
      e.preventDefault(); // don't steal editor focus before the pick runs
      onPick(items[Number(row.dataset.idx)]);
    });
  });
}

// Shared suggestion render lifecycle (dropdown, keyboard nav) — the only
// things that differ between the "#tag" and "[[note" triggers are the
// dropdown's CSS class, how an item's label is formatted, and what
// resolving a picked item into {id, label} actually does (get-or-create a
// tag vs. reference an existing note).
function makeSuggestionRender({ menuClass, itemClass, formatLabel, resolvePick }) {
  return function suggestionRender() {
    let el = null;
    let items = [];
    let selectedIndex = 0;
    let currentProps = null;

    const position = (props) => {
      const rect = props.clientRect?.();
      if (!rect || !el) return;
      el.style.left = `${rect.left + window.scrollX}px`;
      el.style.top = `${rect.bottom + window.scrollY + 4}px`;
    };

    const pick = async (item) => {
      const resolved = await resolvePick(item);
      if (resolved) currentProps.command(resolved);
    };

    return {
      onStart(props) {
        currentProps = props;
        items = props.items;
        selectedIndex = 0;
        el = buildDropdown(menuClass);
        renderList(el, items, selectedIndex, pick, itemClass, formatLabel);
        position(props);
      },
      onUpdate(props) {
        currentProps = props;
        items = props.items;
        selectedIndex = 0;
        renderList(el, items, selectedIndex, pick, itemClass, formatLabel);
        position(props);
      },
      onKeyDown(props) {
        if (!el) return false;
        if (props.event.key === "Escape") {
          el.remove();
          el = null;
          return true;
        }
        if (props.event.key === "ArrowDown") {
          selectedIndex = (selectedIndex + 1) % Math.max(items.length, 1);
          renderList(el, items, selectedIndex, pick, itemClass, formatLabel);
          return true;
        }
        if (props.event.key === "ArrowUp") {
          selectedIndex = (selectedIndex - 1 + items.length) % Math.max(items.length, 1);
          renderList(el, items, selectedIndex, pick, itemClass, formatLabel);
          return true;
        }
        if (props.event.key === "Enter") {
          if (items[selectedIndex]) pick(items[selectedIndex]);
          return true;
        }
        return false;
      },
      onExit() {
        el?.remove();
        el = null;
      },
    };
  };
}

async function tagItems({ query }) {
  const matches = await tagStore.queryTags(query);
  const norm = tagStore.normalizeTagName(query);
  const hasExact = matches.some((t) => t.normalizedName === norm);
  const list = matches.slice(0, 8);
  if (query && !hasExact) list.push({ isNew: true, name: query });
  return list;
}

const tagSuggestionRender = makeSuggestionRender({
  menuClass: "tag-suggest-menu",
  itemClass: "tag-suggest-item",
  formatLabel: (item) => (item.isNew ? `Create "#${item.name}"` : `#${item.name}`),
  resolvePick: async (item) => {
    // #Brain / #brain / #BRAIN all resolve to the same tag entity — see
    // tagStore.getOrCreateTag's normalizedName matching. The tag's
    // canonical display casing is whatever it was FIRST created with and
    // is never overwritten by a later differently-cased reference — that
    // "preserve original display casing" behavior lives in tagStore.js,
    // not here.
    const tag = item.isNew ? await tagStore.getOrCreateTag(item.name) : item;
    return tag ? { id: tag.id, label: tag.name } : null;
  },
});

// Factory (not a plain function) so each editor instance's suggestion
// closes over ITS OWN currentNoteId — Tiptap's `editorProps` is a
// ProseMirror-specific interface (handleClick, decorations, etc.), not a
// generic place to stash arbitrary custom data, so a closure here is the
// correct way to get noteId into this callback rather than smuggling it
// through there.
function makeNoteLinkItems(currentNoteId) {
  return async function noteLinkItems({ query }) {
    const matches = await tagStore.queryNoteTitles(query, currentNoteId);
    if (query && !matches.some((n) => n.title.toLowerCase() === query.toLowerCase())) {
      matches.push({ isNew: true, title: query });
    }
    return matches;
  };
}

const noteLinkSuggestionRender = makeSuggestionRender({
  menuClass: "note-link-suggest-menu",
  itemClass: "tag-suggest-item",
  formatLabel: (item) => (item.isNew ? `Create note "${item.title}"` : item.title),
  resolvePick: async (item) => {
    if (item.isNew) {
      // Creates an empty placeholder note so the link resolves to a real
      // note ID immediately (consistent with how a new tag is created on
      // the spot) — its body can be filled in later by opening it.
      const note = await tagStore.saveNote({ title: item.title, bodyHTML: "<p></p>", bodyText: "", tagIds: [], links: [] });
      return { id: note.id, label: note.title };
    }
    return { id: item.id, label: item.title };
  },
});

// Creates a Tiptap editor mounted on `element`.
// `onTagClick(tagId)` fires when a rendered #tag mention is clicked.
// `onNoteLinkClick(noteId)` fires when a rendered [[note]] mention is clicked.
// `noteId` (the note currently being edited, or null for a new note) is
// passed through so the [[ suggestion can exclude linking a note to itself.
export function createNoteEditor(element, { onTagClick, onNoteLinkClick, content = "", noteId = null } = {}) {
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      Mention.extend({
        name: "tag",
        renderHTML({ node }) {
          return ["span", { class: "tag-mention", "data-tag-id": node.attrs.id }, `#${node.attrs.label}`];
        },
        renderText({ node }) {
          return `#${node.attrs.label}`;
        },
      }).configure({
        suggestion: { char: "#", items: tagItems, render: tagSuggestionRender },
      }),
      Mention.extend({
        name: "noteLink",
        renderHTML({ node }) {
          return ["span", { class: "note-link-mention", "data-note-id": node.attrs.id }, `[[${node.attrs.label}]]`];
        },
        renderText({ node }) {
          return `[[${node.attrs.label}]]`;
        },
      }).configure({
        suggestion: { char: "[[", allowSpaces: true, items: makeNoteLinkItems(noteId), render: noteLinkSuggestionRender },
      }),
    ],
    content,
  });

  editor.view.dom.addEventListener("click", (e) => {
    const tagEl = e.target.closest(".tag-mention");
    if (tagEl && onTagClick) return onTagClick(tagEl.dataset.tagId);
    const linkEl = e.target.closest(".note-link-mention");
    if (linkEl && onNoteLinkClick) return onNoteLinkClick(linkEl.dataset.noteId);
  });

  return editor;
}

// Extracts the tag IDs and linked note IDs actually present in the
// document right now (walks the ProseMirror doc) — this is what gets
// saved as a note's tagIds/links, so it's always exactly what's rendered,
// never hand-maintained separately. Kept as two separate arrays end to
// end, matching the two distinct relationship types.
export function extractRelationships(editor) {
  const tagIds = new Set();
  const links = new Set();
  editor.state.doc.descendants((node) => {
    if (node.type.name === "tag" && node.attrs.id) tagIds.add(node.attrs.id);
    if (node.type.name === "noteLink" && node.attrs.id) links.add(node.attrs.id);
  });
  return { tagIds: [...tagIds], links: [...links] };
}
