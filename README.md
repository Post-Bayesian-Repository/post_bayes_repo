# Post-Bayesian Repository

A curated, searchable list of papers on post-Bayesian inference: generalised Bayes, predictively oriented
posteriors, martingale posteriors, and PAC-Bayes.

The site is plain HTML/CSS/JS with no build step, served by GitHub Pages.

## Structure

```
index.html        Home: intro + searchable/sortable paper table
background.html   Overview of the main post-Bayesian families (math rendered with KaTeX)
resources.html    Seminars, events, software
about.html        Scope, tagging scheme, how to contribute
data/papers.csv   The paper list (the only file you need to edit to add papers)
data/events.csv   Events shown on the homepage notice board
scripts/          add_paper.py: add papers from an arXiv ID or DOI, and validate the CSV
assets/           style.css, papers.js (table logic), img/
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
| `year` | publication year (or arXiv year for preprints) |
| `venue` | journal/conference, or `arXiv preprint` |
| `arxiv` | arXiv abs page (always include when one exists) |
| `published` | DOI or proceedings page of the published version (blank for preprints) |
| `class` | one or more of: `Generalised Bayes`, `Predictively Oriented Posteriors`, `Martingale Posteriors`, `PAC-Bayes` — separate multiple with `;` |
| `contribution` | one or more of `Theory`, `Method`, `Application`, `Review` — separated with `;` |

To introduce a new class, add it to `CLASSES` in `scripts/add_paper.py` and `CLASS_STYLE` in `assets/papers.js`,
plus a matching `.chip` colour rule in `assets/style.css`.

## Homepage panels

- **Discover** shows one paper from `data/papers.csv`, picked from the date. Everyone sees the same paper on a given day,
  and it changes at midnight (the visitor's local time). Nothing to maintain.
- **Notice board** lists events from `data/events.csv`:

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

The table loads the CSV with `fetch`, so serve the folder rather than opening the file directly:

```bash
python3 -m http.server 8765
```

then open http://localhost:8765.