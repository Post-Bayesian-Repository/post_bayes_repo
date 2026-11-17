#!/usr/bin/env python3
"""Add papers to data/papers.csv, or check the file for problems.

Usage
-----
  python3 scripts/add_paper.py 2510.01915               # arXiv ID
  python3 scripts/add_paper.py https://arxiv.org/abs/2103.15671
  python3 scripts/add_paper.py 10.1111/rssb.12158       # DOI (or https://doi.org/...)
  python3 scripts/add_paper.py 2408.08806 1907.09611    # several at once
  python3 scripts/add_paper.py --file to_add.txt        # one ID/DOI per line ('#' comments allowed)
  python3 scripts/add_paper.py --check                  # validate the CSV only

For each paper the script looks up the metadata (arXiv API and Crossref), tries to
find the arXiv version of a DOI and the published version of an arXiv paper, then
asks you to confirm or edit every field and to choose its tags. Press Enter to
accept the value in [brackets]. Nothing is written until you confirm.

Tags can be given up front to skip those questions, e.g.
  python3 scripts/add_paper.py 2510.01915 --class "Predictively Oriented Posteriors" --contribution "Theory; Method"

Only the Python standard library is used.
"""
import argparse
import csv
import difflib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "papers.csv"
FIELDS = ["title", "authors", "year", "venue", "arxiv", "published", "class", "contribution"]
CLASSES = ["Generalised Bayes", "Predictively Oriented Posteriors", "Martingale Posteriors", "PAC-Bayes"]
CONTRIBUTIONS = ["Theory", "Method", "Application", "Review"]
FIRST_YEAR = 2016  # the table starts with Bissiri, Holmes & Walker (2016); earlier work goes on the About page
UA = {"User-Agent": "post-bayes-repo-add-paper/1.0"}

ARXIV_RE = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/|arxiv:)?(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?(?:\.pdf)?$", re.I)
DOI_RE = re.compile(r"(?:https?://(?:dx\.)?doi\.org/|doi:)?(10\.\d{4,9}/\S+)$", re.I)


# ---------------------------------------------------------------- helpers
_last_arxiv_call = 0.0


def fetch(url, retries=4):
    """GET a URL. arXiv calls are spaced 3 s apart (arXiv's API guideline), and
    rate-limit / temporary errors (429, 502, 503, 504) are retried with backoff."""
    global _last_arxiv_call
    for attempt in range(retries + 1):
        if "arxiv.org" in url:
            wait = 3.0 - (time.monotonic() - _last_arxiv_call)
            if wait > 0:
                time.sleep(wait)
            _last_arxiv_call = time.monotonic()
        req = urllib.request.Request(url, headers=UA)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            if e.code not in (429, 502, 503, 504) or attempt == retries:
                raise
            try:
                delay = float(e.headers.get("Retry-After", ""))
            except ValueError:
                delay = 5 * 2 ** attempt
            delay = min(max(delay, 3), 60)
            print(f"  (server busy, HTTP {e.code}; retrying in {delay:.0f} s)")
            time.sleep(delay)


def norm(t):
    t = re.sub(r"\$[^$]*\$", "", html.unescape(t or "").lower())
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def similar(a, b):
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def tidy(s):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", s or "")).split())


def arxiv_id_of(url):
    m = re.search(r"arxiv\.org/abs/([^\s?#]+)", url or "")
    return re.sub(r"v\d+$", "", m.group(1)) if m else ""


def parse_identifier(s):
    s = s.strip()
    bare = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)", "", s, flags=re.I)
    m = re.fullmatch(r"10\.48550/arxiv\.(.+)", bare, re.I)  # arXiv's own DOI
    if m:
        return "arxiv", m.group(1)
    m = ARXIV_RE.search(s.split("?")[0])
    if m and not bare.lower().startswith("10."):
        return "arxiv", m.group(1)
    m = DOI_RE.search(s)
    if m:
        return "doi", m.group(1).rstrip(".")
    raise ValueError(f"Not an arXiv ID/URL or DOI: {s}")


# ---------------------------------------------------------------- lookups
def arxiv_entries(query):
    x = fetch("https://export.arxiv.org/api/query?" + query, retries=2)
    out = []
    for e in x.split("<entry>")[1:]:
        get = lambda tag: (re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", e, re.S) or [None, ""])[1]
        out.append({
            "id": re.sub(r"v\d+$", "", get("id").rsplit("/abs/", 1)[-1]),
            "title": tidy(get("title")),
            "authors": [tidy(a) for a in re.findall(r"<name>(.*?)</name>", e)],
            "year": get("published")[:4],
            "doi": tidy(get("arxiv:doi")),
            "journal_ref": tidy(get("arxiv:journal_ref")),
        })
    return out


def lookup_arxiv(aid):
    try:
        entries = arxiv_entries("id_list=" + urllib.parse.quote(aid))
    except Exception as e:  # arXiv often rate-limits (HTTP 429); fall back to DataCite
        print(f"  (arXiv API unavailable: {e}; using DataCite instead)")
        return lookup_datacite(aid)
    if not entries or not entries[0]["title"]:
        raise LookupError(f"arXiv ID {aid} not found")
    return entries[0]


def lookup_datacite(aid):
    """arXiv registers every paper with DataCite as DOI 10.48550/arXiv.<id>."""
    try:
        d = json.loads(fetch("https://api.datacite.org/dois/10.48550/arxiv." + urllib.parse.quote(aid)))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise LookupError(f"arXiv ID {aid} not found") from None
        raise
    a = d["data"]["attributes"]
    authors = []
    for c in a.get("creators", []):
        given, family = c.get("givenName"), c.get("familyName")
        if given and family:
            authors.append(f"{given} {family}")
        else:
            name = c.get("name", "")
            authors.append(" ".join(reversed(name.split(", ", 1))) if ", " in name else name)
    published_doi = next((r["relatedIdentifier"] for r in a.get("relatedIdentifiers", [])
                          if r.get("relatedIdentifierType") == "DOI"
                          and r.get("relationType") in ("IsVersionOf", "IsIdenticalTo", "IsPreviousVersionOf")
                          and not r["relatedIdentifier"].lower().startswith("10.48550/")), "")
    return {"id": aid, "title": tidy(a["titles"][0]["title"]), "authors": authors,
            "year": str(a.get("publicationYear", "")), "doi": published_doi, "journal_ref": ""}


def search_arxiv_by_title(title):
    words = [w for w in norm(title).split() if len(w) > 3][:8]
    if not words:
        return None
    q = "max_results=5&search_query=" + urllib.parse.quote(" AND ".join("ti:" + w for w in words))
    best = max(arxiv_entries(q), key=lambda e: similar(e["title"], title), default=None)
    return best if best and similar(best["title"], title) > 0.9 else None


def crossref_work(doi):
    return json.loads(fetch("https://api.crossref.org/works/" + urllib.parse.quote(doi)))["message"]


def search_crossref_by_title(title, first_author=""):
    q = urllib.parse.quote(f"{title} {first_author}".strip())
    items = json.loads(fetch(f"https://api.crossref.org/works?rows=5&query.bibliographic={q}"))["message"]["items"]
    for it in items:
        if it.get("type") in ("posted-content", "peer-review", "component"):
            continue
        if similar((it.get("title") or [""])[0], title) > 0.9:
            return it
    return None


def crossref_fields(it):
    year = (it.get("issued", {}).get("date-parts") or [[None]])[0][0]
    authors = [" ".join(filter(None, [a.get("given"), a.get("family")])) for a in it.get("author", [])]
    return {
        "title": tidy((it.get("title") or [""])[0]),
        "authors": authors,
        "year": str(year or ""),
        "venue": tidy((it.get("container-title") or [""])[0]),
        "published": "https://doi.org/" + it["DOI"],
    }


def gather(kind, ident):
    """Return a dict of suggested field values, plus notes about what was found."""
    rec, notes = {k: "" for k in FIELDS}, []
    if kind == "arxiv":
        a = lookup_arxiv(ident)
        rec.update(title=a["title"], authors=", ".join(a["authors"]), year=a["year"],
                   venue="arXiv preprint", arxiv=f"https://arxiv.org/abs/{a['id']}")
        pub = None
        try:
            if a["doi"]:
                pub = crossref_work(a["doi"])
                notes.append(f"arXiv lists a published DOI: {a['doi']}")
            else:
                pub = search_crossref_by_title(a["title"], a["authors"][0].split()[-1] if a["authors"] else "")
                if pub:
                    notes.append("Found a likely published version on Crossref by title. Please check it.")
        except Exception as e:  # network or parsing problems should not stop the add
            notes.append(f"Crossref lookup failed ({e}).")
        if pub:
            c = crossref_fields(pub)
            rec.update(venue=c["venue"] or rec["venue"], year=c["year"] or rec["year"], published=c["published"])
        else:
            notes.append("No published version found. Conference papers (NeurIPS, ICML, AISTATS, ICLR) are not on "
                         "Crossref, so paste the proceedings link if there is one.")
        if a["journal_ref"]:
            notes.append(f"arXiv journal reference: {a['journal_ref']}")
    else:
        c = crossref_fields(crossref_work(ident))
        rec.update(title=c["title"], authors=", ".join(c["authors"]), year=c["year"],
                   venue=c["venue"], published=c["published"])
        try:
            a = search_arxiv_by_title(c["title"])
            if a:
                rec["arxiv"] = f"https://arxiv.org/abs/{a['id']}"
                notes.append(f"Found arXiv version {a['id']} by title.")
            else:
                notes.append("No arXiv version found by title.")
        except Exception as e:
            notes.append(f"arXiv lookup failed ({e}).")
    return rec, notes


# ---------------------------------------------------------------- CSV
def read_rows():
    with open(CSV_PATH, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def write_rows(rows):
    rows.sort(key=lambda r: (int(r["year"]) if r["year"].isdigit() else 0, r["title"].lower()))
    with open(CSV_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
        w.writeheader()
        w.writerows({k: r.get(k, "") for k in FIELDS} for r in rows)


def split_multi(s):
    return [x.strip() for x in (s or "").split(";") if x.strip()]


def problems(row):
    out = []
    for k in ("title", "authors", "year", "venue", "class", "contribution"):
        if not row.get(k, "").strip():
            out.append(f"missing {k}")
    if row.get("year") and not re.fullmatch(r"\d{4}", row["year"]):
        out.append(f"year '{row['year']}' is not a 4-digit year")
    elif row.get("year") and int(row["year"]) < FIRST_YEAR:
        out.append(f"year {row['year']} is before {FIRST_YEAR}: list it under 'Scope and precedents' in about.html instead")
    if not row.get("arxiv") and not row.get("published"):
        out.append("no link at all")
    if row.get("arxiv") and not re.match(r"https://arxiv\.org/abs/", row["arxiv"]):
        out.append("arxiv link should look like https://arxiv.org/abs/<id>")
    if row.get("published") and not re.match(r"https?://", row["published"]):
        out.append("published link should start with https://")
    for c in split_multi(row.get("class")):
        if c not in CLASSES:
            out.append(f"unknown class '{c}'")
    for c in split_multi(row.get("contribution")):
        if c not in CONTRIBUTIONS:
            out.append(f"unknown contribution '{c}'")
    return out


def find_duplicate(rows, rec):
    aid = arxiv_id_of(rec["arxiv"])
    for r in rows:
        if aid and arxiv_id_of(r["arxiv"]) == aid:
            return r
        if rec["published"] and r["published"].lower() == rec["published"].lower():
            return r
        if similar(r["title"], rec["title"]) > 0.92:
            return r
    return None


def check(rows):
    bad = 0
    for i, r in enumerate(rows, start=2):  # line 1 is the header
        for p in problems(r):
            print(f"  line {i}: {r['title'][:60]!r}: {p}")
            bad += 1
    seen = {}
    for i, r in enumerate(rows, start=2):
        key = arxiv_id_of(r["arxiv"]) or norm(r["title"])
        if key in seen:
            print(f"  line {i}: duplicate of line {seen[key]}: {r['title'][:60]!r}")
            bad += 1
        seen[key] = i
    print(f"{len(rows)} papers, {bad} problem(s) found." if bad else f"{len(rows)} papers, no problems found.")
    return bad == 0


# ---------------------------------------------------------------- prompts
def ask(label, default=""):
    shown = f" [{default}]" if default else ""
    val = input(f"  {label}{shown}: ").strip()
    if val == "-":
        return ""  # '-' clears the field
    return val or default


def choose(label, options, default=""):
    print(f"  {label}:")
    for i, o in enumerate(options, 1):
        print(f"    {i}. {o}")
    while True:
        raw = ask("Pick one or more numbers (e.g. 1,4)", default)
        picked = []
        for part in re.split(r"[,\s;]+", raw):
            if not part:
                continue
            if part.isdigit() and 1 <= int(part) <= len(options):
                picked.append(options[int(part) - 1])
            elif part in options:
                picked.append(part)
            else:
                picked = None
                break
        if picked:
            return "; ".join(dict.fromkeys(picked))
        print("    Please enter numbers from the list.")


def add_one(identifier, rows, args):
    print(f"\n=== {identifier}")
    try:
        kind, ident = parse_identifier(identifier)
        rec, notes = gather(kind, ident)
    except Exception as e:
        print(f"  Could not look this up: {e}")
        return None
    for n in notes:
        print(f"  note: {n}")

    dup = find_duplicate(rows, rec)
    if dup:
        print(f"  Already in the list: {dup['title']} ({dup['year']}). Skipping.")
        return None

    print("  Check each field. Press Enter to keep it, type a new value to replace it, or '-' to clear it.")
    for k in ("title", "authors", "year", "venue", "arxiv", "published"):
        rec[k] = ask(k, rec[k])
    rec["class"] = args.cls or choose("Post-Bayesian class", CLASSES)
    rec["contribution"] = args.contribution or choose("Contribution style", CONTRIBUTIONS)

    issues = problems(rec)
    print("\n  " + "\n  ".join(f"{k:>12}: {rec[k]}" for k in FIELDS))
    if issues:
        print("  warning: " + "; ".join(issues))
    if args.dry_run:
        print("  (dry run: not saved)")
        return None
    if ask("Add this paper? (y/n)", "y").lower().startswith("y"):
        return rec
    print("  Skipped.")
    return None


def main():
    p = argparse.ArgumentParser(description="Add papers to data/papers.csv or check it.",
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    p.add_argument("ids", nargs="*", help="arXiv IDs/URLs or DOIs")
    p.add_argument("--file", help="text file with one arXiv ID or DOI per line")
    p.add_argument("--class", dest="cls", help=f"class(es), ';'-separated, from: {', '.join(CLASSES)}")
    p.add_argument("--contribution", help=f"style(s), ';'-separated, from: {', '.join(CONTRIBUTIONS)}")
    p.add_argument("--check", action="store_true", help="only validate data/papers.csv")
    p.add_argument("--dry-run", action="store_true", help="look up and preview, but do not save")
    args = p.parse_args()

    rows = read_rows()
    if args.check:
        sys.exit(0 if check(rows) else 1)

    for opt, allowed in ((args.cls, CLASSES), (args.contribution, CONTRIBUTIONS)):
        for v in split_multi(opt):
            if v not in allowed:
                p.error(f"'{v}' is not one of: {', '.join(allowed)}")

    ids = list(args.ids)
    if args.file:
        for line in Path(args.file).read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                ids.append(line)
    if not ids:
        p.print_help()
        sys.exit(1)

    added = []
    try:
        for i in ids:
            rec = add_one(i, rows + added, args)
            if rec:
                added.append(rec)
    except (KeyboardInterrupt, EOFError):
        print("\n  Interrupted.")
    if added:
        write_rows(rows + added)
        print(f"\nAdded {len(added)} paper(s) to {CSV_PATH.relative_to(ROOT)}.")
    else:
        print("\nNothing added.")


if __name__ == "__main__":
    main()
