// Watchlist panel: bills the user explicitly tracks. Add by number, remove,
// and highlight bills whose stage changed. Reads from the cache only.
// Emits a 'watchlist-changed' window event so the Bills feed stars stay in sync.

let root;
let wired = false;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function stageClass(stage) {
  return "stage-" + String(stage || "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
}
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt) ? esc(d) : dt.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function billRow(b) {
  const title = b.url
    ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.title)}</a>`
    : esc(b.title);
  const changed = b.changed
    ? `<span class="changed-badge" title="status changed">⬆ ${esc(b.changed.from)} → ${esc(b.changed.to)}</span>`
    : "";
  return (
    `<li class="bill${b.changed ? " bill-changed" : ""}">` +
    `<div class="bill-head">` +
    `<button class="watch-btn watching" data-key="${esc(b.key)}" type="button" ` +
    `aria-label="Unwatch ${esc(b.identifier)}" title="Remove from watchlist">★</button>` +
    `<span class="bill-id">${esc(b.identifier)}</span>` +
    `<span class="stage-badge ${stageClass(b.stage)}">${esc(b.stage)}</span>` +
    changed +
    `</div>` +
    `<div class="bill-title">${title}</div>` +
    (b.latest_action_date
      ? `<div class="bill-action"><span class="bill-date">${fmtDate(b.latest_action_date)}</span> — ${esc(b.latest_action_text)}</div>`
      : "") +
    `</li>`
  );
}

function addForm() {
  return (
    `<form class="add-form" id="watch-add-form" role="search">` +
    `<label for="watch-add-input" class="sr-only">Add a bill by number</label>` +
    `<input id="watch-add-input" type="text" autocomplete="off" maxlength="20" ` +
    `placeholder="Add a bill by number (e.g. HR 1215)" />` +
    `<button type="submit">Add</button>` +
    `<span id="watch-add-status" class="add-status" role="status" aria-live="polite"></span>` +
    `</form>`
  );
}

async function loadAndRender() {
  const res = await fetch("/api/watchlist");
  const data = await res.json();

  let html = addForm();
  if (!data.configured) {
    html += `<div class="notice"><strong>Congress.gov API key needed</strong> to load bills.</div>`;
  } else if (!data.bills || data.bills.length === 0) {
    html += `<p class="muted">No bills watched yet. Click the ☆ on a bill in the ` +
      `feed, or add one by number above.</p>`;
  } else {
    html += `<ul class="bill-list">${data.bills.map(billRow).join("")}</ul>`;
  }
  root.innerHTML = html;
  wireEvents();
}

function setStatus(msg, isErr) {
  const el = document.getElementById("watch-add-status");
  if (el) { el.textContent = msg; el.classList.toggle("err", !!isErr); }
}

async function addByIdentifier(identifier) {
  setStatus("Adding…", false);
  try {
    const res = await fetch("/api/watchlist/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setStatus(data.detail || "Could not add bill.", true); return; }
    await loadAndRender();
    window.dispatchEvent(new CustomEvent("watchlist-changed"));
    setStatus(data.status === "exists" ? "Already on your watchlist." : `Added ${data.identifier || ""}.`, false);
  } catch (e) { setStatus("Network error.", true); }
}

async function removeKey(key) {
  try {
    await fetch(`/api/watchlist/${encodeURIComponent(key)}`, { method: "DELETE" });
    await loadAndRender();
    window.dispatchEvent(new CustomEvent("watchlist-changed"));
  } catch (e) { setStatus("Network error removing bill.", true); }
}

function wireEvents() {
  const form = document.getElementById("watch-add-form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("watch-add-input");
      const v = (input.value || "").trim();
      if (v) addByIdentifier(v);
      input.value = "";
    });
  }
  root.querySelectorAll(".watch-btn").forEach((btn) =>
    btn.addEventListener("click", () => removeKey(btn.dataset.key))
  );
  // Re-render when the feed stars something (wire once).
  if (!wired) {
    window.addEventListener("watchlist-changed", () => { if (root) loadAndRender(); });
    wired = true;
  }
}

export async function render(container) {
  root = container;
  await loadAndRender();
}
