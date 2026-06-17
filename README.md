# Gov Policy Terminal

A local, modular government-policy terminal: a FastAPI backend that caches data
in SQLite and serves a dependency-light HTML/CSS/JS frontend. A background job
refreshes the cache hourly; the UI always reads from the cache, so it is instant
and never blocks on a live API.

> **Status:** Phases 1–2 complete. **Stocks panel** + **Bills feed** + **Bill
> movers** are built end to end. Watchlist, search/filter, and the lazy bill
> detail view are the next phases.

## Architecture

```
gov-terminal/
├── config.py        # categories→tickers, refresh interval, keys from .env
├── db.py            # SQLite cache: generic snapshot store + change detection
├── main.py          # FastAPI app + APScheduler wiring + auto-discovery
├── cache.db         # SQLite snapshot (auto-created; git-ignored)
├── sources/         # ONE file per data source, behind a shared interface
│   ├── base.py          # the Source interface + isolated runner + registry
│   └── stocks.py        # yfinance (batched, fully isolated)
├── panels/          # ONE file per panel (auto-mounted FastAPI routers)
│   ├── stocks_panel.py
│   └── __init__.py      # panel auto-discovery + manifest
└── static/          # frontend (index.html, css, js/panels/<id>.js)
```

### How modularity works (drop-in, no rewiring)

- **New data source:** add `sources/myfeed.py` defining a `Source` subclass with a
  unique `name` and a `fetch()` method. It auto-registers on import; the scheduler
  picks it up. See [`sources/base.py`](sources/base.py) for the full contract.
- **New panel:** add `panels/myfeed_panel.py` exporting `PANEL = {...}` and a
  FastAPI `router`, plus `static/js/panels/<id>.js` exporting `render(container)`.
  It is auto-mounted and appears in the UI. No existing file changes.

### Failure isolation

Each source runs inside `Source.run()`, which catches every exception. If
yfinance breaks, the bill panels keep working, and vice versa. Each module logs
under its own name (`source.stocks`, `db`, `panels`, …).

## Setup

```bash
# 1. Create and activate a virtual environment
python3 -m venv env
source env/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure API keys
cp .env.example .env
#   then edit .env and paste your Congress.gov key into CONGRESS_API_KEY=
#   (leave LEGISCAN_API_KEY blank — the fallback stays dormant and the app runs fine)
```

## Run

```bash
source env/bin/activate
uvicorn main:app --reload
```

Then open **http://127.0.0.1:8000** in your browser.

On first run the cache is empty, so the app kicks off an **immediate** fetch in
the background — refresh the page after a few seconds and the stock quotes
appear. After that, the cache refreshes automatically every
`REFRESH_INTERVAL_MINUTES` (default 60).

## Features (current)

- **Stocks by Federal Priority** — all 27 tickers pulled in a single batched
  yfinance call, grouped into the 8 priority categories defined in
  [`config.py`](config.py). Each row shows the ticker, **company name**, price,
  daily change, and % change. Company names are resolved once and cached in
  SQLite (`ticker_names`), so the hourly price refresh stays lightweight.
  Direction is shown three ways so it is **colourblind-safe**: colour **and** a
  `+`/`-` sign **and** a ▲/▼ glyph, with screen-reader labels.
- **Bills — Federal Priorities** — recently-updated bills whose titles match the
  priority topics in `config.py` (`BILL_SEARCH_TERMS`), newest action first, each
  with a labelled stage badge (Introduced → In Committee → … → Became Law). Data
  from Congress.gov (primary); LegiScan is a dormant fallback. Requires
  `CONGRESS_API_KEY` — without it the panel shows a "key needed" hint.
- **Bill Movers — Status Changes** — bills whose stage changed between snapshots,
  computed by diffing each hourly pull against the previous one in SQLite. Shows
  the `old → new` transition and when it was detected. Brand-new bills are not
  movers; only real stage transitions appear.
- **Last updated / next refresh** indicator in the header.
- **Refresh now** button (manual refresh) and **A− / A+** text-size controls;
  fully keyboard navigable with a skip link.
- **2×2 dashboard layout** — each panel occupies one quadrant of the screen and
  scrolls independently. A **"See more"** button on each panel opens it
  full-screen in-app (Esc or "Back to dashboard" to return). The bottom-right
  quadrant is reserved for the upcoming Watchlist panel; panels auto-place by
  discovery order, so new ones drop in with no layout changes.

### Adding & removing stocks at runtime

- **Add any ticker:** start typing a symbol or company name in the box at the top
  of the Stocks panel — a live **suggestions dropdown** (powered by Yahoo
  Finance's search, no key) appears and updates on each keystroke. Click a
  suggestion or press **Add**. The app validates it against the live market,
  then **auto-sorts** it into one of the 8 priority categories using keyword
  rules in `config.py` (`CATEGORY_KEYWORDS`), matched against the stock's
  sector/industry. Anything that doesn't match lands in the 9th **"Other"**
  category. The quote is fetched immediately so it appears without waiting.
- **Remove any stock:** click the **×** on its row. User-added tickers are
  deleted; built-in priority tickers are *hidden* (and can be re-added later,
  which restores them to their original category).
- Additions/removals persist across restarts (stored in `cache.db`, tables
  `user_tickers` and `hidden_tickers`) and are included in the hourly refresh.
- **Tuning auto-sort:** edit `CATEGORY_KEYWORDS` in [`config.py`](config.py).
  Classification is a heuristic over yfinance metadata; categories are checked in
  order, so #1 wins ties.

### Editing the built-in priority tickers

Open [`config.py`](config.py) and edit the `STOCK_CATEGORIES` dict — it is plain
data, no logic. A ticker may appear in several categories. Restart (or hit
**Refresh now**) to pick up changes.

## Troubleshooting

**A data source fails.** Sources are isolated — one failing never affects the
others. A failure is logged (e.g. `source.stocks  fetch failed: ...`) and the
panel shows "no data" for the affected items while everything else keeps working.
The cache keeps serving the last good snapshot until the next successful refresh.

**Reading the per-module logs.** Logs print to the terminal running uvicorn,
prefixed by module name and level:
- `source.stocks` — the yfinance fetch
- `db` — cache writes / change detection
- `panels`, `sources` — auto-discovery
- `main` — refresh cycles (`=== refresh cycle starting/done ===`)

`yfinance: Failed to create TzCache ...` is a harmless warning and can be ignored.

**Manually trigger a refresh.** Click **Refresh now** in the header, or:

```bash
curl -X POST http://127.0.0.1:8000/api/refresh
```

This runs every source once and updates the cache immediately.

**Inspect the cache directly.**

```bash
sqlite3 cache.db "SELECT source, count(*) FROM snapshots GROUP BY source;"
sqlite3 cache.db "SELECT key, value FROM meta;"
```

**Start fresh.** Stop the server and delete the cache; it rebuilds on next start:

```bash
rm -f cache.db cache.db-wal cache.db-shm
```

## API endpoints

| Method | Path           | Purpose                                  |
|--------|----------------|------------------------------------------|
| GET    | `/`            | Frontend                                 |
| GET    | `/api/meta`    | Refresh status, panel manifest, sources  |
| GET    | `/api/stocks`  | Cached quotes grouped by category        |
| GET    | `/api/stocks/search?q=` | Typeahead suggestions (symbol/name) |
| POST   | `/api/stocks/add` | Add a ticker (`{"ticker":"AAPL"}`), auto-sorted |
| DELETE | `/api/stocks/{ticker}` | Remove a ticker from the interface |
| GET    | `/api/bills`   | Cached priority bills (Congress.gov → LegiScan) |
| GET    | `/api/movers`  | Bills whose stage changed (snapshot diff) |
| POST   | `/api/refresh` | Trigger an immediate refresh             |

## Security

`.env` (your keys), `cache.db`, `env/`, and `__pycache__/` are all git-ignored.
`.env.example` is the shareable template — keep it tracked, never put real keys
in it.
```
