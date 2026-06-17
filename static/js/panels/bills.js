// Bills feed panel: recent bills matching the federal-priority topics, newest
// action first. Stage is shown as a labelled badge (text + colour, never colour
// alone). Reads from the cache only.

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
  return (
    `<li class="bill">` +
    `<div class="bill-head">` +
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

export async function render(container) {
  const res = await fetch("/api/bills");
  const data = await res.json();

  if (!data.configured) {
    container.innerHTML =
      `<div class="notice"><strong>Congress.gov API key needed.</strong> ` +
      `Add <code>CONGRESS_API_KEY</code> to your <code>.env</code> file and ` +
      `restart the app to see bills. (See the README.)</div>`;
    return;
  }

  if (!data.bills || data.bills.length === 0) {
    container.innerHTML =
      `<p class="muted">No bills cached yet. They load on the next refresh — ` +
      `try "Refresh now".</p>`;
    return;
  }

  const meta =
    `<p class="panel-meta">Showing ${data.bills.length} of ${data.total} tracked ` +
    `bills · source: ${esc(data.source)}</p>`;
  container.innerHTML = meta + `<ul class="bill-list">${data.bills.map(billRow).join("")}</ul>`;
}
