// Knowledge graph: Graphology for the data model, Sigma.js for rendering —
// per the explicit instruction not to hand-build a graph renderer.
//
// Nodes are bipartite: "note" and "tag" (per the data model in the spec —
// nodes optionally include tags "when useful", which for a tag-driven
// graph is always). Edges are type:"tag", connecting a note to each tag it
// actually contains — read directly off note.tagIds, nothing hardcoded.
// type:"link" edges (Obsidian-style [[note links]]) aren't populated yet
// (no [[..]] parsing built in this phase) but the shape already supports
// them without changes — see buildGraph's edge-adding loop.
import Graph from "graphology";
import Sigma from "sigma";

const NOTE_COLOR = "#d97757"; // --accent
const TAG_COLOR = "#7ca8d9"; // one of the existing CATEGORY_COLORS
const DIM_COLOR = "#3a3126"; // --border, used to fade unrelated nodes/edges

// mode: "global" | "tag" | "note". focusId: tagId or noteId for the
// non-global modes. Builds a fresh graph each time rather than
// hiding/showing nodes on one long-lived instance — simpler to reason
// about correctly than incremental Sigma state, and these graphs are small.
export function buildGraph({ notes, tags, mode = "global", focusId = null }) {
  const graph = new Graph();
  const noteList = Object.values(notes);
  const tagList = Object.values(tags);

  const relevantNoteIds =
    mode === "tag" && focusId
      ? new Set(noteList.filter((n) => n.tagIds.includes(focusId)).map((n) => n.id))
      : mode === "note" && focusId
        ? new Set([focusId])
        : null; // null = no filter (global)

  for (const note of noteList) {
    if (relevantNoteIds && !relevantNoteIds.has(note.id)) continue;
    graph.addNode(`note:${note.id}`, {
      type: "note",
      refId: note.id,
      label: note.title,
      size: 8,
      color: NOTE_COLOR,
      x: Math.random(),
      y: Math.random(),
    });
  }

  const usedTagIds = new Set();
  for (const note of noteList) {
    if (relevantNoteIds && !relevantNoteIds.has(note.id)) continue;
    for (const tagId of note.tagIds) usedTagIds.add(tagId);
  }
  if (mode === "tag" && focusId) usedTagIds.add(focusId);

  for (const tag of tagList) {
    if (!usedTagIds.has(tag.id)) continue;
    if (mode === "note" && focusId) {
      // note-focused: only show tags actually on that note
      const note = notes[focusId];
      if (!note?.tagIds.includes(tag.id)) continue;
    }
    graph.addNode(`tag:${tag.id}`, {
      type: "tag",
      refId: tag.id,
      label: `#${tag.name}`,
      size: 6 + Math.min(tag.usageCount, 10),
      color: TAG_COLOR,
      x: Math.random(),
      y: Math.random(),
    });
  }

  for (const note of noteList) {
    const noteNodeId = `note:${note.id}`;
    if (!graph.hasNode(noteNodeId)) continue;
    for (const tagId of note.tagIds) {
      const tagNodeId = `tag:${tagId}`;
      if (!graph.hasNode(tagNodeId)) continue;
      const edgeId = `${noteNodeId}->${tagNodeId}`;
      if (!graph.hasEdge(edgeId)) {
        graph.addEdgeWithKey(edgeId, noteNodeId, tagNodeId, { type: "tag", color: "#3a3126", size: 1 });
      }
    }
    // type:"link" edges (Obsidian-style [[note]] references) would be
    // added here the same way once note bodies are parsed for them —
    // graph.addEdgeWithKey(id, `note:${a}`, `note:${b}`, { type: "link" }).
  }

  // Simple circular layout — these graphs are small (a handful of notes/
  // tags in this phase); graphology-layout-forceatlas2 is installed and
  // ready to swap in (`import forceAtlas2 from "graphology-layout-forceatlas2"`,
  // `forceAtlas2.assign(graph, { iterations: 100 })`) once graphs are large
  // enough that circular placement stops being legible.
  const nodes = graph.nodes();
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * 2 * Math.PI;
    graph.setNodeAttribute(n, "x", Math.cos(angle));
    graph.setNodeAttribute(n, "y", Math.sin(angle));
  });

  return graph;
}

// Renders `graph` into `container` with hover-highlight/dim and click
// handling. Returns the Sigma instance — caller must call .kill() on it
// before rendering a new graph into the same container (mode switches).
export function renderGraph(container, graph, { onNodeClick } = {}) {
  const sigma = new Sigma(graph, container, {
    renderLabels: true,
    labelColor: { color: "#f0e9df" },
    defaultEdgeColor: "#3a3126",
  });

  let hoveredNode = null;

  function applyHoverState() {
    graph.forEachNode((node) => {
      const isNeighbor = hoveredNode && (node === hoveredNode || graph.areNeighbors(node, hoveredNode));
      const dim = hoveredNode && !isNeighbor;
      graph.setNodeAttribute(node, "color", dim ? DIM_COLOR : graph.getNodeAttribute(node, "type") === "tag" ? TAG_COLOR : NOTE_COLOR);
    });
    graph.forEachEdge((edge, attrs, source, target) => {
      const dim = hoveredNode && source !== hoveredNode && target !== hoveredNode;
      graph.setEdgeAttribute(edge, "color", dim ? "#241f18" : "#5a4d3d");
    });
    sigma.refresh();
  }

  sigma.on("enterNode", ({ node }) => {
    hoveredNode = node;
    applyHoverState();
  });
  sigma.on("leaveNode", () => {
    hoveredNode = null;
    applyHoverState();
  });
  sigma.on("clickNode", ({ node }) => {
    const attrs = graph.getNodeAttributes(node);
    onNodeClick?.(attrs.type, attrs.refId);
  });

  return sigma;
}
