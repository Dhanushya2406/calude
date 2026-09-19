// Knowledge graph: Graphology for the data model, Sigma.js for rendering —
// per the explicit instruction not to hand-build a graph renderer.
//
// Reproduces Obsidian's actual relationship model, not a generic tag
// graph: two DISTINCT edge types that are never collapsed into each
// other —
//   "internal-link": a direct note -> note edge from an actual [[..]]
//                     reference (directional — arrows optional)
//   "tag":           a note -> tag edge, for each #tag a note actually
//                     contains. Two notes sharing a tag are NEVER wired
//                     directly to each other; they're both wired to the
//                     SAME tag node, and appear connected only through it.
// Both come straight from real note.links / note.tagIds arrays — nothing
// here is inferred or hardcoded.
//
// Node/edge attributes use "entityType"/"relType" for our own domain
// meaning ("note"/"tag", "tag"/"internal-link") rather than Sigma's
// reserved attribute name "type" — Sigma uses "type" on both nodes and
// edges itself, to pick which rendering PROGRAM draws that element (e.g.
// "arrow" selects EdgeArrowProgram below). Setting our domain value there
// directly collides with that: `type: "note"` made Sigma look for a
// registered node program literally named "note", find none, and throw
// ("could not find a suitable program for node type 'note'"). The edge
// side of this same mistake didn't throw (styleGraph was overwriting a
// real relType with "arrow"/"line" for rendering, silently breaking any
// code that read edge .type expecting "tag"/"internal-link" afterward) —
// just quieter, not safer.
import Graph from "graphology";
import Sigma from "sigma";
import EdgeArrowProgram from "sigma/rendering/webgl/programs/edge.arrow.js";

const NOTE_COLOR = "#d97757"; // --accent
const TAG_COLOR = "#7ca8d9";
const DIM_COLOR = "#3a3126"; // --border

// Builds the FULL adjacency (every note/tag, every real edge) once; both
// global and local/depth-limited views are derived from this same
// structure rather than two separate code paths, so "local graph" is
// never at risk of showing a different relationship model than global.
function buildFullGraph(notes, tags, { showTags = true, showLinks = true } = {}) {
  const graph = new Graph({ multi: false, type: "mixed" });
  const noteList = Object.values(notes);
  const tagList = Object.values(tags);

  for (const note of noteList) {
    graph.addNode(`note:${note.id}`, { entityType: "note", refId: note.id, label: note.title });
  }

  if (showTags) {
    const usedTagIds = new Set();
    for (const note of noteList) for (const t of note.tagIds) usedTagIds.add(t);
    for (const tag of tagList) {
      if (!usedTagIds.has(tag.id)) continue;
      graph.addNode(`tag:${tag.id}`, { entityType: "tag", refId: tag.id, label: `#${tag.name}`, usageCount: tag.usageCount });
    }
    for (const note of noteList) {
      const noteKey = `note:${note.id}`;
      for (const tagId of note.tagIds) {
        const tagKey = `tag:${tagId}`;
        if (!graph.hasNode(tagKey)) continue;
        const edgeKey = `${noteKey}--tag--${tagKey}`;
        if (!graph.hasEdge(edgeKey)) graph.addEdgeWithKey(edgeKey, noteKey, tagKey, { relType: "tag" });
      }
    }
  }

  if (showLinks) {
    for (const note of noteList) {
      const sourceKey = `note:${note.id}`;
      for (const targetId of note.links || []) {
        const targetKey = `note:${targetId}`;
        if (!graph.hasNode(targetKey)) continue; // linked note may have been deleted
        const edgeKey = `${sourceKey}--link--${targetKey}`;
        if (!graph.hasEdge(edgeKey)) graph.addDirectedEdgeWithKey(edgeKey, sourceKey, targetKey, { relType: "internal-link" });
      }
    }
  }

  return graph;
}

function bfsWithinDepth(fullGraph, startKey, depth) {
  const visited = new Set([startKey]);
  let frontier = [startKey];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const key of frontier) {
      fullGraph.forEachNeighbor(key, (neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      });
    }
    frontier = next;
  }
  return visited;
}

// mode: "global" | "local". For "local", focusKey is "note:<id>" or
// "tag:<id>" and depth controls how many hops out to include (depth 1 =
// direct connections only, depth 2 = one more level out, etc. — matches
// "For depth 2: Show relationships one more level out.").
export function buildGraph({ notes, tags, mode = "global", focusKey = null, depth = 1, filters = {} }) {
  const { showTags = true, showLinks = true, search = "" } = filters;
  const full = buildFullGraph(notes, tags, { showTags, showLinks });

  let keep = null; // null = keep everything (global, no search)
  if (mode === "local" && focusKey && full.hasNode(focusKey)) {
    keep = bfsWithinDepth(full, focusKey, depth);
  }

  const searchNorm = search.trim().toLowerCase();
  if (searchNorm) {
    const matches = new Set();
    full.forEachNode((key, attrs) => {
      if (attrs.entityType === "note" && attrs.label.toLowerCase().includes(searchNorm)) matches.add(key);
    });
    // Keep matched notes plus anything already in `keep` (if local mode),
    // intersected — search narrows whatever scope (global or local) is
    // already active rather than replacing it.
    keep = keep ? new Set([...keep].filter((k) => matches.has(k) || full.getNodeAttribute(k, "entityType") === "tag")) : matches;
  }

  const view = new Graph({ multi: false, type: "mixed" });
  full.forEachNode((key, attrs) => {
    if (keep && !keep.has(key)) return;
    view.addNode(key, { ...attrs });
  });
  full.forEachEdge((edgeKey, attrs, source, target) => {
    if (!view.hasNode(source) || !view.hasNode(target)) return;
    if (full.isDirected(edgeKey)) view.addDirectedEdgeWithKey(edgeKey, source, target, { ...attrs });
    else view.addEdgeWithKey(edgeKey, source, target, { ...attrs });
  });

  // Prune tag nodes left with zero edges after search-filtering notes out
  // from under them — an isolated tag chip adds nothing once none of its
  // notes are in view.
  if (searchNorm) {
    view.forEachNode((key, attrs) => {
      if (attrs.entityType === "tag" && view.degree(key) === 0) view.dropNode(key);
    });
  }

  // Circular initial layout — small graphs, no forceAtlas2 needed yet
  // (graphology-layout-forceatlas2 is installed and ready: `import
  // forceAtlas2 from "graphology-layout-forceatlas2"; forceAtlas2.assign(view,
  // { iterations: 100 })` once graphs are large enough that circular
  // placement stops being legible).
  const nodes = view.nodes();
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * 2 * Math.PI;
    view.setNodeAttribute(n, "x", Math.cos(angle));
    view.setNodeAttribute(n, "y", Math.sin(angle));
  });

  return view;
}

function styleGraph(graph, { nodeSizeScale = 1, linkThickness = 1, showArrows = true } = {}) {
  graph.forEachNode((key, attrs) => {
    const baseSize = attrs.entityType === "tag" ? 6 + Math.min(attrs.usageCount || 0, 10) : 8;
    graph.setNodeAttribute(key, "size", baseSize * nodeSizeScale);
    graph.setNodeAttribute(key, "color", attrs.entityType === "tag" ? TAG_COLOR : NOTE_COLOR);
    // Deliberately NOT setting a node "type" here — that's the Sigma-
    // reserved render-program attribute (see the file-header note). Not
    // setting it at all leaves every node on Sigma's default circle
    // program, which is also exactly the "notes are circular nodes"
    // requirement — no extra config needed to get that.
  });
  graph.forEachEdge((key, attrs) => {
    graph.setEdgeAttribute(key, "size", (attrs.relType === "internal-link" ? 1.4 : 1) * linkThickness);
    graph.setEdgeAttribute(key, "color", attrs.relType === "internal-link" ? "#5a4d3d" : "#3a3126");
    // Only directed internal-link edges get an arrowhead; tag edges are
    // conceptually non-directional (a note doesn't "point at" its tag any
    // more than the tag "points at" the note) and stay plain lines even
    // when arrows are toggled on. This "type" IS the Sigma-reserved one
    // (selects which edge program draws it, "arrow" vs the default) —
    // fine to set here since it's genuinely a rendering choice, not a
    // second copy of relType; relType itself is left untouched.
    graph.setEdgeAttribute(key, "type", showArrows && attrs.relType === "internal-link" ? "arrow" : undefined);
  });
}

// Renders `graph` into `container`. Returns the Sigma instance — caller
// must call .kill() before rendering a new graph into the same container
// (mode/filter changes rebuild from scratch rather than mutating in place,
// same reasoning as before: simpler to get right than incremental Sigma
// state for graphs this small).
export function renderGraph(container, graph, { onNodeClick, styleOptions, initialSelectedKey } = {}) {
  styleGraph(graph, styleOptions);

  const sigma = new Sigma(graph, container, {
    renderLabels: true,
    labelColor: { color: "#f0e9df" },
    defaultEdgeColor: "#3a3126",
    edgeProgramClasses: { arrow: EdgeArrowProgram },
  });

  let hoveredNode = null;
  let selectedNode = initialSelectedKey && graph.hasNode(initialSelectedKey) ? initialSelectedKey : null;

  function applyFocusState() {
    const focus = hoveredNode || selectedNode;
    graph.forEachNode((node, attrs) => {
      const isFocus = node === focus;
      const isNeighbor = focus && graph.areNeighbors(node, focus);
      const dim = focus && !isFocus && !isNeighbor;
      graph.setNodeAttribute(node, "color", dim ? DIM_COLOR : attrs.entityType === "tag" ? TAG_COLOR : NOTE_COLOR);
      // "highlighted" is Sigma's actual supported mechanism for an
      // enlarged/halo'd node treatment (also used below for the node
      // being dragged) — there's no separate "borderColor" attribute the
      // default node program reads, so this is the real way to keep the
      // selected node visually distinct, not a made-up one.
      graph.setNodeAttribute(node, "highlighted", node === selectedNode);
    });
    graph.forEachEdge((edge, attrs, source, target) => {
      const dim = focus && source !== focus && target !== focus;
      graph.setEdgeAttribute(edge, "color", dim ? "#241f18" : attrs.relType === "internal-link" ? "#8a7a63" : "#5a4d3d");
    });
    sigma.refresh();
  }

  sigma.on("enterNode", ({ node }) => {
    hoveredNode = node;
    applyFocusState();
  });
  sigma.on("leaveNode", () => {
    hoveredNode = null;
    applyFocusState();
  });
  sigma.on("clickNode", ({ node }) => {
    selectedNode = node;
    applyFocusState();
    const attrs = graph.getNodeAttributes(node);
    onNodeClick?.(attrs.entityType, attrs.refId, node);
  });
  sigma.on("clickStage", () => {
    selectedNode = null;
    applyFocusState();
  });

  // --- Node dragging (Sigma v2's documented drag pattern — no built-in
  // API for this, has to be wired via the mouse captor directly) ---
  let draggedNode = null;
  let isDragging = false;

  sigma.on("downNode", (e) => {
    isDragging = true;
    draggedNode = e.node;
    graph.setNodeAttribute(draggedNode, "highlighted", true);
  });
  sigma.getMouseCaptor().on("mousemovebody", (e) => {
    if (!isDragging || !draggedNode) return;
    const pos = sigma.viewportToGraph(e);
    graph.setNodeAttribute(draggedNode, "x", pos.x);
    graph.setNodeAttribute(draggedNode, "y", pos.y);
    e.preventSigmaDefault();
    e.original.preventDefault();
    e.original.stopPropagation();
  });
  sigma.getMouseCaptor().on("mouseup", () => {
    // Re-derive "highlighted" from actual selection state (applyFocusState)
    // rather than unconditionally clearing it — dragging the currently-
    // selected node shouldn't un-select it once the drag ends.
    isDragging = false;
    draggedNode = null;
    applyFocusState();
  });
  sigma.getMouseCaptor().on("mousedown", () => {
    if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
  });

  applyFocusState();
  return sigma;
}
