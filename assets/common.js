/* Shared helpers for the paper table (papers.js) and the citation graph (graph.js):
   CSV parsing, loading data/papers.csv + data/papers.bib + data/bibtex_checked.txt,
   and the BibTeX dialog. Exposed as window.PBR. */
(function () {
  "use strict";

  const CLASS_STYLE = {
    "Generalised Bayes": "gb",
    "Predictively Oriented Posteriors": "pro",
    "Martingale Posteriors": "mp",
    "PAC-Bayes": "pac",
  };
  const STYLES = ["Theory", "Method", "Application", "Review"];

  // RFC 4180-ish: quotes, escaped quotes, newlines in quotes.
  function parseCSV(text) {
    const rows = []; let row = []; let field = ""; let inQ = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((v) => v.trim() !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    if (!rows.length) return [];
    const header = rows.shift().map((h) => h.trim().toLowerCase());
    return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || "").trim()])));
  }

  const splitMulti = (s) => (s || "").split(";").map((x) => x.trim()).filter(Boolean);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Only http(s) links are rendered, so a bad CSV value can never become a javascript: URL.
  const safeURL = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
  const extLink = (u, label) => (safeURL(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : "");
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // For matching titles across the CSV, the .bib file and citations.csv.
  const fold = (s) => norm(String(s || "").replace(/\$[^$]*\$/g, " ").replace(/\\[a-zA-Z]+|[{}\\]/g, ""))
    .replace(/[^a-z0-9]+/g, " ").trim();
  const arxivId = (u) => ((u || "").match(/arxiv\.org\/abs\/([^\s?#]+?)(?:v\d+)?$/) || [])[1] || "";
  const doiOf = (u) => (((u || "").match(/(?:doi\.org\/|\/doi\/(?:abs\/|full\/)?)(10\.\d{4,9}\/[^\s?#]+)/i) || [])[1] || "").toLowerCase();

  function preparePaper(p) {
    const order = Object.keys(CLASS_STYLE);
    p._classes = splitMulti(p.class).sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
    p._contribs = splitMulti(p.contribution).sort((x, y) => (STYLES.indexOf(x) + 1 || 99) - (STYLES.indexOf(y) + 1 || 99));
    p._year = parseInt(p.year, 10) || 0;
    p._hay = norm([p.title, p.authors, p.venue, p.year, p.class, p.contribution].join(" "));
    p._aid = arxivId(p.arxiv);
    p._doi = doiOf(p.published);
    return p;
  }

  // ---------- BibTeX ----------
  // Brace-balanced parser, good enough for the generated data/papers.bib.
  function parseBib(text) {
    const out = [];
    const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
    let m;
    while ((m = re.exec(text))) {
      let depth = 1, i = re.lastIndex;
      while (i < text.length && depth) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; i++; }
      const body = text.slice(re.lastIndex, i - 1);
      const fields = {};
      const fr = /(\w+)\s*=\s*\{/g; let f;
      while ((f = fr.exec(body))) {
        let d = 1, k = fr.lastIndex;
        while (k < body.length && d) { if (body[k] === "{") d++; else if (body[k] === "}") d--; k++; }
        const name = f[1].toLowerCase();
        if (!(name in fields)) fields[name] = body.slice(fr.lastIndex, k - 1);
        fr.lastIndex = k;
      }
      out.push({ type: m[1].toLowerCase(), key: m[2], text: text.slice(m.index, i), fields });
      re.lastIndex = i;
    }
    return out;
  }

  function attachBib(papers, bibText, checkedText) {
    const entries = parseBib(bibText || "");
    const checked = new Set((checkedText || "").split(/\r?\n/).map((l) => l.split("#")[0].trim()).filter(Boolean));
    const byEprint = new Map(), byDoi = new Map(), byTitle = new Map();
    for (const e of entries) {
      if (e.fields.eprint) byEprint.set(e.fields.eprint.trim(), e);
      if (e.fields.doi) byDoi.set(e.fields.doi.trim().toLowerCase(), e);
      if (e.fields.title) byTitle.set(fold(e.fields.title), e);
    }
    for (const p of papers) {
      const e = (p._aid && byEprint.get(p._aid)) || (p._doi && byDoi.get(p._doi)) || byTitle.get(fold(p.title));
      p._bib = e ? { key: e.key, text: e.text, checked: checked.has(e.key) } : null;
    }
  }

  // Fetch a text file; resolves to "" when it is missing, so optional files never break the page.
  const getText = (url, required) => fetch(url, { cache: "no-cache" }).then((r) => {
    if (!r.ok) { if (required) throw new Error(`${url}: HTTP ${r.status}`); return ""; }
    return r.text();
  });

  // Loads the papers plus their BibTeX. Resolves to the prepared paper array.
  function loadPapers() {
    return Promise.all([getText("data/papers.csv", true), getText("data/papers.bib").catch(() => ""), getText("data/bibtex_checked.txt").catch(() => "")])
      .then(([csv, bib, checked]) => {
        const papers = parseCSV(csv).filter((p) => p.title).map(preparePaper);
        attachBib(papers, bib, checked);
        return papers;
      });
  }

  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { if (!document.execCommand("copy")) throw new Error("copy failed"); } finally { ta.remove(); }
  }
  function copyText(text) {
    const viaApi = navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard API"));
    return viaApi.catch(() => legacyCopy(text));
  }

  // Markup for a BibTeX block with a copy button and the checked status.
  function bibBlock(p) {
    if (!p._bib) return `<p class="muted">No BibTeX entry yet. Run <code>scripts/build_bibtex.py</code> to generate one.</p>`;
    const status = p._bib.checked
      ? `<span class="bib-status checked" title="Someone has compared this entry with the published version">✓ Checked by hand</span>`
      : `<span class="bib-status" title="Generated automatically from the DOI, proceedings page or arXiv; please check before relying on it">Auto-generated, not yet checked</span>`;
    return `<div class="bib">
      <div class="bib-head">${status}<button type="button" class="btn btn-sm bib-copy" data-key="${esc(p._bib.key)}">Copy BibTeX</button></div>
      <pre class="bib-text" tabindex="0">${esc(p._bib.text)}</pre>
    </div>`;
  }

  // Delegated handler for every "Copy BibTeX" button on the page.
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".bib-copy");
    if (!b) return;
    const pre = b.closest(".bib").querySelector(".bib-text");
    const label = b.textContent;
    copyText(pre.textContent).then(() => { b.textContent = "Copied ✓"; }, () => {
      const r = document.createRange(); r.selectNodeContents(pre);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      b.textContent = "Press Ctrl/⌘+C";
    }).finally(() => setTimeout(() => { b.textContent = label; }, 1800));
  });

  // A shared <dialog> showing one paper's BibTeX (used by the table).
  let dialog;
  function showBibDialog(p) {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "bib-dialog";
      dialog.setAttribute("aria-labelledby", "bib-dialog-title");
      document.body.appendChild(dialog);
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog || e.target.closest(".dialog-close")) dialog.close();
      });
    }
    dialog.innerHTML = `
      <div class="dialog-inner">
        <div class="dialog-top">
          <h2 id="bib-dialog-title">BibTeX</h2>
          <button type="button" class="dialog-close" aria-label="Close">×</button>
        </div>
        <p class="dialog-paper">${esc(p.title)} <span class="muted">(${esc(p.year)})</span></p>
        ${bibBlock(p)}
      </div>`;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    const copy = dialog.querySelector(".bib-copy");
    if (copy) copy.focus();
  }

  window.PBR = { CLASS_STYLE, STYLES, parseCSV, splitMulti, esc, safeURL, extLink, norm, fold, loadPapers, getText, bibBlock, showBibDialog, copyText };
})();
