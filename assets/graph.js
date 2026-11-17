/* Citation graph: papers from data/papers.csv as nodes, edges from data/citations.csv
   (rows with source "removed" are ignored). Drawn with d3 (force layout, zoom). */
(function () {
  "use strict";
  const { CLASS_STYLE, esc, extLink, fold, getText, parseCSV, bibBlock } = window.PBR;
  const $ = (id) => document.getElementById(id);
  const CLASSES = Object.keys(CLASS_STYLE);

  const svg = d3.select("#graph");
  const box = $("graph-box"), tip = $("tip"), details = $("details"), msg = $("graph-msg");
  const css = getComputedStyle(document.documentElement);
  const colour = (cls) => css.getPropertyValue("--c-" + (CLASS_STYLE[cls] || "gb")).trim() || "#888";

  let papers = [], links = [], selected = null, shown = new Set(CLASSES);
  let W = 800, H = 560, drawn = false;
  const sim = d3.forceSimulation().stop();
  const zoom = d3.zoom().scaleExtent([0.25, 8]).on("zoom", (e) => world.attr("transform", e.transform));
  const world = svg.append("g");
  const axis = world.append("g").attr("class", "year-axis");
  const edgeG = world.append("g").attr("class", "edges");
  const nodeG = world.append("g").attr("class", "nodes");
  let edgeSel, nodeSel;

  // ---------- data ----------
  Promise.all([PBR.loadPapers(), getText("data/citations.csv").catch(() => "")])
    .then(([ps, citeText]) => {
      papers = ps;
      const byTitle = new Map(papers.map((p) => [fold(p.title), p]));
      const seen = new Set();
      let unknown = 0;
      for (const r of parseCSV(citeText)) {
        if ((r.source || "").trim() === "removed") continue;
        const a = byTitle.get(fold(r.citing)), b = byTitle.get(fold(r.cited));
        if (!a || !b) { unknown++; continue; }
        if (a === b || seen.has(a.title + "\n" + b.title)) continue;
        seen.add(a.title + "\n" + b.title);
        links.push({ source: a, target: b });
      }
      papers.forEach((p) => { p._cites = []; p._citedBy = []; });
      links.forEach((l) => { l.source._cites.push(l.target); l.target._citedBy.push(l.source); });
      if (unknown) console.warn(`${unknown} row(s) in data/citations.csv name a paper that is not in papers.csv`);
      init();
    })
    .catch((err) => { msg.textContent = `Could not load the paper list (${err.message}). Serve the folder over HTTP, e.g. python3 -m http.server.`; });

  // ---------- controls ----------
  function init() {
    msg.hidden = true;
    $("legend").innerHTML = CLASSES.map((c) =>
      `<button type="button" class="chip ${CLASS_STYLE[c]} legend-chip" aria-pressed="true" data-cls="${esc(c)}">` +
      `<span class="dot" style="background:${colour(c)}"></span>${esc(c)} <span class="n">${papers.filter((p) => p._classes.includes(c)).length}</span></button>`).join("");
    $("legend").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cls]");
      if (!b) return;
      const c = b.dataset.cls;
      if (shown.has(c)) shown.delete(c); else shown.add(c);
      if (!shown.size) CLASSES.forEach((x) => shown.add(x)); // never show an empty graph
      $("legend").querySelectorAll("[data-cls]").forEach((x) => x.setAttribute("aria-pressed", shown.has(x.dataset.cls)));
      relayout();
    });
    const sorted = [...papers].sort((a, b) => a.title.localeCompare(b.title));
    $("jump").insertAdjacentHTML("beforeend", sorted.map((p) => `<option value="${papers.indexOf(p)}">${esc(p.title)} (${esc(p.year)})</option>`).join(""));
    $("jump").addEventListener("change", (e) => { if (e.target.value !== "") select(papers[+e.target.value], true); });
    $("layout").addEventListener("change", relayout);
    $("hide-isolated").addEventListener("change", relayout);
    $("zoom-in").addEventListener("click", () => svg.transition().duration(250).call(zoom.scaleBy, 1.4));
    $("zoom-out").addEventListener("click", () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.4));
    $("zoom-reset").addEventListener("click", () => svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity));
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("click", (e) => { if (e.target === svg.node()) select(null); });
    details.addEventListener("click", (e) => {
      const b = e.target.closest("[data-goto]");
      if (b) select(papers[+b.dataset.goto], true);
    });
    window.addEventListener("hashchange", fromHash);

    const linked = new Set(links.flatMap((l) => [l.source, l.target]));
    $("graph-foot").innerHTML = `${papers.length} papers, ${links.length} citations between them` +
      ` (${papers.length - linked.size} papers have none yet). Citations were found automatically with OpenAlex, Crossref and arXiv` +
      ` and may be incomplete; corrections to <code>data/citations.csv</code> are welcome on <a href="https://github.com/Post-Bayesian-Repository/post_bayes_repo">GitHub</a>.`;

    draw();
    let lastW = 0;
    new ResizeObserver(() => { if (Math.abs(box.clientWidth - lastW) > 40) { lastW = box.clientWidth; relayout(); } }).observe(box);
    fromHash();
  }

  const visible = (p) => p._classes.some((c) => shown.has(c)) &&
    !($("hide-isolated").checked && !p._cites.length && !p._citedBy.length);

  // ---------- drawing ----------
  function draw() {
    svg.append("defs").html(`
      <marker id="arrow" viewBox="0 -4 8 8" refX="8" refY="0" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M0,-4L8,0L0,4" class="arrow-head"></path></marker>
      <marker id="arrow-hi" viewBox="0 -4 8 8" refX="8" refY="0" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M0,-4L8,0L0,4" class="arrow-head hi"></path></marker>`);
    edgeSel = edgeG.selectAll("line").data(links).join("line").attr("class", "edge").attr("marker-end", "url(#arrow)");
    nodeSel = nodeG.selectAll("g").data(papers).join("g")
      .attr("class", "node").attr("tabindex", 0).attr("role", "button")
      .attr("aria-label", (p) => `${p.title}, ${p.year}`)
      .on("mouseenter", (e, p) => { showTip(e, p); highlight(p); })
      .on("mousemove", (e, p) => showTip(e, p))
      .on("mouseleave", () => { tip.hidden = true; highlight(selected); })
      .on("click", (e, p) => { e.stopPropagation(); select(p); })
      .on("keydown", (e, p) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(p); } })
      .on("focus", (e, p) => highlight(p))
      .on("blur", () => highlight(selected));
    nodeSel.append("circle")
      .attr("fill", (p) => colour(p._classes[0]))
      .attr("stroke", (p) => (p._classes[1] ? colour(p._classes[1]) : "#fff"))
      .attr("stroke-width", (p) => (p._classes[1] ? 3 : 1.5));
    relayout();
  }

  function relayout() {
    W = box.clientWidth || 800;
    H = box.clientHeight || 560;
    svg.attr("viewBox", [0, 0, W, H]);
    const nodes = papers.filter(visible);
    const on = new Set(nodes);
    const ls = links.filter((l) => on.has(l.source) && on.has(l.target));
    nodeSel.attr("display", (p) => (on.has(p) ? null : "none"));
    edgeSel.attr("display", (l) => (on.has(l.source) && on.has(l.target) ? null : "none"));

    const byYear = $("layout").value === "time";
    const years = d3.extent(papers, (p) => p._year);
    const pad = W < 500 ? 24 : 48;
    const x = d3.scaleLinear().domain(years).range([pad, W - pad]);
    const small = W < 500;
    // Circle size grows with the number of citations from within the repository; smaller on phones.
    papers.forEach((p) => { p._r = (small ? 0.7 : 1) * (5 + 2.4 * Math.sqrt(p._citedBy.length)); });
    nodeSel.select("circle").attr("r", (p) => p._r);
    sim.nodes(nodes)
      .force("link", d3.forceLink(ls).distance(byYear ? 40 : 55).strength(byYear ? 0.05 : 0.4))
      .force("charge", d3.forceManyBody().strength(small ? -40 : -90).distanceMax(300))
      .force("collide", d3.forceCollide((p) => p._r + (small ? 1.5 : 3)))
      .force("x", byYear ? d3.forceX((p) => x(p._year)).strength(1) : d3.forceX(W / 2).strength(0.06))
      .force("y", d3.forceY(H / 2 + (byYear ? 10 : 0)).strength(byYear ? 0.08 : 0.08));
    // Settle the layout up front instead of animating it: no jitter, no CPU use afterwards.
    nodes.forEach((p, i) => { if (p.x == null) { p.x = byYear ? x(p._year) : W / 2 + 50 * Math.cos(i); p.y = H / 2 + 50 * Math.sin(i); } });
    sim.alpha(1);
    for (let i = 0; i < 320; i++) sim.tick();
    if (nodes.length) { // centre the settled layout in the box (horizontally only for the year layout)
      const [x0, x1] = d3.extent(nodes, (p) => p.x), [y0, y1] = d3.extent(nodes, (p) => p.y);
      const dx = byYear ? 0 : W / 2 - (x0 + x1) / 2, dy = H / 2 + 8 - (y0 + y1) / 2;
      nodes.forEach((p) => { p.x += dx; p.y += dy; });
    }
    nodes.forEach((p) => { p.y = Math.max(p._r + 24, Math.min(H - p._r - 4, p.y)); if (!byYear) p.x = Math.max(p._r + 4, Math.min(W - p._r - 4, p.x)); });

    const t = svg.transition().duration(drawn ? 450 : 0);
    drawn = true;
    nodeSel.filter((p) => on.has(p)).transition(t).attr("transform", (p) => `translate(${p.x},${p.y})`);
    edgeSel.filter((l) => on.has(l.source) && on.has(l.target)).transition(t)
      .attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y)
      .attr("x2", (l) => trim(l).x).attr("y2", (l) => trim(l).y);

    const ticks = byYear ? d3.range(years[0], years[1] + 1).filter((y) => !small || y % 2 === 0) : [];
    axis.selectAll("g").data(ticks, (d) => d).join(
      (enter) => { const g = enter.append("g"); g.append("line"); g.append("text"); return g; })
      .call((g) => g.select("line").attr("x1", (d) => x(d)).attr("x2", (d) => x(d)).attr("y1", 18).attr("y2", H))
      .call((g) => g.select("text").attr("x", (d) => x(d)).attr("y", 13).text((d) => d));
    highlight(selected);
  }

  // End an edge at the edge of the target circle, so the arrowhead is visible.
  function trim(l) {
    const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y, d = Math.hypot(dx, dy) || 1;
    const k = (d - l.target._r - 2) / d;
    return { x: l.source.x + dx * k, y: l.source.y + dy * k };
  }

  // ---------- interaction ----------
  function showTip(e, p) {
    tip.innerHTML = `<strong>${esc(p.title)}</strong><span>${esc(p.authors)}</span><span>${esc(p.venue)}, ${esc(p.year)}</span>`;
    tip.hidden = false;
    const r = box.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = e.clientX - r.left + 14, top = e.clientY - r.top + 14;
    if (left + tw > r.width - 4) left = Math.max(4, e.clientX - r.left - tw - 14);
    if (top + th > r.height - 4) top = Math.max(4, e.clientY - r.top - th - 14);
    tip.style.left = left + "px"; tip.style.top = top + "px";
  }

  function highlight(p) {
    if (!nodeSel) return;
    if (!p) {
      nodeSel.classed("dim", false).classed("sel", false);
      edgeSel.classed("dim", false).classed("hi", false).attr("marker-end", "url(#arrow)");
      return;
    }
    const near = new Set([p, ...p._cites, ...p._citedBy]);
    nodeSel.classed("dim", (q) => !near.has(q)).classed("sel", (q) => q === selected);
    edgeSel.classed("hi", (l) => l.source === p || l.target === p).classed("dim", (l) => l.source !== p && l.target !== p)
      .attr("marker-end", (l) => (l.source === p || l.target === p ? "url(#arrow-hi)" : "url(#arrow)"));
  }

  function paperList(list) {
    if (!list.length) return `<p class="muted">None in the repository.</p>`;
    return `<ul class="rel-list">${[...list].sort((a, b) => b._year - a._year || a.title.localeCompare(b.title)).map((q) =>
      `<li><button type="button" class="link-btn" data-goto="${papers.indexOf(q)}"><span class="dot" style="background:${colour(q._classes[0])}"></span>${esc(q.title)}</button> <span class="muted">${esc(q.year)}</span></li>`).join("")}</ul>`;
  }

  function select(p, centre) {
    selected = p;
    highlight(p);
    if (!p) {
      details.innerHTML = `<p class="muted">Click a paper in the graph, or choose one above, to see its details and BibTeX.</p>`;
      $("jump").value = "";
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      return;
    }
    $("jump").value = String(papers.indexOf(p));
    if (p._bib && location.hash !== "#" + p._bib.key) history.replaceState(null, "", "#" + p._bib.key);
    if (!visible(p)) { // a filtered-out paper was chosen from the list: show its class again
      p._classes.forEach((c) => shown.add(c));
      $("hide-isolated").checked = false;
      $("legend").querySelectorAll("[data-cls]").forEach((x) => x.setAttribute("aria-pressed", shown.has(x.dataset.cls)));
      relayout();
    }
    const links = [extLink(p.arxiv, "arXiv"), extLink(p.published, "Published"),
      `<a href="index.html?q=${encodeURIComponent(p.title)}">In the table</a>`].filter(Boolean).join(" · ");
    details.innerHTML = `
      <div class="details-top">
        <h2>${esc(p.title)}</h2>
        <button type="button" class="dialog-close" id="details-close" aria-label="Close details">×</button>
      </div>
      <p class="d-meta">${esc(p.authors)}</p>
      <p class="d-meta"><em>${esc(p.venue)}</em>, ${esc(p.year)}</p>
      <p>${p._classes.map((c) => `<span class="chip ${CLASS_STYLE[c] || ""}">${esc(c)}</span>`).join("")}${p._contribs.map((c) => `<span class="chip style">${esc(c)}</span>`).join("")}</p>
      <p class="d-links">${links}</p>
      <h3>Cites (${p._cites.length})</h3>${paperList(p._cites)}
      <h3>Cited By (${p._citedBy.length})</h3>${paperList(p._citedBy)}
      <h3>BibTeX</h3>${bibBlock(p)}`;
    $("details-close").addEventListener("click", () => select(null));
    if (centre) {
      const k = d3.zoomTransform(svg.node()).k;
      svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(W / 2 - p.x * k, H / 2 - p.y * k).scale(k));
    }
    if (window.matchMedia("(max-width: 991px)").matches && centre !== false) details.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function fromHash() {
    const key = decodeURIComponent(location.hash.slice(1));
    const p = key && papers.find((q) => q._bib && q._bib.key === key);
    if (p && p !== selected) select(p, true);
  }
})();
