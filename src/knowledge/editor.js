// Tiptap editor with a "#" hashtag Suggestion/Mention trigger, per the
// explicit instruction to reuse Tiptap's own Suggestion architecture
// rather than hand-building autocomplete positioning.
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { tagStore } from "./tagStore.js";

function buildDropdown() {
  const el = document.createElement("div");
  el.className = "tag-suggest-menu";
  document.body.appendChild(el);
  return el;
}

function renderList(el, items, selectedIndex, onPick) {
  el.innerHTML = items
    .map((item, i) => {
      const label = item.isNew ? `Create "#${item.name}"` : `#${item.name}`;
      const usage = !item.isNew && item.usageCount ? `<span class="tag-suggest-count">${item.usageCount}</span>` : "";
      return `<div class="tag-suggest-item${i === selectedIndex ? " active" : ""}" data-idx="${i}">${label}${usage}</div>`;
    })
    .join("");
  el.querySelectorAll(".tag-suggest-item").forEach((row) => {
    row.addEventListener("mousedown", (e) => {
      e.preventDefault(); // don't steal editor focus before the pick runs
      onPick(items[Number(row.dataset.idx)]);
    });
  });
}

// The "#" suggestion's render lifecycle — owns a floating dropdown,
// keyboard navigation (Up/Down/Enter/Escape), and turning a picked item
// (existing tag OR "create new") into a real tag before inserting the
// mention node.
function suggestionRender() {
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
    const tag = item.isNew ? await tagStore.getOrCreateTag(item.name) : item;
    if (tag) currentProps.command({ id: tag.id, label: tag.name });
  };

  return {
    onStart(props) {
      currentProps = props;
      items = props.items;
      selectedIndex = 0;
      el = buildDropdown();
      renderList(el, items, selectedIndex, pick);
      position(props);
    },
    onUpdate(props) {
      currentProps = props;
      items = props.items;
      selectedIndex = 0;
      renderList(el, items, selectedIndex, pick);
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
        renderList(el, items, selectedIndex, pick);
        return true;
      }
      if (props.event.key === "ArrowUp") {
        selectedIndex = (selectedIndex - 1 + items.length) % Math.max(items.length, 1);
        renderList(el, items, selectedIndex, pick);
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
}

async function tagItems({ query }) {
  const matches = await tagStore.queryTags(query);
  const norm = tagStore.normalizeTagName(query);
  const hasExact = matches.some((t) => t.normalizedName === norm);
  const list = matches.slice(0, 8);
  if (query && !hasExact) list.push({ isNew: true, name: query });
  return list;
}

// Creates a Tiptap editor mounted on `element`. `onTagClick(tagId)` fires
// when a rendered #tag mention is clicked in the editor content (not while
// editing/typing it — that's the suggestion dropdown's job).
export function createNoteEditor(element, { onTagClick, content = "" } = {}) {
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
        suggestion: {
          char: "#",
          items: tagItems,
          render: suggestionRender,
        },
      }),
    ],
    content,
  });

  editor.view.dom.addEventListener("click", (e) => {
    const el = e.target.closest(".tag-mention");
    if (el && onTagClick) onTagClick(el.dataset.tagId);
  });

  return editor;
}

// Extracts the set of tag IDs actually present in the document right now
// (walks the ProseMirror doc for "tag" mention nodes) — this is what gets
// saved as a note's tagIds, so it's always exactly what's rendered, never
// hand-maintained separately.
export function extractTagIds(editor) {
  const ids = new Set();
  editor.state.doc.descendants((node) => {
    if (node.type.name === "tag" && node.attrs.id) ids.add(node.attrs.id);
  });
  return [...ids];
}
