/* Paper table: loads data/papers.csv (and papers.bib, via common.js), then search / filter / sort in the browser.
   Multi-valued cells (class, contribution) are separated by ";" in the CSV.
   Each paper can have an `arxiv` link and a `published` link; both are shown when present. */
(function () {
  "use strict";

  const { CLASS_STYLE, STYLES, esc, extLink, safeURL, norm } = window.PBR;

  const COLUMNS = [
    { key: "title", label: "Title", sortable: true },
    { key: "authors", label: "Authors", sortable: true },
    { key: "year", label: "Year", sortable: true },
    { key: "venue", label: "Venue", sortable: true },
    { key: "links", label: "Links", sortable: false },
    { key: "class", label: "Topic", sortable: true },
    { key: "contribution", label: "Contribution", sortable: true },
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    search: $("search"), cls: $("f-class"), contrib: $("f-contrib"),
    yfrom: $("f-yfrom"), yto: $("f-yto"), reset: $("reset"),
    thead: $("thead"), tbody: $("tbody"), count: $("count"),
  };

  let papers = [];
  const state = { q: "", cls: "", contrib: "", yfrom: "", yto: "", sort: "year", dir: "desc" };

  // ---------- Helpers ----------
  // Match on the raw text and escape each piece separately, so a search term can never land inside an HTML entity.
  function highlight(text, q) {
    text = String(text);
    const terms = (q || "").split(/\s+/).filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!terms.length) return esc(text);
    return text.split(new RegExp("(" + terms.join("|") + ")", "gi"))
      .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join("");
  }

  // ---------- URL state (so filtered views can be shared) ----------
  function readURL() {
    const p = new URLSearchParams(location.search);
    for (const k of Object.keys(state)) if (p.has(k)) state[k] = p.get(k);
  }
  function writeURL() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) {
      if (v && !(k === "sort" && v === "year") && !(k === "dir" && v === "desc")) p.set(k, v);
    }
    const qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  }

  // ---------- Build controls ----------
  function fillSelect(sel, values, allLabel) {
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  }

  function buildControls() {
    const classOrder = Object.keys(CLASS_STYLE);
    const classes = [...new Set(papers.flatMap((p) => p._classes))]
      .sort((a, b) => (classOrder.indexOf(a) + 1 || 99) - (classOrder.indexOf(b) + 1 || 99) || a.localeCompare(b));
    const contribs = [...new Set(papers.flatMap((p) => p._contribs))]
      .sort((a, b) => (STYLES.indexOf(a) + 1 || 99) - (STYLES.indexOf(b) + 1 || 99) || a.localeCompare(b));
    const years = [...new Set(papers.map((p) => p._year).filter(Boolean))].sort((a, b) => a - b);
    fillSelect(els.cls, classes, "All classes");
    fillSelect(els.contrib, contribs, "All styles");
    fillSelect(els.yfrom, years.map(String), "Any");
    fillSelect(els.yto, years.map(String), "Any");

    // Ignore URL values that are not among the options (otherwise the select looks blank but still filters).
    for (const [k, sel] of [["cls", els.cls], ["contrib", els.contrib], ["yfrom", els.yfrom], ["yto", els.yto]]) {
      sel.value = state[k];
      if (sel.value !== state[k]) { state[k] = ""; sel.value = ""; }
    }
    els.search.value = state.q;

    els.search.addEventListener("input", () => { state.q = els.search.value; render(); });
    els.cls.addEventListener("change", () => { state.cls = els.cls.value; render(); });
    els.contrib.addEventListener("change", () => { state.contrib = els.contrib.value; render(); });
    els.yfrom.addEventListener("change", () => { state.yfrom = els.yfrom.value; render(); });
    els.yto.addEventListener("change", () => { state.yto = els.yto.value; render(); });
    els.reset.addEventListener("click", () => {
      Object.assign(state, { q: "", cls: "", contrib: "", yfrom: "", yto: "", sort: "year", dir: "desc" });
      els.search.value = ""; els.cls.value = ""; els.contrib.value = ""; els.yfrom.value = ""; els.yto.value = "";
      render();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== els.search && !/input|select|textarea/i.test(document.activeElement.tagName)) {
        e.preventDefault(); els.search.focus();
      }
    });

    // Clicking a chip in the table filters by it.
    els.tbody.addEventListener("click", (e) => {
      const bibBtn = e.target.closest("button[data-bib]");
      if (bibBtn) { const p = papers.find((x) => x._bib && x._bib.key === bibBtn.dataset.bib); if (p) PBR.showBibDialog(p); return; }
      const b = e.target.closest("button[data-filter]");
      if (!b) return;
      const which = b.dataset.filter, val = b.dataset.value;
      if (which === "cls") { state.cls = state.cls === val ? "" : val; els.cls.value = state.cls; }
      else { state.contrib = state.contrib === val ? "" : val; els.contrib.value = state.contrib; }
      render();
    });
  }

  // Built once; sort buttons are updated in place so keyboard focus survives re-sorting.
  function buildHeader() {
    els.thead.innerHTML = "<tr>" + COLUMNS.map((c) => c.sortable
      ? `<th scope="col" class="sortable" data-key="${c.key}"><button type="button" class="sort-btn">${c.label} <span class="arrow" aria-hidden="true"></span></button></th>`
      : `<th scope="col">${c.label}</th>`).join("") + "</tr>";
  }
  function updateHeader() {
    els.thead.querySelectorAll("th.sortable").forEach((th) => {
      const sorted = state.sort === th.dataset.key;
      th.classList.toggle("sorted", sorted);
      th.setAttribute("aria-sort", sorted ? (state.dir === "asc" ? "ascending" : "descending") : "none");
      th.querySelector(".arrow").textContent = sorted ? (state.dir === "asc" ? "▲" : "▼") : "↕";
    });
  }

  function onHeaderClick(e) {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.key;
    if (state.sort === key) state.dir = state.dir === "asc" ? "desc" : "asc";
    else { state.sort = key; state.dir = key === "year" ? "desc" : "asc"; }
    render();
  }

  // ---------- Filter / sort / render ----------
  function matches(p) {
    if (state.cls && !p._classes.includes(state.cls)) return false;
    if (state.contrib && !p._contribs.includes(state.contrib)) return false;
    // If "from" is after "to", treat the range as reversed rather than showing nothing.
    const lo = Math.min(+state.yfrom || 0, +state.yto || Infinity), hi = Math.max(+state.yfrom || 0, +state.yto || Infinity);
    if ((state.yfrom || state.yto) && (p._year < lo || p._year > hi)) return false;
    if (state.q) {
      const terms = norm(state.q).split(/\s+/).filter(Boolean);
      return terms.every((t) => p._hay.includes(t));
    }
    return true;
  }

  function sortKey(p, key) {
    if (key === "year") return p._year || 0;
    // Tag columns sort in the site's own order (e.g. Generalised Bayes first), not alphabetically.
    const rank = (list, order) => list.map((x) => String((order.indexOf(x) + 1) || 99).padStart(2, "0")).join(" ");
    if (key === "class") return rank(p._classes, Object.keys(CLASS_STYLE));
    if (key === "contribution") return rank(p._contribs, STYLES);
    return norm(p[key]);
  }

  function render() {
    updateHeader();
    const rows = papers.filter(matches);
    const dir = state.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const ka = sortKey(a, state.sort), kb = sortKey(b, state.sort);
      if (ka < kb) return -dir;
      if (ka > kb) return dir;
      return a.title.localeCompare(b.title);
    });

    els.count.textContent = rows.length === papers.length
      ? `${papers.length} papers`
      : `Showing ${rows.length} of ${papers.length} papers`;

    if (!rows.length) {
      els.tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="empty">No papers match these filters.</td></tr>`;
    } else {
      const q = state.q.trim();
      els.tbody.innerHTML = rows.map((p) => `
        <tr>
          <td class="title">${highlight(p.title, q)}</td>
          <td class="authors">${highlight(p.authors, q)}</td>
          <td class="year">${esc(p.year)}</td>
          <td class="venue">${highlight(p.venue, q)}</td>
          <td class="link">${[extLink(p.arxiv, "arXiv"), extLink(p.published, "Published"),
            p._bib ? `<button type="button" class="link-btn" data-bib="${esc(p._bib.key)}" title="${p._bib.checked ? "BibTeX entry, checked by hand" : "BibTeX entry (auto-generated)"}">BibTeX${p._bib.checked ? " ✓" : ""}</button>` : ""].filter(Boolean).join("<br>")}</td>
          <td class="cls">${p._classes.map((c) =>
            `<button class="chip ${CLASS_STYLE[c] || ""}" data-filter="cls" data-value="${esc(c)}" title="Filter by ${esc(c)}">${esc(c)}</button>`).join("")}</td>
          <td class="contrib">${p._contribs.map((c) =>
            `<button class="chip style" data-filter="contrib" data-value="${esc(c)}" title="Filter by ${esc(c)}">${esc(c)}</button>`).join("")}</td>
        </tr>`).join("");
    }
    writeURL();
  }

  // ---------- Home panels: Discover (paper of the day) + Notice board ----------
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  function hashString(s) { // FNV-1a: same date -> same paper for everyone, all day
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function renderDiscover() {
    const box = $("discover");
    if (!box) return;
    if (!papers.length) { box.innerHTML = `<p class="muted">No papers to show.</p>`; return; }
    const p = papers[hashString(todayISO()) % papers.length];
    const links = [extLink(p.arxiv, "arXiv"), extLink(p.published, "Published")].filter(Boolean).join(" · ");
    box.innerHTML = `
      <p class="discover-title">${esc(p.title)}</p>
      <p class="discover-meta">${esc(p.authors)}</p>
      <p class="discover-meta"><em>${esc(p.venue)}</em>, ${esc(p.year)}${links ? ` · ${links}` : ""}</p>
      <p>${p._classes.map((c) => `<a class="chip ${CLASS_STYLE[c] || ""}" href="?cls=${encodeURIComponent(c)}">${esc(c)}</a>`).join("")}${p._contribs.map((c) => `<span class="chip style">${esc(c)}</span>`).join("")}</p>`;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  function renderNotices(events) {
    const list = $("notices");
    if (!list) return;
    const today = todayISO();
    const upcoming = events
      .map((e) => (/^\d{4}-\d{2}-\d{2}$/.test(e.end_date || "") ? e : Object.assign({}, e, { end_date: "" })))
      .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && (e.end_date || e.date) >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    list.innerHTML = upcoming.length ? upcoming.map((e) => `
      <li>
        <div class="notice-date">${fmtDate(e.date)}${e.end_date ? ` – ${fmtDate(e.end_date)}` : ""}</div>
        <div class="notice-title">${safeURL(e.link) ? extLink(e.link, esc(e.title)) : esc(e.title)}</div>
        ${e.location ? `<div class="notice-loc">${esc(e.location)}</div>` : ""}
        ${e.description ? `<p class="notice-desc">${esc(e.description)}</p>` : ""}
      </li>`).join("")
      : `<li class="muted">No upcoming events right now. See <a href="resources.html">Resources</a> for seminar series and recordings.</li>`;
  }

  // ---------- Init ----------
  readURL();
  fetch("data/events.csv", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then((text) => renderNotices(PBR.parseCSV(text)))
    .catch(() => { const l = $("notices"); if (l) l.innerHTML = `<li class="muted">Could not load events.</li>`; });
  els.thead.addEventListener("click", onHeaderClick);

  PBR.loadPapers()
    .then((loaded) => {
      papers = loaded;
      buildControls();
      buildHeader();
      render();
      renderDiscover();
    })
    .catch((err) => {
      const box = $("discover"); if (box) box.innerHTML = `<p class="muted">Could not load the paper list.</p>`;
      els.tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="empty">Could not load <code>data/papers.csv</code> (${esc(err.message)}). If you opened this file directly from disk, serve the folder instead, e.g. <code>python3 -m http.server</code>.</td></tr>`;
    });
})();
