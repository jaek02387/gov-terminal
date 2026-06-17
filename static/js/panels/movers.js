// Bill movers panel: bills whose stage changed between snapshots. Each row shows
// the transition (old → new) and when it was detected. Reads from the cache only.

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

function fmtWhen(d) {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt) ? esc(d) : dt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function moverRow(m) {
  const title = m.url
    ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>`
    : esc(m.title);
  return (
    `<li class="mover">` +
    `<div class="mover-head">` +
    `<span class="bill-id">${esc(m.identifier)}</span>` +
    `<span class="stage-badge ${stageClass(m.from_stage)}">${esc(m.from_stage)}</span>` +
    `<span class="mover-arrow" aria-label="changed to">→</span>` +
    `<span class="stage-badge ${stageClass(m.to_stage)}">${esc(m.to_stage)}</span>` +
    `<span class="mover-when">${fmtWhen(m.detected_at)}</span>` +
    `</div>` +
    `<div class="bill-title">${title}</div>` +
    `</li>`
  );
}

export async function render(container) {
  const res = await fetch("/api/movers");
  const data = await res.json();

  if (!data.movers || data.movers.length === 0) {
    container.innerHTML =
      `<p class="muted">No status changes yet. Movers appear once a tracked bill ` +
      `advances a stage between hourly refreshes.</p>`;
    return;
  }

  container.innerHTML = `<ul class="mover-list">${data.movers.map(moverRow).join("")}</ul>`;
}
