// App shell: refresh indicator, text-size controls, and generic panel loading.
// Panels are discovered from /api/meta; each panel's JS module lives at
// /static/js/panels/<id>.js and exports `render(container)`.

const panelsEl = document.getElementById("panels");
const indicator = document.getElementById("refresh-indicator");

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

async function loadPanels(meta) {
  panelsEl.innerHTML = "";
  for (const p of meta.panels || []) {
    const section = document.createElement("section");
    section.className = "panel";
    section.setAttribute("tabindex", "-1");
    section.innerHTML =
      `<h2 id="panel-${p.id}">${p.title}</h2>` +
      `<div class="panel-body" id="body-${p.id}">Loading…</div>`;
    panelsEl.appendChild(section);

    const body = section.querySelector(`#body-${p.id}`);
    try {
      const mod = await import(`/static/js/panels/${p.id}.js`);
      await mod.render(body);
    } catch (e) {
      body.innerHTML = `<div class="error-box">Panel "${p.id}" failed to load: ${e}</div>`;
      console.error(`panel ${p.id} failed`, e);
    }
  }
}

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

// --- Text size (resizable text for accessibility) -------------------------
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
  await loadPanels(meta);
}

boot();
// Keep the indicator fresh without re-fetching panels.
setInterval(loadMeta, 60000);
