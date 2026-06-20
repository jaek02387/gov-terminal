// App shell: refresh indicator, text-size controls, and a 2x2 dashboard of
// auto-discovered panels. Each quadrant scrolls independently and has a
// "See more" button that opens the panel full-screen (in-app, no reload).

const indicator = document.getElementById("refresh-indicator");
const dashboard = document.getElementById("dashboard");
const expanded = document.getElementById("expanded");
const expandedBody = document.getElementById("expanded-body");
const expandedTitle = document.getElementById("expanded-title");

// Labels for reserved (not-yet-built) quadrants, in fill order. When a real
// panel ships it occupies the slot and the matching placeholder disappears.
const PLANNED_PANELS = ["Watchlist"];

let panelMeta = [];          // [{id, title, order}, ...]
const panelMods = {};        // id -> imported module (cached)
let expandedId = null;       // id of the currently expanded panel, or null

function fmtTime(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function loadMeta() {
  try {
    const res = await fetch("/api/meta");
    const meta = await res.json();
    const r = meta.refresh || {};
    indicator.textContent =
      `Last updated: ${fmtTime(r.last_refresh)}  •  ` +
      `Next: ${fmtTime(r.next_refresh)}  (every ${r.interval_minutes} min)`;
    return meta;
  } catch (e) {
    indicator.textContent = "Could not reach backend";
    return { panels: [] };
  }
}

// --- rendering ------------------------------------------------------------
async function renderPanelInto(p, container) {
  container.innerHTML = "Loading…";
  try {
    const mod = panelMods[p.id] || (await import(`/static/js/panels/${p.id}.js`));
    panelMods[p.id] = mod;
    await mod.render(container);
  } catch (e) {
    container.innerHTML = `<div class="error-box">Panel "${p.id}" failed to load: ${e}</div>`;
    console.error(`panel ${p.id} failed`, e);
  }
}

function makePanelCell(p) {
  const sec = document.createElement("section");
  sec.className = "panel quad";
  sec.id = `quad-${p.id}`;
  sec.setAttribute("tabindex", "-1");
  sec.innerHTML =
    `<h2 id="panel-${p.id}">${p.title}</h2>` +
    `<div class="panel-body" id="body-${p.id}">Loading…</div>` +
    `<div class="panel-foot">` +
    `<button class="see-more" type="button" data-id="${p.id}" ` +
    `aria-label="Expand ${p.title}">See more</button></div>`;
  sec.querySelector(".see-more").addEventListener("click", () => openExpanded(p.id));
  return sec;
}

function makePlaceholderCell(label) {
  const sec = document.createElement("section");
  sec.className = "panel quad quad-placeholder";
  sec.innerHTML =
    `<h2>${label}</h2>` +
    `<div class="panel-body"><p class="muted">Coming soon.</p></div>`;
  return sec;
}

async function loadDashboard(meta) {
  panelMeta = meta.panels || [];
  dashboard.innerHTML = "";

  // Always lay out at least 4 quadrants; pad to an even count so rows fill.
  const cellCount = Math.max(4, Math.ceil(panelMeta.length / 2) * 2);
  for (let i = 0; i < cellCount; i++) {
    const p = panelMeta[i];
    if (p) {
      dashboard.appendChild(makePanelCell(p));
    } else {
      const label = PLANNED_PANELS[i - panelMeta.length] || "Reserved";
      dashboard.appendChild(makePlaceholderCell(label));
    }
  }

  for (const p of panelMeta) {
    await renderPanelInto(p, document.getElementById(`body-${p.id}`));
  }
}

// --- expanded (full-screen) view -----------------------------------------
async function openExpanded(id) {
  const p = panelMeta.find((x) => x.id === id);
  if (!p) return;
  expandedId = id;
  expandedTitle.textContent = p.title;
  // Empty the panel's quadrant copy first. Otherwise it keeps the same element
  // ids (e.g. #stock-add-input, #stock-suggest), and document.getElementById in
  // the panel code would target the hidden quadrant instead of the expanded
  // view -- which breaks the typeahead/search. closeExpanded re-renders it.
  const qbody = document.getElementById(`body-${id}`);
  if (qbody) qbody.innerHTML = "";
  dashboard.hidden = true;
  expanded.hidden = false;
  await renderPanelInto(p, expandedBody);
  document.getElementById("expanded-back").focus();
}

async function closeExpanded() {
  const id = expandedId;
  expandedId = null;
  expanded.hidden = true;
  expandedBody.innerHTML = "";
  dashboard.hidden = false;
  // Re-render the panel into its quadrant so its module rebinds to live DOM.
  if (id) {
    const p = panelMeta.find((x) => x.id === id);
    if (p) await renderPanelInto(p, document.getElementById(`body-${p.id}`));
    const btn = document.querySelector(`.see-more[data-id="${id}"]`);
    if (btn) btn.focus();
  }
}

document.getElementById("expanded-back").addEventListener("click", closeExpanded);

// --- bill detail overlay (lazy, opened from any bill row) ------------------
const billDetail = document.getElementById("bill-detail");
const detailBody = document.getElementById("detail-body");
const detailTitle = document.getElementById("detail-title");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function openBillDetail(key, identifier) {
  detailTitle.textContent = identifier || "Bill detail";
  detailBody.innerHTML = `<p class="muted">Loading bill detail…</p>`;
  billDetail.hidden = false;
  document.getElementById("detail-back").focus();
  try {
    const res = await fetch(`/api/bills/detail/${encodeURIComponent(key)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      detailBody.innerHTML = `<div class="error-box">${esc(data.detail || "Could not load bill detail.")}</div>`;
      return;
    }
    renderBillDetail(data.detail, data.stale);
  } catch (e) {
    detailBody.innerHTML = `<div class="error-box">Network error loading bill detail.</div>`;
  }
}

function closeBillDetail() {
  billDetail.hidden = true;
  detailBody.innerHTML = "";
}

function section(title, inner) {
  return `<section class="detail-section"><h3>${esc(title)}</h3>${inner}</section>`;
}

function renderBillDetail(d, stale) {
  const member = (m) =>
    `${esc(m.name)}${m.party || m.state ? ` <span class="muted">(${esc(m.party)}-${esc(m.state)})</span>` : ""}`;

  let html = "";
  if (stale) html += `<p class="muted">Showing a cached copy (Congress.gov is unreachable right now).</p>`;

  // Overview
  const meta = [
    d.policy_area && `Policy area: ${esc(d.policy_area)}`,
    d.origin_chamber && `Origin: ${esc(d.origin_chamber)}`,
    d.introduced_date && `Introduced: ${esc(d.introduced_date)}`,
  ].filter(Boolean).join(" · ");
  html += `<div class="detail-overview"><div class="detail-billtitle">${esc(d.title)}</div>` +
    (meta ? `<div class="muted">${meta}</div>` : "") +
    (d.url ? `<div><a href="${esc(d.url)}" target="_blank" rel="noopener">View on congress.gov ↗</a></div>` : "") +
    `</div>`;

  if (d.latest_action && d.latest_action.text)
    html += section("Latest action",
      `<p>${d.latest_action.date ? `<span class="bill-date">${esc(d.latest_action.date)}</span> — ` : ""}${esc(d.latest_action.text)}</p>`);

  if (d.summary)
    html += section("Summary", `<p class="detail-summary">${esc(d.summary)}</p>`);

  if (d.sponsors && d.sponsors.length)
    html += section("Sponsor" + (d.sponsors.length > 1 ? "s" : ""),
      `<ul class="member-list">${d.sponsors.map((m) => `<li>${member(m)}</li>`).join("")}</ul>`);

  if (d.cosponsor_count)
    html += section(`Cosponsors (${d.cosponsor_count})`,
      d.cosponsors && d.cosponsors.length
        ? `<ul class="member-list">${d.cosponsors.map((m) => `<li>${member(m)}</li>`).join("")}</ul>` +
          (d.cosponsor_count > d.cosponsors.length ? `<p class="muted">…and ${d.cosponsor_count - d.cosponsors.length} more</p>` : "")
        : `<p class="muted">${d.cosponsor_count} cosponsor(s).</p>`);

  // Full text (links to official versions)
  if (d.text_versions && d.text_versions.length) {
    const tv = d.text_versions.map((t) =>
      `<li>${esc(t.type)}${t.date ? ` <span class="muted">(${esc(t.date)})</span>` : ""}: ` +
      t.formats.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.type)} ↗</a>`).join(" · ") +
      `</li>`).join("");
    html += section("Full text", `<ul class="text-list">${tv}</ul>`);
  } else {
    html += section("Full text", `<p class="muted">No text versions published yet.</p>`);
  }

  // Recorded votes
  if (d.votes && d.votes.length)
    html += section("Recorded votes",
      `<ul class="vote-list">${d.votes.map((v) =>
        `<li>${esc(v.chamber)} roll ${esc(v.roll)} <span class="muted">${esc(v.date)}</span>` +
        (v.url ? ` — <a href="${esc(v.url)}" target="_blank" rel="noopener">tally ↗</a>` : "") +
        (v.action ? `<div class="muted">${esc(v.action)}</div>` : "") + `</li>`).join("")}</ul>`);

  // Action / committee history
  if (d.actions && d.actions.length)
    html += section(`Action & committee history (${d.actions.length})`,
      `<ul class="action-list">${d.actions.map((a) =>
        `<li><span class="bill-date">${esc(a.date)}</span> — ${esc(a.text)}</li>`).join("")}</ul>`);

  detailBody.innerHTML = html;
}

document.getElementById("detail-back").addEventListener("click", closeBillDetail);
window.addEventListener("open-bill-detail", (e) =>
  openBillDetail(e.detail.key, e.detail.identifier)
);

// Stock detail reuses the same overlay; its chart/news renderer is lazy-loaded.
let stockDetailMod = null;
window.addEventListener("open-stock-detail", async (e) => {
  detailTitle.textContent = e.detail.name || e.detail.ticker || "Stock";
  detailBody.innerHTML = `<p class="muted">Loading…</p>`;
  billDetail.hidden = false;
  document.getElementById("detail-back").focus();
  try {
    stockDetailMod = stockDetailMod || (await import("/static/js/stock-detail.js"));
    await stockDetailMod.open(detailBody, e.detail.ticker, e.detail.name);
  } catch (err) {
    detailBody.innerHTML = `<div class="error-box">Failed to load stock detail.</div>`;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!billDetail.hidden) closeBillDetail();   // topmost overlay closes first
  else if (expandedId) closeExpanded();
});

// --- refresh + text size --------------------------------------------------
async function refreshNow(btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Refreshing…";
  try {
    await fetch("/api/refresh", { method: "POST" });
    await boot();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

const root = document.documentElement;
function setScale(scale) {
  const s = Math.min(1.8, Math.max(0.8, scale));
  root.style.setProperty("--font-scale", s);
  localStorage.setItem("fontScale", String(s));
}
const saved = parseFloat(localStorage.getItem("fontScale") || "1");
setScale(isNaN(saved) ? 1 : saved);

document.getElementById("text-larger").addEventListener("click", () =>
  setScale(parseFloat(getComputedStyle(root).getPropertyValue("--font-scale")) + 0.1)
);
document.getElementById("text-smaller").addEventListener("click", () =>
  setScale(parseFloat(getComputedStyle(root).getPropertyValue("--font-scale")) - 0.1)
);
document
  .getElementById("refresh-btn")
  .addEventListener("click", (e) => refreshNow(e.currentTarget));

async function boot() {
  const meta = await loadMeta();
  await loadDashboard(meta);
  // Preserve the expanded view across a refresh.
  if (expandedId) await openExpanded(expandedId);
}

boot();
setInterval(loadMeta, 60000); // keep the indicator fresh
