// Tag + knowledge-note storage. Separate from the existing per-video
// timestamped notes (`notes: { [videoId]: [{ts, text}] }` in dashboard.js) —
// those are short snippets tied to a specific watch session with no title
// and no cross-note structure, and retrofitting tags onto them would mean
// redesigning the existing Watch tab notes UI, which was explicitly ruled
// out. These are freeform, Obsidian-style notes: a title + rich body,
// living in their own storage keys.
//
// Storage shape (chrome.storage.local):
//   knowledgeTags:  { [tagId]: { id, name, normalizedName, usageCount, createdAt } }
//   knowledgeNotes: { [noteId]: { id, title, bodyHTML, bodyText, tagIds: string[], createdAt, updatedAt } }
//
// tagIds live directly on each note (denormalized) rather than in a
// separate reverse-index — "which notes use tag X" is a filter over real
// note.tagIds arrays, not a hardcoded relationship, satisfying "derive
// from actual note/tag/link data, don't hardcode it in the UI."

function normalizeTagName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getTags() {
  const { knowledgeTags = {} } = await chrome.storage.local.get("knowledgeTags");
  return knowledgeTags;
}

async function getNotes() {
  const { knowledgeNotes = {} } = await chrome.storage.local.get("knowledgeNotes");
  return knowledgeNotes;
}

async function queryTags(prefix) {
  const tags = await getTags();
  const norm = normalizeTagName(prefix || "");
  return Object.values(tags)
    .filter((t) => t.normalizedName.startsWith(norm))
    .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
}

// Finds an existing tag by normalized name, or creates one. Does NOT bump
// usageCount here — that only happens when a note is actually saved
// referencing this tag (see saveNote), so usageCount reflects real usage,
// not autocomplete lookups.
async function getOrCreateTag(rawName) {
  const normalizedName = normalizeTagName(rawName);
  if (!normalizedName) return null;
  const tags = await getTags();
  const existing = Object.values(tags).find((t) => t.normalizedName === normalizedName);
  if (existing) return existing;
  const tag = {
    id: uid("tag"),
    name: rawName.trim(),
    normalizedName,
    usageCount: 0,
    createdAt: Date.now(),
  };
  tags[tag.id] = tag;
  await chrome.storage.local.set({ knowledgeTags: tags });
  return tag;
}

async function bumpTagUsage(tagId, delta) {
  const tags = await getTags();
  if (!tags[tagId]) return;
  tags[tagId].usageCount = Math.max(0, tags[tagId].usageCount + delta);
  await chrome.storage.local.set({ knowledgeTags: tags });
}

// Saves (creates or updates) a note and reconciles tag usageCounts against
// whatever tag set it previously had, so editing a note's tags doesn't
// leak stale counts.
async function saveNote({ id, title, bodyHTML, bodyText, tagIds }) {
  const notes = await getNotes();
  const existing = id ? notes[id] : null;
  const previousTagIds = existing?.tagIds || [];
  const note = {
    id: id || uid("note"),
    title: title || "Untitled",
    bodyHTML,
    bodyText,
    tagIds: [...new Set(tagIds)],
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  notes[note.id] = note;
  await chrome.storage.local.set({ knowledgeNotes: notes });

  const added = note.tagIds.filter((t) => !previousTagIds.includes(t));
  const removed = previousTagIds.filter((t) => !note.tagIds.includes(t));
  for (const t of added) await bumpTagUsage(t, 1);
  for (const t of removed) await bumpTagUsage(t, -1);

  return note;
}

async function getNotesForTag(tagId) {
  const notes = await getNotes();
  return Object.values(notes).filter((n) => n.tagIds.includes(tagId));
}

export const tagStore = {
  normalizeTagName,
  getTags,
  getNotes,
  queryTags,
  getOrCreateTag,
  saveNote,
  getNotesForTag,
};
