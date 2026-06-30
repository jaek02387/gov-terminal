// Policy Timeline panel: a vertical, chronological timeline (newest at top) of
// priority bills (Congress.gov) and government contracts (USASpending). Each
// item expands on hover and opens an in-app detail view on click. Cache-only.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt) ? esc(d) : dt.toLocaleDateString(undefined, { dateStyle: "medium" });
}
function fmtMoney(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + Number(n).toLocaleString();
}
function stageClass(stage) {
  return "stage-" + String(stage || "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
}

// Federal-priority label chip (strips the leading "N. " for a clean tag).
function priorityTag(category) {
  if (!category) return `<span class="priority-tag untagged" title="Federal priority">Other</span>`;
  return `<span class="priority-tag" title="Federal priority">${esc(String(category).replace(/^\d+\.\s*/, ""))}</span>`;
}

function billCard(it) {
  const title = it.url
    ? `<a href="${esc(it.url)}" target="_blank" rel="noopener" class="tl-link" data-stop="1">${esc(it.title)}</a>`
    : esc(it.title);
  return `<li class="tl-item tl-bill" data-type="bill" data-key="${esc(it.key)}" data-id="${esc(it.identifier)}">` +
    `<span class="tl-dot"></span>` +
    `<div class="tl-date">${fmtDate(it.date)}</div>` +
    `<div class="tl-card" role="button" tabindex="0" aria-label="Open details for ${esc(it.identifier)}">` +
    `<div class="tl-head"><span class="bill-id">${esc(it.identifier)}</span>` +
    `<span class="stage-badge ${stageClass(it.stage)}">${esc(it.stage)}</span>` +
    (it.chamber ? `<span class="bill-chamber">${esc(it.chamber)}</span>` : "") +
    priorityTag(it.category) +
    `</div>` +
    `<div class="tl-title">${title}</div>` +
    `<div class="tl-meta">${fmtDate(it.date)}</div>` +
    `</div></li>`;
}

function contractCard(it) {
  return `<li class="tl-item tl-contract" data-type="contract" data-key="${esc(it.key)}">` +
    `<span class="tl-dot"></span>` +
    `<div class="tl-date">${fmtDate(it.date)}</div>` +
    `<div class="tl-card" role="button" tabindex="0" aria-label="Open contract description for ${esc(it.recipient)}">` +
    `<div class="tl-head"><span class="contract-tag">CONTRACT</span>` +
    (it.award_type ? `<span class="award-type">${esc(it.award_type)}</span>` : "") +
    priorityTag(it.category) +
    `</div>` +
    `<div class="tl-title">${esc(it.recipient)}</div>` +
    `<div class="tl-meta">Obligations ${fmtMoney(it.obligations)} · Outlays ${fmtMoney(it.outlays)}</div>` +
    `</div></li>`;
}

export async function render(container) {
  const res = await fetch("/api/timeline");
  const data = await res.json();

  if (!data.items || !data.items.length) {
    container.innerHTML = !data.configured
      ? `<div class="notice"><strong>Congress.gov key needed</strong> for bills (contracts via USASpending need no key). Add the key and refresh.</div>`
      : `<p class="muted">No timeline items cached yet — try "Refresh now".</p>`;
    return;
  }

  const meta = `<p class="panel-meta">${data.bills} bills · ${data.contracts} contracts · newest first</p>`;
  const rows = data.items.map((it) => (it.type === "contract" ? contractCard(it) : billCard(it))).join("");
  container.innerHTML = meta + `<div class="timeline"><ul class="tl-list">${rows}</ul></div>`;

  // keep contract objects for click (description etc. already cached on the item)
  const contracts = {};
  data.items.forEach((it) => { if (it.type === "contract") contracts[it.key] = it; });

  container.querySelectorAll(".tl-item").forEach((li) => {
    const card = li.querySelector(".tl-card");
    const openIt = () => {
      if (li.dataset.type === "bill") {
        window.dispatchEvent(new CustomEvent("open-bill-detail", {
          detail: { key: li.dataset.key, identifier: li.dataset.id },
        }));
      } else {
        window.dispatchEvent(new CustomEvent("open-contract-detail", {
          detail: { contract: contracts[li.dataset.key] },
        }));
      }
    };
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-stop]")) return; // title link -> Congress.gov
      openIt();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); }
    });
  });
}
