// Bills feed panel: recent bills matching the federal-priority topics, newest
// action first. Stage shown as a labelled badge (text + colour, never colour
// alone). A ☆/★ toggles the bill on the Watchlist. Reads from the cache only.

let root;
let wired = false;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function stageClass(stage) {
  return "stage-" + String(stage || "")
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-|-$/g, "");
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
  const star = b.watched ? "★" : "☆";
  const watchLabel = b.watched ? `Unwatch ${esc(b.identifier)}` : `Watch ${esc(b.identifier)}`;
  return (
    `<li class="bill">` +
    `<div class="bill-head">` +
    `<button class="watch-btn${b.watched ? " watching" : ""}" data-key="${esc(b.key)}" ` +
    `data-watched="${b.watched ? 1 : 0}" type="button" aria-label="${watchLabel}" ` +
    `title="${watchLabel}">${star}</button>` +
    `<span class="bill-id">${esc(b.identifier)}</span>` +
    `<span class="stage-badge ${stageClass(b.stage)}">${esc(b.stage)}</span>` +
    (b.chamber ? `<span class="bill-chamber">${esc(b.chamber)}</span>` : "") +
    `</div>` +
    `<div class="bill-title">${title}</div>` +
    `<div class="bill-action">` +
    (b.latest_action_date ? `<span class="bill-date">${fmtDate(b.latest_action_date)}</span> — ` : "") +
    `${esc(b.latest_action_text)}</div>` +
    `</li>`
  );
}

async function loadAndRender() {
  const res = await fetch("/api/bills");
  const data = await res.json();

  if (!data.configured) {
    root.innerHTML =
      `<div class="notice"><strong>Congress.gov API key needed.</strong> ` +
      `Add <code>CONGRESS_API_KEY</code> to your <code>.env</code> file and ` +
      `restart the app to see bills. (See the README.)</div>`;
    wireEvents();
    return;
  }
  if (!data.bills || data.bills.length === 0) {
    root.innerHTML =
      `<p class="muted">No bills cached yet. They load on the next refresh — ` +
      `try "Refresh now".</p>`;
    wireEvents();
    return;
  }

  const meta =
    `<p class="panel-meta">Showing ${data.bills.length} of ${data.total} tracked ` +
    `bills · source: ${esc(data.source)}</p>`;
  root.innerHTML = meta + `<ul class="bill-list">${data.bills.map(billRow).join("")}</ul>`;
  wireEvents();
}

async function toggleWatch(btn) {
  const key = btn.dataset.key;
  const isWatched = btn.dataset.watched === "1";
  btn.disabled = true;
  try {
    if (isWatched) {
      await fetch(`/api/watchlist/${encodeURIComponent(key)}`, { method: "DELETE" });
    } else {
      await fetch("/api/watchlist/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
    }
    await loadAndRender();
    window.dispatchEvent(new CustomEvent("watchlist-changed"));
  } catch (e) {
    btn.disabled = false;
  }
}

function wireEvents() {
  root.querySelectorAll(".watch-btn").forEach((btn) =>
    btn.addEventListener("click", () => toggleWatch(btn))
  );
  // Keep stars in sync when the Watchlist panel changes (wire once).
  if (!wired) {
    window.addEventListener("watchlist-changed", () => { if (root) loadAndRender(); });
    wired = true;
  }
}

export async function render(container) {
  root = container;
  await loadAndRender();
}
