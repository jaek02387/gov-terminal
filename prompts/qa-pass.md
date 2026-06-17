# QA Pass — Full Edge-Case & Regression Test

A reusable prompt for running a complete quality-assurance pass after a build
phase. Fill in **"Scope this run"** with whatever was just built, then run it.

---

**Goal:** Run a complete QA and bug-hunt on the features just built, AND confirm
they don't regress existing functionality. Hunt for edge-case bugs and **fix
every one you find** (root-cause fix, then re-test). Don't move to the next phase
until all found bugs are fixed.

**Scope this run:** _Phase 2 — Congress.gov bills feed, Bill Movers (snapshot
diff), LegiScan dormant fallback — and the new 2×2 dashboard UI (quadrant layout,
independent per-panel scroll, "See more" full-screen expand/collapse, reserved
Watchlist placeholder, responsive stacking)._

**Method**
1. Re-read every in-scope file end-to-end before testing (sources, panels, `db`,
   `catalog`, `bills`, `main`, and the frontend HTML/CSS/JS). Look for logic bugs,
   not just surface issues.
2. Exercise the running app over HTTP (curl). Where the browser can't be driven
   (the preview sandbox can't read the venv), validate logic with synthetic data
   injected into SQLite. State clearly what was browser-verifiable vs. logic-only.
3. For each bug: identify root cause → fix → re-test → confirm no new breakage.
4. Leave the app and `cache.db` in a clean default state (remove all synthetic /
   test data and any tickers/bills added during testing).

**Backend / data edge cases**
- Missing / invalid / expired API key → graceful degradation, "key needed" hint,
  app still runs; other sources unaffected (failure isolation).
- API failure / timeout / non-200 / malformed JSON → source fails in isolation;
  last good snapshot still served from cache.
- Empty result sets; records with missing/odd fields (no title, no latest action,
  unusual bill types, non-ASCII).
- Stage derivation on varied / empty / ambiguous action text.
- Movers: first load shows none (all "new"); only real stage transitions appear;
  reverse and duplicate changes; `changes` table growth over time.
- Source selection / fallback (Congress.gov → LegiScan); dormant source never errors.
- Snapshot diff correctness, change-field scoping, dedupe, and any filtering
  (current congress, substantive bill types, keyword matching).

**UI / integration edge cases**
- Every quadrant renders with data; the reserved slot shows the placeholder;
  panels auto-place by discovery order with no rewiring.
- Each quadrant scrolls independently; the page itself doesn't scroll (desktop);
  overflow content is reachable.
- "See more" expands each panel full-screen and returns cleanly (button + Esc);
  focus management; only one expanded at a time.
- State integrity across expand/collapse and refresh: interactive panels (e.g.
  stocks add/remove/typeahead) still work after expanding, collapsing, and after
  a refresh (module re-bind to live DOM).
- Refresh-now while a panel is expanded; indicator + text-size controls still work.
- Empty / placeholder states render without breaking layout.
- Responsive: narrow viewport stacks to one column and the page scrolls; no
  zero-height collapse (Safari %-height-in-flex pitfall).
- Cross-browser sanity for flex/grid sizing (Safari + Chromium).

**Regression — confirm new work didn't break existing features**
- Stocks: add (typeahead + manual), remove, auto-sort, "Other", company names,
  input validation, concurrency.
- Scheduler + hourly refresh + initial-fetch-on-empty-cache.
- SQLite cache: connection handling/closing, write isolation, change detection.
- Accessibility: keyboard navigation, focus styles, no colour-only signalling,
  resizable text.

**Deliverable:** a concise report — bugs found with root cause + fix for each,
what was verified and how (browser vs. logic), and confirmation the app is in a
clean state.
