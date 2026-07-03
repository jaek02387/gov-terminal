// App shell: refresh indicator, text-size controls, and a 2x2 dashboard of
// auto-discovered panels. Each quadrant scrolls independently and has a
// "See more" button that opens the panel full-screen (in-app, no reload).

// Version for cache-busting dynamically-imported modules (bump on JS changes;
// keep in sync with the ?v= on index.html so a normal reload picks up new code).
const ASSET_V = "16";

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
// id of the currently expanded panel (persisted, so a browser reload keeps you
// on the expanded tab instead of dropping back to the 2x2 dashboard).
let expandedId = localStorage.getItem("expandedPanel") || null;

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
    const mod = panelMods[p.id] || (await import(`/static/js/panels/${p.id}.js?v=${ASSET_V}`));
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
  sec.dataset.panelId = p.id;
  sec.setAttribute("tabindex", "-1");
  // The title bar is the drag handle. Dragging from the body or buttons does
  // nothing, so existing interactions are untouched.
  sec.innerHTML =
    `<h2 id="panel-${p.id}" class="panel-title">${p.title}</h2>` +
    `<div class="panel-body" id="body-${p.id}">Loading…</div>` +
    `<div class="panel-foot">` +
    `<button class="see-more" type="button" data-id="${p.id}" ` +
    `aria-label="Expand ${p.title}">See more</button></div>`;
  sec.querySelector(".see-more").addEventListener("click", () => openExpanded(p.id));
  wirePanelDrag(sec, p.id);
  return sec;
}

// --- drag-to-swap quadrants ----------------------------------------------
function swapNodes(a, b) {
  if (a === b) return;
  const marker = document.createComment("");
  a.parentNode.insertBefore(marker, a);
  b.parentNode.insertBefore(a, b);
  marker.parentNode.insertBefore(b, marker);
  marker.remove();
}

function savePanelOrder() {
  const ids = [...dashboard.querySelectorAll(".panel.quad[data-panel-id]")].map(
    (el) => el.dataset.panelId
  );
  try { localStorage.setItem("panelOrder", JSON.stringify(ids)); } catch (_) {}
}

function swapPanels(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const a = document.getElementById(`quad-${fromId}`);
  const b = document.getElementById(`quad-${toId}`);
  if (a && b) {
    swapNodes(a, b); // a DOM reposition swaps the grid cells; content/state intact
    savePanelOrder();
  }
}

// Custom pointer drag: a fully-opaque clone of the whole panel follows the
// cursor (native HTML5 drag images are forced semi-transparent by the browser).
function wirePanelDrag(sec, id) {
  const handle = sec.querySelector(".panel-title");
  handle.addEventListener("mousedown", (e) => beginPanelDrag(e, sec, id));
}

function beginPanelDrag(e, sec, id) {
  if (e.button !== 0) return; // left button only
  e.preventDefault();         // no text selection / focus jump
  const rect = sec.getBoundingClientRect();
  const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
  const startX = e.clientX, startY = e.clientY;
  let ghost = null, target = null, started = false;

  function move(ev) {
    if (!started) {
      // small threshold so a plain click on the title bar doesn't "lift" it
      if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
      started = true;
      ghost = sec.cloneNode(true);
      ghost.removeAttribute("id"); // avoid duplicate ids while the clone exists
      ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
      ghost.classList.add("drag-ghost");
      ghost.style.width = rect.width + "px";
      ghost.style.height = rect.height + "px";
      document.body.appendChild(ghost);
      sec.classList.add("dragging");            // fade the original in place
      document.body.classList.add("dragging-panel");
    }
    ghost.style.left = ev.clientX - offX + "px";
    ghost.style.top = ev.clientY - offY + "px";
    // highlight the panel under the cursor (ghost is pointer-events:none)
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const t = under && under.closest(".panel.quad");
    if (target && target !== t) target.classList.remove("drag-over");
    if (t && t !== sec && t.dataset.panelId) { t.classList.add("drag-over"); target = t; }
    else target = null;
  }

  function up() {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    if (!started) return;
    if (ghost) ghost.remove();
    sec.classList.remove("dragging");
    document.body.classList.remove("dragging-panel");
    if (target) {
      target.classList.remove("drag-over");
      swapPanels(id, target.dataset.panelId);
    }
  }

  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

// Honour the user's saved quadrant order; new panels append, removed ones drop.
function applySavedOrder(panels) {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("panelOrder") || "[]"); } catch (_) {}
  const byId = new Map(panels.map((p) => [p.id, p]));
  const ordered = [];
  for (const pid of saved) if (byId.has(pid)) { ordered.push(byId.get(pid)); byId.delete(pid); }
  for (const p of panels) if (byId.has(p.id)) ordered.push(p);
  return ordered;
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
  panelMeta = applySavedOrder(meta.panels || []);
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

  // Render panels concurrently (each reads its own cached endpoint) so the
  // dashboard/refresh re-render isn't gated panel-by-panel.
  await Promise.all(
    panelMeta.map((p) => renderPanelInto(p, document.getElementById(`body-${p.id}`)))
  );
}

// --- expanded (full-screen) view -----------------------------------------
async function openExpanded(id) {
  const p = panelMeta.find((x) => x.id === id);
  if (!p) {
    // saved panel no longer exists -> clear and show the dashboard
    expandedId = null;
    localStorage.removeItem("expandedPanel");
    dashboard.hidden = false;
    return;
  }
  expandedId = id;
  localStorage.setItem("expandedPanel", id);
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
  localStorage.removeItem("expandedPanel");
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
    renderBillDetail(data);
  } catch (e) {
    detailBody.innerHTML = `<div class="error-box">Network error loading bill detail.</div>`;
  }
}

function fmtMoney(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + Number(n).toLocaleString();
}

function closeBillDetail() {
  billDetail.hidden = true;
  detailBody.innerHTML = "";
}

function section(title, inner) {
  return `<section class="detail-section"><h3>${esc(title)}</h3>${inner}</section>`;
}

function renderBillDetail(resp) {
  const d = resp.detail || {};
  const member = (m) =>
    `${esc(m.name)}${m.party || m.state ? ` <span class="muted">(${esc(m.party)}-${esc(m.state)})</span>` : ""}`;

  let html = "";
  if (resp.stale) html += `<p class="muted">Showing a cached copy (Congress.gov is unreachable right now).</p>`;

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

  // Related stocks for the federal priority this bill belongs to
  if (resp.related_category && resp.related_stocks && resp.related_stocks.length) {
    const rows = resp.related_stocks.map((q) => {
      if (q.status !== "ok" || q.price == null)
        return `<li class="rel-stock"><span class="sym">${esc(q.ticker)}</span><span class="muted">no data</span></li>`;
      const up = q.change > 0, down = q.change < 0;
      const cls = up ? "chg-up" : down ? "chg-down" : "chg-flat";
      const arrow = up ? "▲" : down ? "▼" : "▬";
      const sign = up ? "+" : "";
      return `<li class="rel-stock"><span class="sym">${esc(q.ticker)}</span>` +
        `<span>$${q.price.toFixed(2)}</span>` +
        `<span class="${cls}"><span aria-hidden="true">${arrow}</span> ${sign}${q.change_pct.toFixed(2)}%</span></li>`;
    }).join("");
    html += section(`Related stocks — ${esc(resp.related_category)}`,
      `<ul class="rel-stocks">${rows}</ul>`);
  }

  detailBody.innerHTML = html;
}

// Contract detail (from the Policy Timeline) — shows the Award Description.
// The contract object is passed in the event (already cached on the timeline),
// so no extra fetch is needed.
window.addEventListener("open-contract-detail", (e) => {
  const c = e.detail.contract || {};
  detailTitle.textContent = c.recipient || "Contract";
  billDetail.hidden = false;
  document.getElementById("detail-back").focus();
  const meta = [
    c.award_type && `Type: ${esc(c.award_type)}`,
    c.agency && `Agency: ${esc(c.agency)}`,
    c.date && `Updated: ${esc(c.date)}`,
  ].filter(Boolean).join(" · ");
  let html = `<div class="detail-overview"><div class="detail-billtitle">${esc(c.recipient || "Contract")}</div>` +
    (meta ? `<div class="muted">${meta}</div>` : "") +
    (c.url ? `<div><a href="${esc(c.url)}" target="_blank" rel="noopener">View on USASpending ↗</a></div>` : "") +
    `</div>` +
    `<div class="stats-grid">` +
    `<div class="stat"><span class="stat-k">Obligations</span><span class="stat-v">${fmtMoney(c.obligations)}</span></div>` +
    `<div class="stat"><span class="stat-k">Outlays</span><span class="stat-v">${fmtMoney(c.outlays)}</span></div>` +
    `</div>` +
    section("Award description", `<p class="detail-summary">${esc(c.description || "No description provided.")}</p>`);
  detailBody.innerHTML = html;
});

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
    stockDetailMod = stockDetailMod || (await import(`/static/js/stock-detail.js?v=${ASSET_V}`));
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
  // If restoring an expanded panel (e.g. after a browser reload), keep the grid
  // hidden during build so it doesn't flash before the expanded view appears.
  if (expandedId) dashboard.hidden = true;
  await loadDashboard(meta);
  // Preserve / restore the expanded view across a refresh or reload.
  if (expandedId) await openExpanded(expandedId);
}

boot();
setInterval(loadMeta, 60000); // keep the indicator fresh
