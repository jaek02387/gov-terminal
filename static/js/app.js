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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && expandedId) closeExpanded();
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
