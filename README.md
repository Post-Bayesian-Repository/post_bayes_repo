# Post-Bayesian Repository

A curated, searchable list of papers on post-Bayesian inference (generalised Bayes, predictively oriented
posteriors, martingale posteriors) and the related PAC-Bayes theory.

The site is plain HTML/CSS/JS with no build step, served by GitHub Pages.

## Structure

```
index.html             Home: intro + searchable/sortable paper table (with a BibTeX button per paper)
graph.html             Citation graph between the papers in the repository
background.html        Overview of the main post-Bayesian families (math rendered with KaTeX)
resources.html         Seminars, events, software
about.html             Scope, tagging scheme, how to contribute
data/papers.csv        The paper list (the only file you need to edit to add papers)
data/citations.csv     Citations between repository papers (generated, hand-correctable)
data/papers.bib        One BibTeX entry per paper (generated, hand-correctable)
data/bibtex_checked.txt  Keys of BibTeX entries that have been checked by hand
data/events.csv        Events shown on the homepage notice board
scripts/               add_paper.py (add papers, validate the CSV), build_graph.py, build_bibtex.py
assets/                style.css, common.js (shared loading/BibTeX), papers.js (table), graph.js (graph), img/
```

## Adding papers

### With the helper script (recommended)

From the repository root, pass one or more arXiv IDs/URLs or DOIs:

```bash
python3 scripts/add_paper.py 2510.01915
python3 scripts/add_paper.py 2408.08806 10.1111/rssb.12158 https://arxiv.org/abs/2103.15671
```

For each paper the script:

1. looks up the title, authors and year (arXiv API / Crossref);
2. finds the other version: the published DOI of an arXiv paper, or the arXiv version of a DOI;
3. skips it if it is already in the list (same arXiv ID, DOI or title);
4. lets you check or edit every field (Enter keeps the suggestion, `-` clears it) and pick the class and
   contribution style from a numbered list;
5. shows the finished row and asks before saving. Rows are kept sorted by year, then title.

Other options:

```bash
python3 scripts/add_paper.py --file to_add.txt     # one ID/DOI per line; '#' starts a comment
python3 scripts/add_paper.py 2510.01915 --class "Predictively Oriented Posteriors" --contribution "Theory; Method"
python3 scripts/add_paper.py 2510.01915 --dry-run  # preview without saving
python3 scripts/add_paper.py --check               # validate the whole CSV
```

Crossref does not index NeurIPS, ICML, AISTATS or ICLR papers, so for those, paste the proceedings link
(e.g. `proceedings.mlr.press/...`, `papers.nips.cc/...`, `openreview.net/forum?id=...`) when asked for `published`.
`--check` also runs automatically on GitHub for every push and pull request that touches the paper list.

### By hand

Add a row to `data/papers.csv`, then run `python3 scripts/add_paper.py --check`:

| column | notes |
|---|---|
| `title` | quote it if it contains a comma |
| `authors` | full names, comma-separated, wrapped in quotes |
| `year` | publication year (or arXiv year for preprints); 2016 or later — earlier work goes under "Scope and precedents" in `about.html` |
| `venue` | journal/conference, or `arXiv preprint` |
| `arxiv` | arXiv abs page (always include when one exists) |
| `published` | DOI or proceedings page of the published version (blank for preprints) |
| `class` | one or more of: `Generalised Bayes`, `Predictively Oriented Posteriors`, `Martingale Posteriors`, `PAC-Bayes` — separate multiple with `;` |
| `contribution` | one or more of `Theory`, `Method`, `Application`, `Review` — separated with `;` |

To introduce a new class, add it to `CLASSES` in `scripts/add_paper.py` and `CLASS_STYLE` in `assets/papers.js`,
plus a matching `.chip` colour rule in `assets/style.css`.

## Citation graph and BibTeX

After adding papers, refresh the citations and BibTeX (both scripts use only the Python standard library):

```bash
python3 scripts/build_graph.py      # rewrite data/citations.csv (a few minutes; downloads are cached)
python3 scripts/build_bibtex.py     # add BibTeX entries for papers that have none yet
```

### `scripts/build_graph.py`

Finds, for each paper, which other repository papers it cites, using three sources and keeping an edge found by any of them:
OpenAlex `referenced_works` (looked up by published DOI, arXiv DOI and title, since preprint and journal versions are often
separate records), the Crossref reference list of the published DOI, and the bibliography of the arXiv HTML version. Requests
are spaced out (3 s for arXiv) and retried on HTTP 429; responses are cached in `scripts/.cache/` (git-ignored), so re-runs
only fetch what is new. `--refresh` ignores the cache, `--no-arxiv` skips the slowest source. OpenAlex gives anonymous clients
a small daily budget; set `OPENALEX_API_KEY` to use your own free key.

`data/citations.csv` has one row per edge: `citing,cited,source`, where `citing` and `cited` are titles exactly as in
`papers.csv` and `source` lists what found the edge. To correct the graph by hand:

- add a missing edge with source `manual`;
- keep a wrong edge out of the graph by changing its source to `removed` (deleting the row is not enough: the next run would add it back).

Rows marked `manual` or `removed` survive re-runs; all others are regenerated. The script ends with a report of papers for
which no reference list was found (their outgoing citations need adding by hand) and papers with no edges at all.

### `scripts/build_bibtex.py`

Writes `data/papers.bib` with one entry per paper, keyed like `fong2023martingale` (first author's surname, year, first word
of the title). Metadata comes from the DOI (doi.org, CSL JSON), else from the proceedings page (PMLR, NeurIPS, JMLR), else
from the CSV row; arXiv-only papers become `@misc` with `eprint`. Titles and venue names come from `papers.csv`, proper nouns
and acronyms are protected with braces, and accents are written as LaTeX commands.

Existing entries are kept as they are; `--refresh` regenerates the ones that have not been checked. **To mark an entry as
checked**, compare it with the published version, fix `data/papers.bib` by hand if needed, and add its key to
`data/bibtex_checked.txt`. Checked entries are never overwritten, and the website shows them as "Checked by hand"
(and as "BibTeX ✓" in the table).

Both scripts have a `--check` mode (no network), run on GitHub together with `add_paper.py --check`: it reports
`citations.csv` rows whose titles are not in `papers.csv`, duplicate BibTeX keys, checked keys that do not exist, and
papers without a BibTeX entry (as a warning). If you edit a paper's title in `papers.csv`, update it in `citations.csv` too.

## Homepage panels

- **Discover** shows one paper from `data/papers.csv`, picked from the date. Everyone sees the same paper on a given day,
  and it changes at midnight (the visitor's local time). Nothing to maintain.
- **Notice Board** lists events from `data/events.csv`:

  | column | notes |
  |---|---|
  | `date` | start date, `YYYY-MM-DD` |
  | `end_date` | optional last day for multi-day events, `YYYY-MM-DD` |
  | `title` | event name |
  | `location` | quote it if it contains a comma |
  | `link` | event page |
  | `description` | one or two sentences, in quotes |

  Events are shown soonest first and disappear automatically once their (end) date has passed, so old rows can stay in the file.

## Running locally

The table and the graph load the data files with `fetch`, so serve the folder rather than opening the file directly:

```bash
python3 -m http.server 8765
```

then open http://localhost:8765.