(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TYPE_CONFIG = {
    world: { label: "World", color: "#183f47" },
    character: { label: "Character", color: "#2f7d8a" },
    location: { label: "Location", color: "#608a5e" },
    faction: { label: "Faction", color: "#9b6a3f" },
    item: { label: "Item / Clue", color: "#b28a2e" },
    event: { label: "Event", color: "#7665a8" },
    quest: { label: "Quest", color: "#b05266" },
    thread: { label: "Open Thread", color: "#ad7045" },
    context: { label: "Global Context", color: "#4f778c" },
    external: { label: "External Entity", color: "#7a7f80" },
  };

  const state = {
    graph: { nodes: [], edges: [] },
    positions: new Map(),
    visibleTypes: new Set(Object.keys(TYPE_CONFIG)),
    query: "",
    selectedId: null,
    transform: { x: 0, y: 0, scale: 1 },
    drag: null,
  };

  const elements = {};

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  }

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function displayName(entry, fallback) {
    return text(entry?.name) || text(entry?.title) || fallback;
  }

  function detailObject(entry) {
    if (typeof entry === "string") return { description: entry };
    if (entry && typeof entry === "object") return entry;
    return {};
  }

  function buildGraph(worldState) {
    const nodes = [];
    const edges = [];
    const labelIndex = new Map();
    const edgeKeys = new Set();

    function addNode(type, label, data = {}, idHint = "") {
      const id = `${type}:${idHint || nodes.length}`;
      const node = { id, type, label: label || TYPE_CONFIG[type].label, data: detailObject(data) };
      nodes.push(node);
      if (node.label) labelIndex.set(node.label.toLocaleLowerCase(), node.id);
      return node;
    }

    function addEdge(source, target, label, kind = "semantic") {
      if (!source || !target || source === target) return;
      const key = `${source}|${target}|${label}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ id: `edge:${edges.length}`, source, target, label, kind });
    }

    const root = addNode("world", "World Status", {
      summary: text(worldState.summary),
    }, "root");

    const collections = [
      ["characters", "character"],
      ["locations", "location"],
      ["factions", "faction"],
      ["items", "item"],
      ["quests", "quest"],
    ];

    collections.forEach(([field, type]) => {
      (Array.isArray(worldState[field]) ? worldState[field] : []).forEach((entry, index) => {
        const node = addNode(type, displayName(entry, `${TYPE_CONFIG[type].label} ${index + 1}`), entry, index);
        addEdge(root.id, node.id, "contains", "scope");
      });
    });

    (Array.isArray(worldState.timeline) ? worldState.timeline : []).forEach((entry, index) => {
      const node = addNode("event", `Event ${index + 1}`, { description: entry, order: index + 1 }, index);
      addEdge(root.id, node.id, "timeline", "scope");
      if (index > 0) addEdge(`event:${index - 1}`, node.id, "precedes", "sequence");
    });

    (Array.isArray(worldState.open_threads) ? worldState.open_threads : []).forEach((entry, index) => {
      const node = addNode("thread", `Open Thread ${index + 1}`, { description: entry }, index);
      addEdge(root.id, node.id, "unresolved", "scope");
    });

    if (worldState.context_variables && typeof worldState.context_variables === "object") {
      const node = addNode("context", "Global Context", worldState.context_variables, "global");
      addEdge(root.id, node.id, "constrains", "scope");
    }

    function findOrCreate(label) {
      const normalized = text(label).toLocaleLowerCase();
      if (!normalized) return null;
      if (labelIndex.has(normalized)) return labelIndex.get(normalized);
      return addNode("external", text(label), { description: "Referenced by a relation but not defined in an entity collection." }).id;
    }

    (Array.isArray(worldState.relationships) ? worldState.relationships : []).forEach((relation) => {
      addEdge(
        findOrCreate(relation?.source),
        findOrCreate(relation?.target),
        text(relation?.relation) || "related to"
      );
    });

    (Array.isArray(worldState.items) ? worldState.items : []).forEach((item, index) => {
      addEdge(`item:${index}`, findOrCreate(item?.owner), "belongs to");
    });

    return { nodes, edges };
  }

  function layoutGraph(graph) {
    const positions = new Map();
    const width = elements.canvas.clientWidth || 1000;
    const height = elements.canvas.clientHeight || 680;
    const center = { x: width / 2, y: height / 2 };
    const groups = [...new Set(graph.nodes.map((node) => node.type))];

    graph.nodes.forEach((node) => {
      if (node.type === "world") positions.set(node.id, center);
    });

    groups.filter((type) => type !== "world").forEach((type, groupIndex, activeGroups) => {
      const groupNodes = graph.nodes.filter((node) => node.type === type);
      const angle = (Math.PI * 2 * groupIndex) / activeGroups.length - Math.PI / 2;
      const groupCenter = {
        x: center.x + Math.cos(angle) * Math.min(width, height) * 0.35,
        y: center.y + Math.sin(angle) * Math.min(width, height) * 0.35,
      };
      const radius = Math.max(58, Math.min(170, groupNodes.length * 22));
      groupNodes.forEach((node, index) => {
        const nodeAngle = (Math.PI * 2 * index) / groupNodes.length;
        positions.set(node.id, {
          x: groupCenter.x + Math.cos(nodeAngle) * radius,
          y: groupCenter.y + Math.sin(nodeAngle) * radius,
        });
      });
    });
    return positions;
  }

  function matches(node) {
    if (!state.visibleTypes.has(node.type)) return false;
    if (!state.query) return true;
    return `${node.label} ${JSON.stringify(node.data)}`.toLocaleLowerCase().includes(state.query);
  }

  function renderLegend() {
    elements.legend.replaceChildren();
    const usedTypes = [...new Set(state.graph.nodes.map((node) => node.type))];
    usedTypes.forEach((type) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `graph-filter${state.visibleTypes.has(type) ? " active" : ""}`;
      button.innerHTML = `<span style="--node-color:${TYPE_CONFIG[type].color}"></span>${TYPE_CONFIG[type].label}`;
      button.addEventListener("click", () => {
        state.visibleTypes.has(type) ? state.visibleTypes.delete(type) : state.visibleTypes.add(type);
        renderLegend();
        draw();
      });
      elements.legend.appendChild(button);
    });
  }

  function draw() {
    elements.viewport.replaceChildren();
    const defs = svgElement("defs");
    const marker = svgElement("marker", {
      id: "graphArrow",
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "7",
      markerHeight: "7",
      orient: "auto-start-reverse",
    });
    marker.appendChild(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#54757a" }));
    defs.appendChild(marker);
    elements.viewport.appendChild(defs);
    elements.viewport.setAttribute(
      "transform",
      `translate(${state.transform.x} ${state.transform.y}) scale(${state.transform.scale})`
    );
    const visibleNodes = new Set(state.graph.nodes.filter(matches).map((node) => node.id));

    state.graph.edges.forEach((edge) => {
      if (!visibleNodes.has(edge.source) || !visibleNodes.has(edge.target)) return;
      const source = state.positions.get(edge.source);
      const target = state.positions.get(edge.target);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const bend = edge.kind === "scope" ? 0 : Math.min(42, length * 0.12);
      const controlX = (source.x + target.x) / 2 - (dy / length) * bend;
      const controlY = (source.y + target.y) / 2 + (dx / length) * bend;
      const path = svgElement("path", {
        d: `M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`,
        class: `graph-edge ${edge.kind}`,
      });
      const title = svgElement("title");
      title.textContent = edge.label;
      path.appendChild(title);
      elements.viewport.appendChild(path);

      if (edge.kind !== "scope") {
        const edgeLabel = svgElement("text", {
          x: controlX,
          y: controlY - 5,
          class: "graph-edge-label",
          "text-anchor": "middle",
        });
        edgeLabel.textContent = edge.label;
        elements.viewport.appendChild(edgeLabel);
      }
    });

    state.graph.nodes.forEach((node) => {
      if (!visibleNodes.has(node.id)) return;
      const position = state.positions.get(node.id);
      const group = svgElement("g", {
        class: `graph-node${state.selectedId === node.id ? " selected" : ""}`,
        transform: `translate(${position.x} ${position.y})`,
        "data-node-id": node.id,
        tabindex: "0",
      });
      const radius = node.type === "world" ? 24 : 16;
      group.appendChild(svgElement("circle", {
        r: radius + 8,
        class: "node-halo",
      }));
      group.appendChild(svgElement("circle", {
        r: radius,
        fill: TYPE_CONFIG[node.type].color,
      }));
      const label = svgElement("text", { y: radius + 17, "text-anchor": "middle" });
      label.textContent = node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label;
      group.appendChild(label);
      const title = svgElement("title");
      title.textContent = node.label;
      group.appendChild(title);
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectNode(node.id);
      });
      group.addEventListener("pointerdown", startNodeDrag);
      elements.viewport.appendChild(group);
    });

    elements.empty.hidden = state.graph.nodes.length > 0;
    elements.count.textContent = `${visibleNodes.size} nodes · ${
      state.graph.edges.filter((edge) => visibleNodes.has(edge.source) && visibleNodes.has(edge.target)).length
    } connections`;
  }

  function selectNode(id) {
    state.selectedId = id;
    const node = state.graph.nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    elements.detailTitle.textContent = node.label;
    elements.detailType.textContent = TYPE_CONFIG[node.type].label;
    elements.detailBody.replaceChildren();
    Object.entries(node.data).forEach(([key, value]) => {
      if (value === "" || value == null) return;
      const row = document.createElement("div");
      row.className = "graph-detail-row";
      const heading = document.createElement("strong");
      heading.textContent = key;
      const content = document.createElement("p");
      content.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      row.append(heading, content);
      elements.detailBody.appendChild(row);
    });
    draw();
  }

  function graphPoint(event) {
    const point = elements.svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(elements.viewport.getScreenCTM().inverse());
  }

  function startNodeDrag(event) {
    event.preventDefault();
    event.stopPropagation();
    const id = event.currentTarget.dataset.nodeId;
    state.drag = { kind: "node", id };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startPan(event) {
    if (event.target.closest(".graph-node")) return;
    state.drag = {
      kind: "pan",
      startX: event.clientX,
      startY: event.clientY,
      originX: state.transform.x,
      originY: state.transform.y,
    };
    elements.svg.setPointerCapture(event.pointerId);
  }

  function movePointer(event) {
    if (!state.drag) return;
    if (state.drag.kind === "node") {
      state.positions.set(state.drag.id, graphPoint(event));
    } else {
      state.transform.x = state.drag.originX + event.clientX - state.drag.startX;
      state.transform.y = state.drag.originY + event.clientY - state.drag.startY;
    }
    draw();
  }

  function endPointer() {
    state.drag = null;
  }

  function resetView() {
    state.transform = { x: 0, y: 0, scale: 1 };
    state.positions = layoutGraph(state.graph);
    draw();
  }

  function runOfflineGraph(payload) {
    const NS = "http://www.w3.org/2000/svg";
    const graph = payload.graph;
    const types = payload.types;
    const initialPositions = payload.positions;
    let positions = JSON.parse(JSON.stringify(initialPositions));
    let visible = new Set(Object.keys(types));
    let query = "";
    let selected = null;
    let transform = { x: 0, y: 0, scale: 1 };
    let drag = null;
    const svg = document.querySelector("#graph");
    const viewport = document.querySelector("#viewport");
    const legend = document.querySelector("#legend");
    const search = document.querySelector("#search");
    const detail = document.querySelector("#detail");
    const count = document.querySelector("#count");

    function el(name, attrs = {}) {
      const node = document.createElementNS(NS, name);
      Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
      return node;
    }

    function matches(node) {
      return visible.has(node.type)
        && (!query || `${node.label} ${JSON.stringify(node.data)}`.toLocaleLowerCase().includes(query));
    }

    function renderLegend() {
      legend.replaceChildren();
      [...new Set(graph.nodes.map((node) => node.type))].forEach((type) => {
        const button = document.createElement("button");
        button.className = visible.has(type) ? "active" : "";
        const dot = document.createElement("span");
        dot.style.background = types[type].color;
        button.append(dot, document.createTextNode(types[type].label));
        button.addEventListener("click", () => {
          visible.has(type) ? visible.delete(type) : visible.add(type);
          renderLegend();
          draw();
        });
        legend.appendChild(button);
      });
    }

    function selectNode(node) {
      selected = node.id;
      detail.replaceChildren();
      const type = document.createElement("span");
      type.className = "type";
      type.textContent = types[node.type].label;
      const title = document.createElement("h2");
      title.textContent = node.label;
      detail.append(type, title);
      Object.entries(node.data || {}).forEach(([key, value]) => {
        if (value === "" || value == null) return;
        const row = document.createElement("section");
        const heading = document.createElement("strong");
        heading.textContent = key;
        const content = document.createElement("p");
        content.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        row.append(heading, content);
        detail.appendChild(row);
      });
      draw();
    }

    function draw() {
      viewport.replaceChildren();
      viewport.setAttribute("transform", `translate(${transform.x} ${transform.y}) scale(${transform.scale})`);
      const defs = el("defs");
      const marker = el("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto" });
      marker.appendChild(el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#54757a" }));
      defs.appendChild(marker);
      viewport.appendChild(defs);
      const shown = new Set(graph.nodes.filter(matches).map((node) => node.id));

      graph.edges.forEach((edge) => {
        if (!shown.has(edge.source) || !shown.has(edge.target)) return;
        const source = positions[edge.source];
        const target = positions[edge.target];
        if (!source || !target) return;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const bend = edge.kind === "scope" ? 0 : Math.min(42, length * 0.12);
        const cx = (source.x + target.x) / 2 - (dy / length) * bend;
        const cy = (source.y + target.y) / 2 + (dx / length) * bend;
        viewport.appendChild(el("path", { d: `M ${source.x} ${source.y} Q ${cx} ${cy} ${target.x} ${target.y}`, class: `edge ${edge.kind}` }));
        if (edge.kind !== "scope") {
          const label = el("text", { x: cx, y: cy - 5, class: "edge-label", "text-anchor": "middle" });
          label.textContent = edge.label;
          viewport.appendChild(label);
        }
      });

      graph.nodes.forEach((node) => {
        if (!shown.has(node.id)) return;
        const point = positions[node.id];
        const group = el("g", { class: `node${selected === node.id ? " selected" : ""}`, transform: `translate(${point.x} ${point.y})`, "data-id": node.id });
        const radius = node.type === "world" ? 24 : 16;
        group.appendChild(el("circle", { r: radius + 8, class: "halo" }));
        group.appendChild(el("circle", { r: radius, fill: types[node.type].color }));
        const label = el("text", { y: radius + 18, "text-anchor": "middle" });
        label.textContent = node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label;
        group.appendChild(label);
        group.addEventListener("click", (event) => { event.stopPropagation(); selectNode(node); });
        group.addEventListener("pointerdown", (event) => {
          event.stopPropagation();
          drag = { kind: "node", id: node.id };
          group.setPointerCapture(event.pointerId);
        });
        viewport.appendChild(group);
      });
    count.textContent = `${shown.size} nodes · ${graph.edges.filter((edge) => shown.has(edge.source) && shown.has(edge.target)).length} connections`;
    }

    function graphPoint(event) {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      return point.matrixTransform(viewport.getScreenCTM().inverse());
    }

    svg.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".node")) return;
      drag = { kind: "pan", startX: event.clientX, startY: event.clientY, x: transform.x, y: transform.y };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener("pointermove", (event) => {
      if (!drag) return;
      if (drag.kind === "node") positions[drag.id] = graphPoint(event);
      else {
        transform.x = drag.x + event.clientX - drag.startX;
        transform.y = drag.y + event.clientY - drag.startY;
      }
      draw();
    });
    svg.addEventListener("pointerup", () => { drag = null; });
    svg.addEventListener("pointercancel", () => { drag = null; });
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      transform.scale = Math.min(2.5, Math.max(0.35, transform.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
      draw();
    }, { passive: false });
    svg.addEventListener("click", () => { selected = null; draw(); });
    search.addEventListener("input", () => { query = search.value.trim().toLocaleLowerCase(); draw(); });
    document.querySelector("#reset").addEventListener("click", () => {
      positions = JSON.parse(JSON.stringify(initialPositions));
      transform = { x: 0, y: 0, scale: 1 };
      draw();
    });
    renderLegend();
    draw();
  }

  function exportInteractiveHtml(graph = state.graph, positions = state.positions) {
    if (graph.nodes.length === 0) return "";
    const payload = JSON.stringify({
      graph,
      positions: Object.fromEntries(positions),
      types: TYPE_CONFIG,
    }).replace(/</g, "\\u003c");
    const app = runOfflineGraph.toString();
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>World Status Interactive Knowledge Graph</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#e9eef0;color:#15272b;font-family:"Microsoft YaHei","Segoe UI",sans-serif}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;background:#fbfaf5;border-bottom:1px solid #bdc9c9}
h1,h2{margin:0}h1{font-size:22px}header p{margin:5px 0 0;color:#52676b;font-size:13px}.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input,button{padding:9px 11px;border:1px solid #0a6871;border-radius:6px;background:#fff;color:#15272b;font:inherit}button{cursor:pointer}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 320px;height:calc(100vh - 79px)}
.main{position:relative;overflow:hidden;background:radial-gradient(circle at center,rgba(10,104,113,.08),transparent 48%),linear-gradient(rgba(21,39,43,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(21,39,43,.04) 1px,transparent 1px),#f7faf8;background-size:auto,32px 32px,32px 32px,auto}
#graph{width:100%;height:100%;cursor:grab;touch-action:none}.legend{position:absolute;z-index:2;top:12px;left:12px;display:flex;gap:6px;flex-wrap:wrap;max-width:calc(100% - 24px)}.legend button{display:flex;align-items:center;gap:6px;padding:6px 9px;border-color:#bdc9c9;color:#52676b}.legend button.active{border-color:#0a6871;background:#e8f3f2;color:#074b52}.legend span{width:9px;height:9px;border-radius:50%}
.detail{overflow:auto;padding:20px;background:#fbfaf5;border-left:1px solid #bdc9c9}.detail .type{color:#0a6871;font-size:12px;font-weight:800}.detail h2{margin:7px 0 18px}.detail section{padding:12px 0;border-top:1px solid #bdc9c9}.detail p{margin:6px 0 0;color:#52676b;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
.edge{fill:none;stroke:rgba(42,75,81,.55);stroke-width:1.5;marker-end:url(#arrow)}.edge.scope{stroke:rgba(63,88,91,.24);stroke-width:1.15}.edge.sequence{stroke:#7665a8;stroke-dasharray:5 4}.edge-label{fill:#38555a;font-size:10px;font-weight:700;paint-order:stroke;stroke:#f7faf8;stroke-width:5px;pointer-events:none}
.node{cursor:pointer}.node circle:not(.halo){stroke:#fff;stroke-width:3;filter:drop-shadow(0 4px 7px rgba(22,46,50,.27))}.node .halo{fill:rgba(255,255,255,.72);stroke:rgba(10,104,113,.13)}.node.selected circle:not(.halo){stroke:#f0b84a;stroke-width:5}.node text{fill:#15272b;font-size:12px;font-weight:700;paint-order:stroke;stroke:#f7faf8;stroke-width:5px}
@media(max-width:800px){header{align-items:flex-start;flex-direction:column}.workspace{grid-template-columns:1fr;height:auto}.main{height:70vh}.detail{border-top:1px solid #bdc9c9;border-left:0}}
</style></head><body>
<header><div><h1>World Status Interactive Knowledge Graph</h1><p id="count">Loading graph</p></div><div class="tools"><input id="search" type="search" placeholder="Search nodes or properties"><button id="reset">Reset View</button></div></header>
<main class="workspace"><section class="main"><div id="legend" class="legend"></div><svg id="graph"><g id="viewport"></g></svg></section><aside id="detail" class="detail"><span class="type">Node Details</span><h2>Select a node</h2><p>Scroll to zoom, drag empty space to pan, and drag nodes to adjust the layout.</p></aside></main>
<script>const payload=${payload};(${app})(payload);<\/script></body></html>`;
  }

  function exportSvg() {
    if (!elements.svg || state.graph.nodes.length === 0) return "";
    const clone = elements.svg.cloneNode(true);
    clone.setAttribute("xmlns", SVG_NS);
    clone.setAttribute("viewBox", `0 0 ${elements.canvas.clientWidth || 1200} ${elements.canvas.clientHeight || 740}`);
    clone.setAttribute("width", elements.canvas.clientWidth || 1200);
    clone.setAttribute("height", elements.canvas.clientHeight || 740);
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = `
      .graph-edge{fill:none;stroke:rgba(42,75,81,.55);stroke-width:1.5;marker-end:url(#graphArrow)}
      .graph-edge.scope{stroke:rgba(63,88,91,.24);stroke-width:1.15}
      .graph-edge.sequence{stroke:rgba(118,101,168,.68);stroke-dasharray:5 4}
      .graph-edge-label{fill:#38555a;font:700 10px sans-serif;paint-order:stroke;stroke:#f7faf8;stroke-width:5px}
      .graph-node circle:not(.node-halo){stroke:#fff;stroke-width:3}
      .graph-node .node-halo{fill:rgba(255,255,255,.72);stroke:rgba(10,104,113,.13)}
      .graph-node text{fill:#15272b;font:700 12px sans-serif;paint-order:stroke;stroke:#f7faf8;stroke-width:5px}
    `;
    clone.insertBefore(style, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  function init() {
    elements.canvas = document.querySelector("#graphCanvas");
    if (!elements.canvas) return;
    elements.svg = document.querySelector("#graphSvg");
    elements.viewport = document.querySelector("#graphViewport");
    elements.legend = document.querySelector("#graphLegend");
    elements.empty = document.querySelector("#graphEmpty");
    elements.count = document.querySelector("#graphCount");
    elements.detailTitle = document.querySelector("#graphDetailTitle");
    elements.detailType = document.querySelector("#graphDetailType");
    elements.detailBody = document.querySelector("#graphDetailBody");
    elements.search = document.querySelector("#graphSearch");
    elements.reset = document.querySelector("#graphResetButton");

    elements.search.addEventListener("input", () => {
      state.query = elements.search.value.trim().toLocaleLowerCase();
      draw();
    });
    elements.reset.addEventListener("click", resetView);
    elements.svg.addEventListener("pointerdown", startPan);
    elements.svg.addEventListener("pointermove", movePointer);
    elements.svg.addEventListener("pointerup", endPointer);
    elements.svg.addEventListener("pointercancel", endPointer);
    elements.svg.addEventListener("click", () => {
      state.selectedId = null;
      draw();
    });
    elements.svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      state.transform.scale = Math.min(2.5, Math.max(0.35, state.transform.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
      draw();
    }, { passive: false });
  }

  function render(worldState) {
    if (!elements.canvas) init();
    state.graph = worldState && typeof worldState === "object" ? buildGraph(worldState) : { nodes: [], edges: [] };
    state.visibleTypes = new Set(Object.keys(TYPE_CONFIG));
    state.selectedId = null;
    renderLegend();
    resetView();
  }

  window.WorldGraph = { init, render, buildGraph, exportSvg, exportInteractiveHtml };
})();
