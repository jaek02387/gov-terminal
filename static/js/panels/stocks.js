// Stocks panel: quotes grouped by federal-priority category, plus a typeahead
// combobox to add ANY ticker (auto-sorted) and a remove button on every row.
// Direction is shown three ways (colourblind-safe): colour + sign + arrow glyph.

let root; // panel body container, kept so mutations can re-render.

// --- typeahead state ---
let suggestTimer = null;
let suggestController = null;
let suggestions = [];
let activeIdx = -1;
let docClickWired = false;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function changeCell(q) {
  if (q.status !== "ok" || q.change === null || q.change === undefined) {
    return `<td class="muted" colspan="2">—</td>`;
  }
  const up = q.change > 0;
  const down = q.change < 0;
  const cls = up ? "chg-up" : down ? "chg-down" : "chg-flat";
  const arrow = up ? "▲" : down ? "▼" : "▬";
  const sign = up ? "+" : ""; // negative numbers already carry "-"
  const label = up ? "up" : down ? "down" : "unchanged";
  return (
    `<td class="${cls}"><span class="arrow" aria-hidden="true">${arrow}</span> ` +
    `<span class="sr-only">${label} </span>${sign}${q.change.toFixed(2)}</td>` +
    `<td class="${cls}">${sign}${q.change_pct.toFixed(2)}%</td>`
  );
}

function tickerCell(q) {
  const nameLine = q.name
    ? `<span class="company">${esc(q.name)}</span>`
    : "";
  return `<td class="ticker"><button class="stock-link sym" type="button" ` +
    `data-ticker="${esc(q.ticker)}" data-name="${esc(q.name || "")}" ` +
    `aria-label="Show chart and news for ${esc(q.ticker)}">${esc(q.ticker)}</button>${nameLine}</td>`;
}

function row(q) {
  const removeBtn =
    `<td class="remove-cell"><button class="remove-btn" data-ticker="${esc(q.ticker)}" ` +
    `type="button" aria-label="Remove ${esc(q.ticker)}" title="Remove ${esc(q.ticker)}">×</button></td>`;

  if (q.status === "missing" || q.status === "no_data") {
    return `<tr>${tickerCell(q)}` +
      `<td class="muted" colspan="3">no data</td>${removeBtn}</tr>`;
  }
  const price = q.price !== null ? `$${q.price.toFixed(2)}` : "—";
  return `<tr>${tickerCell(q)}<td>${price}</td>${changeCell(q)}${removeBtn}</tr>`;
}

function addForm() {
  return (
    `<form class="add-form" id="stock-add-form" role="search">` +
    `<div class="combobox">` +
    `<label for="stock-add-input" class="sr-only">Add a stock ticker</label>` +
    `<input id="stock-add-input" name="ticker" type="text" autocomplete="off" ` +
    `role="combobox" aria-autocomplete="list" aria-expanded="false" ` +
    `aria-controls="stock-suggest" placeholder="Search a ticker or company (e.g. AAPL)" maxlength="16" />` +
    `<ul id="stock-suggest" class="suggest-list" role="listbox" aria-label="Suggestions" hidden></ul>` +
    `</div>` +
    `<button type="submit">Add</button>` +
    `<span id="stock-add-status" class="add-status" role="status" aria-live="polite"></span>` +
    `</form>`
  );
}

async function loadAndRender(keepFocus) {
  const res = await fetch("/api/stocks");
  const data = await res.json();

  let html = addForm();
  const hasAny = (data.categories || []).some((c) => c.tickers.length > 0);
  if (!hasAny) {
    html += `<p class="muted">No stock data cached yet. The first fetch runs ` +
      `automatically on startup — try "Refresh now" or add a ticker above.</p>`;
  }

  for (const cat of data.categories || []) {
    html += `<div class="category"><h3>${esc(cat.category)}</h3>`;
    if (cat.tickers.length === 0) {
      html += `<p class="muted">none</p></div>`;
      continue;
    }
    html +=
      `<table class="quotes"><thead><tr>` +
      `<th class="ticker" scope="col">Ticker</th>` +
      `<th scope="col">Price</th>` +
      `<th scope="col">Change</th>` +
      `<th scope="col">%</th>` +
      `<th scope="col"><span class="sr-only">Remove</span></th></tr></thead><tbody>`;
    for (const q of cat.tickers) html += row(q);
    html += `</tbody></table></div>`;
  }

  root.innerHTML = html;
  suggestions = [];
  activeIdx = -1;
  wireEvents();
  if (keepFocus) getInput().focus();
}

// --- helpers ---
const getInput = () => document.getElementById("stock-add-input");
const getList = () => document.getElementById("stock-suggest");

function setStatus(msg, isError) {
  const el = document.getElementById("stock-add-status");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", !!isError);
}

// --- typeahead ---
function closeSuggest() {
  const list = getList();
  if (list) {
    list.hidden = true;
    list.innerHTML = "";
  }
  const input = getInput();
  if (input) {
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  activeIdx = -1;
}

function renderSuggest() {
  const list = getList();
  const input = getInput();
  if (!list || !input) return;

  if (!suggestions.length) {
    closeSuggest();
    return;
  }
  list.innerHTML = suggestions
    .map(
      (s, i) =>
        `<li id="opt-${i}" role="option" class="suggest-item" aria-selected="false" data-symbol="${esc(s.symbol)}">` +
        `<span class="opt-add" aria-hidden="true">+</span>` +
        `<span class="opt-main"><span class="opt-sym">${esc(s.symbol)}</span>` +
        `<span class="opt-ex">${esc(s.exchange)}</span></span>` +
        `<span class="opt-name">${esc(s.name)}</span></li>`
    )
    .join("");
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  activeIdx = -1;

  list.querySelectorAll(".suggest-item").forEach((li, i) => {
    li.addEventListener("mousedown", (e) => {
      // mousedown (not click) so it fires before the input blur closes the list
      e.preventDefault();
      addTicker(li.dataset.symbol);
    });
    li.addEventListener("mousemove", () => setActive(i));
  });
}

function setActive(i) {
  const list = getList();
  const input = getInput();
  if (!list) return;
  const items = list.querySelectorAll(".suggest-item");
  if (!items.length) return;
  activeIdx = (i + items.length) % items.length;
  items.forEach((li, idx) => {
    const on = idx === activeIdx;
    li.classList.toggle("active", on);
    li.setAttribute("aria-selected", on ? "true" : "false");
    if (on) {
      input.setAttribute("aria-activedescendant", li.id);
      li.scrollIntoView({ block: "nearest" });
    }
  });
}

function onSearchInput() {
  const input = getInput();
  const q = input.value.trim();
  clearTimeout(suggestTimer);
  if (!q) {
    closeSuggest();
    return;
  }
  suggestTimer = setTimeout(() => runSearch(q), 180);
}

async function runSearch(q) {
  if (suggestController) suggestController.abort();
  suggestController = new AbortController();
  try {
    const res = await fetch("/api/stocks/search?q=" + encodeURIComponent(q), {
      signal: suggestController.signal,
    });
    const data = await res.json();
    suggestions = data.results || [];
    renderSuggest();
  } catch (e) {
    if (e.name !== "AbortError") closeSuggest();
  }
}

function onInputKeydown(e) {
  const list = getList();
  const open = list && !list.hidden;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      if (open) setActive(activeIdx + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      if (open) setActive(activeIdx - 1);
      break;
    case "Enter":
      if (open && activeIdx >= 0) {
        e.preventDefault();
        addTicker(suggestions[activeIdx].symbol);
      }
      break;
    case "Escape":
      closeSuggest();
      break;
  }
}

// --- mutations ---
async function addTicker(ticker) {
  closeSuggest();
  setStatus("Adding…", false);
  try {
    const res = await fetch("/api/stocks/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.detail || "Could not add ticker.", true);
      return;
    }
    const verb =
      data.status === "exists" ? "already tracked in"
      : data.status === "restored" ? "restored to"
      : "added to";
    await loadAndRender(true);
    setStatus(`${data.ticker} ${verb} “${data.category}”.`, false);
  } catch (e) {
    setStatus("Network error adding ticker.", true);
  }
}

async function removeTicker(ticker) {
  try {
    await fetch(`/api/stocks/${encodeURIComponent(ticker)}`, { method: "DELETE" });
    await loadAndRender();
    setStatus(`${ticker} removed.`, false);
  } catch (e) {
    setStatus("Network error removing ticker.", true);
  }
}

function wireEvents() {
  const form = document.getElementById("stock-add-form");
  const input = getInput();
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = (input.value || "").trim().toUpperCase();
      if (t) addTicker(t);
    });
  }
  if (input) {
    input.addEventListener("input", onSearchInput);
    input.addEventListener("keydown", onInputKeydown);
  }
  root.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => removeTicker(btn.dataset.ticker));
  });
  root.querySelectorAll(".stock-link").forEach((btn) => {
    btn.addEventListener("click", () =>
      window.dispatchEvent(new CustomEvent("open-stock-detail", {
        detail: { ticker: btn.dataset.ticker, name: btn.dataset.name },
      }))
    );
  });

  // Close the dropdown when clicking outside the combobox (wire once).
  if (!docClickWired) {
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".combobox")) closeSuggest();
    });
    docClickWired = true;
  }
}

export async function render(container) {
  root = container;
  await loadAndRender();
}
