#!/usr/bin/env python3
"""Find citations between papers in data/papers.csv and write data/citations.csv.

Usage
-----
  python3 scripts/build_graph.py            # look up references and rewrite data/citations.csv
  python3 scripts/build_graph.py --check    # validate data/citations.csv against the paper list (no network)
  python3 scripts/build_graph.py --refresh  # ignore the download cache and fetch everything again

An edge "A cites B" is kept only when both A and B are in the repository. For each paper
the reference list is collected from up to three sources, and an edge found by any of
them is kept:

  openalex    `referenced_works` of every OpenAlex record of the paper (published DOI,
              arXiv DOI and a title search, since preprint and journal versions are often
              separate records)
  crossref    the reference list deposited with the published DOI (matched by DOI or title)
  arxiv-html  the bibliography of the paper's arXiv HTML version (matched by title or arXiv ID)

data/citations.csv has the columns citing, cited, source. `citing` and `cited` are paper
titles exactly as in data/papers.csv. Hand corrections survive re-runs:
  source = manual   an edge the lookups missed; always kept
  source = removed  a wrong edge found by the lookups; keeps it out of the graph
Every other row is regenerated on each run.

Downloads are cached in scripts/.cache/ (git-ignored), so re-running after adding a
paper only fetches what is new. OpenAlex gives anonymous clients a small daily budget;
set OPENALEX_API_KEY to use your own key. Only the Python standard library is used.
"""
import argparse
import csv
import hashlib
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from add_paper import arxiv_id_of, read_rows, similar  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "citations.csv"
CACHE = Path(__file__).resolve().parent / ".cache"
UA = {"User-Agent": "post-bayes-repo-build-graph/1.0 (+https://github.com/Post-Bayesian-Repository/post_bayes_repo)"}
KEEP_SOURCES = ("manual", "removed")
SOURCE_ORDER = ["openalex", "crossref", "arxiv-html", "manual", "removed"]

_last_call = {}
REFRESH = False


def get(url, host_delay=1.0, retries=4):
    """GET with an on-disk cache, a per-host delay and retries on 429/5xx. Returns text or None on 404."""
    key = hashlib.sha1(url.encode()).hexdigest()
    path = CACHE / key
    if path.exists() and not REFRESH:
        txt = path.read_text(encoding="utf-8")
        return None if txt == "\0404" else txt
    host = urllib.parse.urlsplit(url).netloc
    if "arxiv.org" in host:
        host_delay = max(host_delay, 3.0)  # arXiv's guideline: one request every 3 s
    for attempt in range(retries + 1):
        wait = host_delay - (time.monotonic() - _last_call.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        _last_call[host] = time.monotonic()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                txt = r.read().decode("utf-8", "ignore")
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                CACHE.mkdir(exist_ok=True)
                path.write_text("\0404", encoding="utf-8")
                return None
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
            try:
                delay = float(e.headers.get("Retry-After", ""))
            except ValueError:
                delay = 5 * 2 ** attempt
            delay = min(max(delay, 3), 90)
            print(f"    (HTTP {e.code} from {host}; retrying in {delay:.0f} s)", file=sys.stderr)
            time.sleep(delay)
        except urllib.error.URLError as e:
            if attempt == retries:
                raise
            time.sleep(5 * 2 ** attempt)
    CACHE.mkdir(exist_ok=True)
    path.write_text(txt, encoding="utf-8")
    return txt


def fold(t):
    """Lower-case, strip accents, LaTeX maths and punctuation: for fuzzy title matching."""
    t = html.unescape(t or "")
    t = re.sub(r"\$[^$]*\$", " ", t)
    t = unicodedata.normalize("NFKD", t)
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", t).split())


def doi_of(url):
    m = re.search(r"(?:doi\.org/|/doi/(?:abs/|full/)?)(10\.\d{4,9}/[^\s?#]+)", url or "", re.I)
    return m.group(1).rstrip(".").lower() if m else ""


# ---------------------------------------------------------------- sources
def openalex(path, **params):
    if os.environ.get("OPENALEX_API_KEY"):
        params["api_key"] = os.environ["OPENALEX_API_KEY"]
    txt = get("https://api.openalex.org/" + path + ("?" + urllib.parse.urlencode(params) if params else ""), 0.5)
    return json.loads(txt) if txt else None


def openalex_records(p):
    """All OpenAlex records that look like this paper (journal + preprint versions)."""
    recs = {}
    sel = "id,title,publication_year,referenced_works,doi"
    for doi in filter(None, [p["_doi"], "10.48550/arxiv." + p["_aid"] if p["_aid"] else ""]):
        w = openalex("works/doi:" + urllib.parse.quote(doi), select=sel)
        if w and w.get("id"):
            recs[w["id"]] = w
    q = re.sub(r"[^\w\s-]", " ", re.sub(r"\$[^$]*\$", " ", p["title"]))
    res = openalex("works", filter="title.search:" + " ".join(q.split()), select=sel, per_page=10)
    for w in (res or {}).get("results", []):
        if similar(w.get("title") or "", p["title"]) > 0.93 and abs((w.get("publication_year") or 0) - p["_year"]) <= 4:
            recs.setdefault(w["id"], w)
    return list(recs.values())


def crossref_refs(doi):
    txt = get("https://api.crossref.org/works/" + urllib.parse.quote(doi), 1.0)
    return (json.loads(txt)["message"].get("reference") or []) if txt else []


def arxiv_bibliography(aid):
    txt = get("https://arxiv.org/html/" + aid)
    if not txt:
        return []
    items = re.findall(r'<li[^>]*class="ltx_bibitem"[^>]*>(.*?)</li>', txt, re.S)
    return [" ".join(html.unescape(re.sub(r"<[^>]+>", " ", it)).split()) for it in items]


# ---------------------------------------------------------------- matching
class Matcher:
    def __init__(self, papers):
        self.papers = papers
        self.by_doi = {}
        self.by_aid = {}
        self.titles = []
        for p in papers:
            if p["_doi"]:
                self.by_doi[p["_doi"]] = p
            if p["_aid"]:
                self.by_aid[p["_aid"]] = p
                self.by_doi["10.48550/arxiv." + p["_aid"].lower()] = p
            t = fold(p["title"])
            if len(t) >= 25:  # short titles are too likely to match by accident
                self.titles.append((t, p))

    def in_text(self, text):
        """Repository papers named in a free-text reference (by arXiv ID or full title)."""
        found = []
        for m in re.finditer(r"(\d{4}\.\d{4,5})", text or ""):
            if m.group(1) in self.by_aid:
                found.append(self.by_aid[m.group(1)])
        f = " " + fold(text) + " "
        for t, p in self.titles:
            if " " + t + " " in f:
                found.append(p)
        return found


def find_edges(papers, use_openalex=True, use_crossref=True, use_arxiv=True):
    M = Matcher(papers)
    oa_owner = {}  # OpenAlex ID -> paper
    oa_refs = {}   # paper title -> set of referenced OpenAlex IDs
    edges = {}     # (citing, cited) -> set of sources
    had_refs = {}  # paper title -> list of sources that returned a reference list

    def add(a, b, src):
        if a["title"] != b["title"]:
            edges.setdefault((a["title"], b["title"]), set()).add(src)

    for i, p in enumerate(papers, 1):
        print(f"[{i}/{len(papers)}] {p['title'][:70]}", file=sys.stderr)
        had_refs[p["title"]] = []
        if use_openalex:
            try:
                recs = openalex_records(p)
            except Exception as e:
                print(f"    OpenAlex failed: {e}", file=sys.stderr)
                recs = []
            refs = set()
            for w in recs:
                oa_owner.setdefault(w["id"], p)
                refs.update(w.get("referenced_works") or [])
            oa_refs[p["title"]] = refs
            if refs:
                had_refs[p["title"]].append("openalex")
        if use_crossref and p["_doi"]:
            try:
                refs = crossref_refs(p["_doi"])
            except Exception as e:
                print(f"    Crossref failed: {e}", file=sys.stderr)
                refs = []
            if refs:
                had_refs[p["title"]].append("crossref")
            for r in refs:
                d = (r.get("DOI") or "").lower()
                hits = [M.by_doi[d]] if d in M.by_doi else []
                hits += M.in_text(" ".join(str(r.get(k, "")) for k in ("article-title", "unstructured", "volume-title")))
                for q in hits:
                    add(p, q, "crossref")
        if use_arxiv and p["_aid"]:
            try:
                bib = arxiv_bibliography(p["_aid"])
            except Exception as e:
                print(f"    arXiv HTML failed: {e}", file=sys.stderr)
                bib = []
            if bib:
                had_refs[p["title"]].append("arxiv-html")
            for item in bib:
                for q in M.in_text(item):
                    add(p, q, "arxiv-html")

    for title, refs in oa_refs.items():
        p = next(x for x in papers if x["title"] == title)
        for wid in refs:
            if wid in oa_owner:
                add(p, oa_owner[wid], "openalex")
    return edges, had_refs


# ---------------------------------------------------------------- csv
def load_papers():
    papers = []
    for r in read_rows():
        r["_aid"] = arxiv_id_of(r["arxiv"])
        r["_doi"] = doi_of(r["published"])
        r["_year"] = int(r["year"]) if r["year"].isdigit() else 0
        papers.append(r)
    return papers


def read_citations():
    if not OUT.exists():
        return []
    with open(OUT, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def write_citations(rows, papers):
    order = {p["title"]: i for i, p in enumerate(papers)}
    rows.sort(key=lambda r: (order.get(r["citing"], 1e9), order.get(r["cited"], 1e9)))
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["citing", "cited", "source"], lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def check(papers):
    titles = {p["title"] for p in papers}
    bad = 0
    seen = set()
    rows = read_citations()
    for i, r in enumerate(rows, start=2):
        for k in ("citing", "cited"):
            if r.get(k) not in titles:
                close = max(titles, key=lambda t: similar(t, r.get(k) or ""))
                print(f"  citations.csv line {i}: {k} {r.get(k, '')[:60]!r} is not a title in papers.csv (did you mean {close[:60]!r}?)")
                bad += 1
        if r.get("citing") == r.get("cited"):
            print(f"  citations.csv line {i}: a paper citing itself")
            bad += 1
        srcs = [s.strip() for s in (r.get("source") or "").split(";") if s.strip()]
        if not srcs or any(s not in SOURCE_ORDER for s in srcs):
            print(f"  citations.csv line {i}: source should be one or more of {', '.join(SOURCE_ORDER)}")
            bad += 1
        if (r.get("citing"), r.get("cited")) in seen:
            print(f"  citations.csv line {i}: duplicate edge")
            bad += 1
        seen.add((r.get("citing"), r.get("cited")))
    live = sum(1 for r in rows if r.get("source") != "removed")
    print(f"{len(rows)} citation rows ({live} edges), {bad} problem(s) found." if bad
          else f"{len(rows)} citation rows ({live} edges), no problems found.")
    return bad == 0


def main():
    global REFRESH
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="validate data/citations.csv only (no network)")
    ap.add_argument("--refresh", action="store_true", help="ignore the download cache")
    ap.add_argument("--no-openalex", action="store_true")
    ap.add_argument("--no-crossref", action="store_true")
    ap.add_argument("--no-arxiv", action="store_true", help="skip arXiv HTML bibliographies (the slowest source)")
    args = ap.parse_args()
    papers = load_papers()
    if args.check:
        sys.exit(0 if check(papers) else 1)
    REFRESH = args.refresh

    edges, had_refs = find_edges(papers, not args.no_openalex, not args.no_crossref, not args.no_arxiv)
    kept = [r for r in read_citations() if r.get("source") in KEEP_SOURCES]
    pinned = {(r["citing"], r["cited"]) for r in kept}
    rows = kept + [{"citing": a, "cited": b, "source": "; ".join(s for s in SOURCE_ORDER if s in srcs)}
                   for (a, b), srcs in edges.items() if (a, b) not in pinned]
    write_citations(rows, papers)

    live = [r for r in rows if r["source"] != "removed"]
    print(f"\nWrote {OUT.relative_to(ROOT)}: {len(live)} edges between {len(papers)} papers "
          f"({sum(1 for r in kept if r['source'] == 'manual')} manual, "
          f"{sum(1 for r in kept if r['source'] == 'removed')} removed by hand).")
    for src in SOURCE_ORDER[:3]:
        print(f"  found by {src}: {sum(1 for r in live if src in r['source'])}")
    none = [t for t, s in had_refs.items() if not s]
    if none:
        print(f"\nNo reference list found for {len(none)} paper(s); their outgoing citations are missing "
              "(add them by hand with source 'manual'):")
        for t in none:
            print("  -", t)
    linked = {r["citing"] for r in live} | {r["cited"] for r in live}
    iso = [p["title"] for p in papers if p["title"] not in linked]
    if iso:
        print(f"\n{len(iso)} paper(s) have no edges at all:")
        for t in iso:
            print("  -", t)


if __name__ == "__main__":
    main()
