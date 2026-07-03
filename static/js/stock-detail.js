// Stock detail view: hand-drawn SVG price chart (dependency-light) with a hover
// crosshair, a range switcher whose % change reflects the selected timeframe,
// a stats grid, and news. Reads the lazy /api/stocks endpoints.

let host = null; // overlay body element
let ticker = null;
let curRange = "1M";
// chart geometry + current series (kept so the hover handler can map cursor->point)
const CW = 720, CH = 240, PADL = 6, PADR = 54, PADT = 14, PADB = 16;
let chartPoints = [];
let chartMin = 0, chartMax = 1;
let chartEvents = [];  // policy/contract events to mark on the chart
let fullPoints = [];   // all points for the current range (zoom slices this)
let zoomLo = 0, zoomHi = 0;  // visible index window into fullPoints
const MIN_ZOOM = 4;    // don't zoom below ~5 points
const ZOOM_SENSITIVITY = 0.0025;  // lower = slower/gentler trackpad zoom
let activePopover = null;
let _popDocHandler = null;  // outside-click listener while a popover is open
let _popKeyHandler = null;  // Escape-closes-popover listener (capture phase)
let _zoomRaf = 0;           // coalesces rapid wheel events into one redraw
// click-drag panning of the zoomed window (grab-and-drag along the time axis)
let panDown = false, panActive = false, suppressClick = false;
let panStartX = 0, panStartLo = 0, panWinLen = 0, panPlotPx = 1, _panRaf = 0;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
const money = (n) => (n == null ? "—" : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const num = (n) => (n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
function big(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt) ? "" : dt.toLocaleDateString(undefined, { dateStyle: "medium" });
}
// Hover label: include the time on intraday ranges, just the date otherwise.
function fmtPointLabel(t) {
  const d = new Date(t);
  if (isNaN(d)) return esc(t);
  if (curRange === "1D" || curRange === "1W")
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const _xOf = (i, n) => PADL + (i / (n - 1)) * (CW - PADL - PADR);
const _yOf = (v) => PADT + (1 - (v - chartMin) / (chartMax - chartMin || 1)) * (CH - PADT - PADB);

// % change over the displayed timeframe (first -> last point), so it updates per range.
function changeHtml(points) {
  if (!points || points.length < 2) return "";
  const start = points[0].close, end = points[points.length - 1].close;
  const change = end - start;
  const pct = start ? (change / start) * 100 : 0;
  const up = change > 0, down = change < 0;
  const cls = up ? "chg-up" : down ? "chg-down" : "chg-flat";
  const arrow = up ? "▲" : down ? "▼" : "▬";
  const sign = up ? "+" : "";
  return `<span class="${cls}"><span aria-hidden="true">${arrow}</span> ${sign}${num(change)} ` +
    `(${sign}${num(pct)}%)</span> <span class="range-tag">${esc(curRange)}</span>`;
}

// Events within the visible time window, each mapped to the nearest point's x.
function visibleEvents(points) {
  if (!points || points.length < 2 || !chartEvents.length) return [];
  const times = points.map((p) => new Date(p.t).getTime());
  const t0 = times[0], t1 = times[times.length - 1];
  const out = [];
  chartEvents.forEach((ev, idx) => {
    const et = new Date(ev.date).getTime();
    if (isNaN(et) || et < t0 || et > t1) return;
    let best = Infinity, nearest = 0;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i] - et);
      if (d < best) { best = d; nearest = i; }
    }
    out.push({ ev, idx, x: _xOf(nearest, points.length) });
  });
  return out;
}

function drawChart(points) {
  if (!points || points.length < 2) return `<p class="muted">No chart data for this range.</p>`;
  const closes = points.map((p) => p.close);
  chartMin = Math.min(...closes);
  chartMax = Math.max(...closes);
  const up = closes[closes.length - 1] >= closes[0];
  const iH = CH - PADT - PADB;
  const n = points.length;

  let line = "";
  points.forEach((p, i) => { line += `${i ? "L" : "M"}${_xOf(i, n).toFixed(1)} ${_yOf(p.close).toFixed(1)} `; });
  const area = `M${_xOf(0, n).toFixed(1)} ${(PADT + iH).toFixed(1)} ` +
    points.map((p, i) => `L${_xOf(i, n).toFixed(1)} ${_yOf(p.close).toFixed(1)}`).join(" ") +
    ` L${_xOf(n - 1, n).toFixed(1)} ${(PADT + iH).toFixed(1)} Z`;

  return `<svg class="price-chart ${up ? "chart-up" : "chart-down"}" viewBox="0 0 ${CW} ${CH}" ` +
    `role="img" aria-label="Price chart over ${esc(curRange)}; hover for values">` +
    `<path class="chart-fill" d="${area}"/>` +
    `<path class="chart-line" d="${line}"/>` +
    `<text class="chart-label" x="${CW - PADR + 6}" y="${(_yOf(chartMax) + 4).toFixed(1)}">${chartMax.toFixed(2)}</text>` +
    `<text class="chart-label" x="${CW - PADR + 6}" y="${(_yOf(chartMin) + 4).toFixed(1)}">${chartMin.toFixed(2)}</text>` +
    // hover crosshair (hidden until mousemove)
    `<g class="chart-cross" opacity="0">` +
    `<line class="cross-line" x1="0" y1="${PADT}" x2="0" y2="${CH - PADB}"/>` +
    `<circle class="cross-dot" cx="0" cy="0" r="4"/>` +
    `<text class="cross-value" x="0" y="11" text-anchor="middle"></text>` +
    `<text class="cross-date" x="0" y="${CH - 3}" text-anchor="middle"></text>` +
    `</g>` +
    // transparent hit area so mousemove fires across the whole chart
    `<rect class="cross-hit" x="0" y="0" width="${CW}" height="${CH}" fill="transparent" pointer-events="all"/>` +
    // event markers on top: each is a group (dashed line + fat transparent hit
    // circle + visible dot) so hover-highlight and click work as one unit.
    visibleEvents(points).map((m) => {
      const cls = m.ev.type === "contract" ? "ev-contract" : "ev-bill";
      const kind = m.ev.type === "contract" ? "Contract" : "Bill";
      const label = m.ev.type === "contract" ? m.ev.recipient : m.ev.identifier;
      const x = m.x.toFixed(1);
      return `<g class="ev-marker ${cls}" data-idx="${m.idx}" tabindex="0" role="button" ` +
        `aria-label="${esc(kind)}: ${esc(label)}. Activate for details.">` +
        `<line class="ev-line ${cls}" x1="${x}" y1="${PADT}" x2="${x}" y2="${CH - PADB}"/>` +
        `<circle class="ev-hit" cx="${x}" cy="${PADT}" r="10" fill="transparent" pointer-events="all"/>` +
        `<circle class="ev-dot ${cls}" cx="${x}" cy="${PADT}" r="4">` +
        `<title>${esc(kind)}: ${esc(label)} (${esc(m.ev.date)})</title></circle></g>`;
    }).join("") +
    `</svg>`;
}

function wireChartHover(svg) {
  if (!svg || !chartPoints || chartPoints.length < 2) return;
  const n = chartPoints.length;
  const cross = svg.querySelector(".chart-cross");
  const line = svg.querySelector(".cross-line");
  const dot = svg.querySelector(".cross-dot");
  const valTxt = svg.querySelector(".cross-value");
  const dateTxt = svg.querySelector(".cross-date");

  function onMove(e) {
    if (panActive) return;  // don't draw the crosshair while dragging to pan
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const loc = pt.matrixTransform(ctm.inverse());
    let i = Math.round(((loc.x - PADL) / (CW - PADL - PADR)) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const px = _xOf(i, n), py = _yOf(chartPoints[i].close);
    line.setAttribute("x1", px); line.setAttribute("x2", px);
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    const labelX = Math.max(40, Math.min(CW - 40, px));
    valTxt.setAttribute("x", labelX);
    valTxt.textContent = "$" + chartPoints[i].close.toFixed(2);
    dateTxt.setAttribute("x", labelX);
    dateTxt.textContent = fmtPointLabel(chartPoints[i].t);
    cross.setAttribute("opacity", "1");
  }
  svg.addEventListener("mousemove", onMove);
  svg.addEventListener("mouseleave", () => cross.setAttribute("opacity", "0"));
}

function isZoomed() {
  return zoomLo > 0 || zoomHi < fullPoints.length - 1;
}

// Draw the currently-visible zoom window (a slice of fullPoints) into #chart-area,
// then (re)wire hover, zoom, markers and rebuild the events list to match.
function drawVisible() {
  closePopover();
  const chartEl = host && host.querySelector("#chart-area");
  if (!chartEl) return;
  const pts = fullPoints.slice(zoomLo, zoomHi + 1);
  chartPoints = pts;
  const resetBtn = isZoomed()
    ? `<button type="button" class="zoom-reset" aria-label="Reset zoom to full range">Reset zoom</button>`
    : "";
  chartEl.innerHTML = drawChart(pts) + resetBtn;
  const svg = chartEl.querySelector("svg");
  wireChartHover(svg);
  wireChartZoom(svg);
  wireChartPan(svg);
  wireMarkers(svg);
  chartEl.classList.toggle("pannable", isZoomed());  // grab cursor when there's room to pan
  const rb = chartEl.querySelector(".zoom-reset");
  if (rb) rb.addEventListener("click", resetZoom);
  renderEvents(pts);
}

// Click-drag to pan the zoomed window along the time axis (grab-and-drag: the
// chart follows the cursor). Only active when zoomed in. mousemove/up live on
// window so the drag survives the per-frame SVG redraw.
function wireChartPan(svg) {
  if (!svg) return;
  const chartEl = host && host.querySelector("#chart-area");
  function onPanMove(e) {
    if (!panDown) return;
    const dx = e.clientX - panStartX;
    if (!panActive) {
      if (Math.abs(dx) < 4) return;   // threshold: below this it's a click, not a drag
      panActive = true;
      if (chartEl) chartEl.classList.add("panning");
    }
    // drag right (dx>0) reveals earlier data, so the chart slides right with the cursor
    const indexDelta = Math.round((dx / panPlotPx) * (panWinLen - 1));
    let lo = panStartLo - indexDelta;
    lo = Math.max(0, Math.min(fullPoints.length - panWinLen, lo));
    const hi = lo + panWinLen - 1;
    if (lo === zoomLo && hi === zoomHi) return;
    zoomLo = lo; zoomHi = hi;
    if (!_panRaf) _panRaf = requestAnimationFrame(() => { _panRaf = 0; drawVisible(); });
  }
  function onPanUp() {
    panDown = false;
    window.removeEventListener("mousemove", onPanMove);
    window.removeEventListener("mouseup", onPanUp);
    if (chartEl) chartEl.classList.remove("panning");
    if (panActive) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
    panActive = false;
  }
  svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !isZoomed()) return;   // left-button drags, and only when zoomed
    panDown = true; panActive = false;
    panStartX = e.clientX;
    panStartLo = zoomLo;
    panWinLen = zoomHi - zoomLo + 1;
    const rect = svg.getBoundingClientRect();
    panPlotPx = rect.width * (CW - PADL - PADR) / CW || 1;  // px width of the plotted area
    window.addEventListener("mousemove", onPanMove);
    window.addEventListener("mouseup", onPanUp);
  });
}

// Entry point: load a fresh series, reset the zoom window, draw. The header
// % change reflects the whole range (not the zoom window), matching the tag.
function renderChart(points) {
  fullPoints = points || [];
  zoomLo = 0;
  zoomHi = Math.max(0, fullPoints.length - 1);
  drawVisible();
  const chg = host.querySelector("#stock-change");
  if (chg) chg.innerHTML = changeHtml(fullPoints);
}

function resetZoom() {
  if (!fullPoints.length) return;
  zoomLo = 0;
  zoomHi = fullPoints.length - 1;
  drawVisible();
}

// Trackpad zoom: wheel / pinch over the chart narrows or widens the visible
// index window, anchored at the cursor's x so you zoom toward what you point at.
function wireChartZoom(svg) {
  if (!svg || fullPoints.length < MIN_ZOOM + 2) return;
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();  // take over scroll -> zoom while the cursor is on the chart
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const f = Math.max(0, Math.min(1,
      (pt.matrixTransform(ctm.inverse()).x - PADL) / (CW - PADL - PADR)));
    const curLen = zoomHi - zoomLo + 1;
    const anchor = zoomLo + f * (curLen - 1);       // index under the cursor
    // Zoom proportional to scroll distance so it stays gentle and controllable
    // no matter how fast the trackpad fires: scroll up / pinch out = zoom in.
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);  // normalize line-mode wheels
    const factor = Math.min(1.1, Math.max(0.9, Math.exp(dy * ZOOM_SENSITIVITY)));
    let newLen = Math.round(curLen * factor);
    newLen = Math.max(MIN_ZOOM + 1, Math.min(fullPoints.length, newLen));
    if (newLen === curLen) return;
    let lo = Math.round(anchor - f * (newLen - 1));
    lo = Math.max(0, Math.min(fullPoints.length - newLen, lo));
    const hi = lo + newLen - 1;
    if (lo === zoomLo && hi === zoomHi) return;
    zoomLo = lo; zoomHi = hi;
    if (!_zoomRaf) _zoomRaf = requestAnimationFrame(() => { _zoomRaf = 0; drawVisible(); });
  }, { passive: false });
  svg.addEventListener("dblclick", (e) => { e.preventDefault(); resetZoom(); });
}

// Two-way highlight: light up a chart marker and its matching list row together.
function highlightEvent(idx, on) {
  if (idx == null || !host) return;
  host.querySelectorAll(`.ev-marker[data-idx="${idx}"]`).forEach((g) => {
    g.classList.toggle("ev-active", on);
    g.querySelectorAll(".ev-dot").forEach((d) => d.setAttribute("r", on ? "6" : "4"));
  });
  const li = host.querySelector(`#events-area .ev-item[data-idx="${idx}"]`);
  if (li) {
    li.classList.toggle("ev-active", on);
    // Reveal the row within its OWN scroll box only (never the overlay, which
    // would move the chart out from under the cursor).
    if (on) {
      const list = li.closest(".ev-list");
      if (list) {
        const lr = list.getBoundingClientRect(), ir = li.getBoundingClientRect();
        if (ir.top < lr.top) list.scrollTop -= lr.top - ir.top;
        else if (ir.bottom > lr.bottom) list.scrollTop += ir.bottom - lr.bottom;
      }
    }
  }
}

function wireMarkers(svg) {
  if (!svg) return;
  svg.querySelectorAll(".ev-marker").forEach((g) => {
    const idx = g.dataset.idx;
    const dot = g.querySelector(".ev-dot");
    g.addEventListener("mouseenter", () => highlightEvent(idx, true));
    g.addEventListener("mouseleave", () => highlightEvent(idx, false));
    g.addEventListener("focus", () => highlightEvent(idx, true));
    g.addEventListener("blur", () => highlightEvent(idx, false));
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      if (suppressClick) return;  // this click ended a pan drag, not a real click
      showPopover(idx, dot);
    });
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showPopover(idx, dot); }
    });
  });
}

function closePopover() {
  if (_popDocHandler) {
    document.removeEventListener("mousedown", _popDocHandler);
    _popDocHandler = null;
  }
  if (_popKeyHandler) {
    document.removeEventListener("keydown", _popKeyHandler, true);
    _popKeyHandler = null;
  }
  if (activePopover) { activePopover.remove(); activePopover = null; }
}

function popoverHtml(ev) {
  const close = `<button class="ev-pop-close" type="button" aria-label="Close">×</button>`;
  if (ev.type === "contract") {
    const meta = [ev.award_type, ev.agency, fmtDate(ev.date)].filter(Boolean).map(esc).join(" · ");
    return close +
      `<div class="ev-pop-title">${esc(ev.recipient || "Contract")}</div>` +
      (meta ? `<div class="ev-pop-meta">${meta}</div>` : "") +
      `<div class="ev-pop-money"><span>Obligations <b>${money(ev.obligations)}</b></span>` +
      `<span>Outlays <b>${money(ev.outlays)}</b></span></div>` +
      `<div class="ev-pop-desc">${esc(ev.description || "No description provided.")}</div>` +
      `<div class="ev-pop-actions">` +
      (ev.url ? `<a href="${esc(ev.url)}" target="_blank" rel="noopener">USASpending ↗</a>` : "") +
      `<button class="ev-pop-more" type="button">Full detail →</button></div>`;
  }
  return close +
    `<div class="ev-pop-title">${esc(ev.identifier || "Bill")}</div>` +
    (ev.title ? `<div class="ev-pop-desc">${esc(ev.title)}</div>` : "") +
    (ev.date ? `<div class="ev-pop-meta">${esc(fmtDate(ev.date))}</div>` : "") +
    `<div class="ev-pop-actions"><button class="ev-pop-more" type="button">Open bill detail →</button></div>`;
}

// Lightweight in-chart popover with the contract/bill description, anchored to
// the clicked dot. Keeps the stock view (and its zoom) intact, unlike the full
// overlay — which stays reachable via the "Full detail" action.
function showPopover(idx, dotEl) {
  closePopover();
  const ev = chartEvents[idx];
  const chartEl = host && host.querySelector("#chart-area");
  if (!ev || !chartEl || !dotEl) return;
  const pop = document.createElement("div");
  pop.className = "ev-popover " + (ev.type === "contract" ? "ev-contract" : "ev-bill");
  pop.setAttribute("role", "dialog");
  pop.innerHTML = popoverHtml(ev);
  chartEl.appendChild(pop);
  const areaRect = chartEl.getBoundingClientRect();
  const dotRect = dotEl.getBoundingClientRect();
  const cx = dotRect.left - areaRect.left + dotRect.width / 2;
  let left = cx - pop.offsetWidth / 2;
  left = Math.max(4, Math.min(areaRect.width - pop.offsetWidth - 4, left));
  pop.style.left = left + "px";
  pop.style.top = (dotRect.bottom - areaRect.top + 6) + "px";
  activePopover = pop;
  pop.querySelector(".ev-pop-close").addEventListener("click", closePopover);
  const more = pop.querySelector(".ev-pop-more");
  if (more) more.addEventListener("click", () => { closePopover(); openEvent(ev); });
  _popDocHandler = (e) => { if (activePopover && !activePopover.contains(e.target)) closePopover(); };
  // Capture phase so Escape closes the popover before app.js closes the overlay.
  _popKeyHandler = (e) => { if (e.key === "Escape" && activePopover) { e.stopPropagation(); closePopover(); } };
  setTimeout(() => {
    document.addEventListener("mousedown", _popDocHandler);
    document.addEventListener("keydown", _popKeyHandler, true);
  }, 0);
}

function openEvent(ev) {
  if (!ev) return;
  if (ev.type === "contract") {
    window.dispatchEvent(new CustomEvent("open-contract-detail", { detail: { contract: ev } }));
  } else {
    window.dispatchEvent(new CustomEvent("open-bill-detail", { detail: { key: ev.key, identifier: ev.identifier } }));
  }
}

// Interactive list of the events marked on the chart (in the current range).
function renderEvents(points) {
  const el = host.querySelector("#events-area");
  if (!el) return;
  const evs = visibleEvents(points);
  if (!evs.length) {
    el.innerHTML = `<p class="muted">No bills or contracts in this range for ${esc(ticker)}. ` +
      `Try a longer range (6M / 1Y / 5Y).</p>`;
    return;
  }
  const legend = `<div class="ev-legend"><span class="ev-key ev-bill">● Bill</span>` +
    `<span class="ev-key ev-contract">● Contract</span></div>`;
  const rows = evs.map(({ ev, idx }) => {
    const chip = ev.type === "contract"
      ? `<span class="ev-chip ev-contract">Contract</span>`
      : `<span class="ev-chip ev-bill">Bill</span>`;
    const label = ev.type === "contract"
      ? esc(ev.recipient)
      : `${esc(ev.identifier)} — ${esc(ev.title)}`;
    return `<li class="ev-item" data-idx="${idx}" role="button" tabindex="0" ` +
      `aria-label="Open ${ev.type} detail">${chip}` +
      `<span class="ev-date">${esc(fmtDate(ev.date))}</span>` +
      `<span class="ev-label">${label}</span></li>`;
  }).join("");
  el.innerHTML = legend + `<ul class="ev-list">${rows}</ul>`;
  el.querySelectorAll(".ev-item").forEach((li) => {
    const idx = li.dataset.idx;
    const go = () => openEvent(chartEvents[idx]);
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    li.addEventListener("mouseenter", () => highlightEvent(idx, true));
    li.addEventListener("mouseleave", () => highlightEvent(idx, false));
    li.addEventListener("focus", () => highlightEvent(idx, true));
    li.addEventListener("blur", () => highlightEvent(idx, false));
  });
}

function statsGrid(s) {
  const dy = s.dividend_yield == null ? "—"
    : ((s.dividend_yield < 1 ? s.dividend_yield * 100 : s.dividend_yield).toFixed(2) + "%");
  const rows = [
    ["Open", money(s.open)], ["High", money(s.day_high)], ["Low", money(s.day_low)],
    ["Vol", big(s.volume)], ["Avg Vol", big(s.avg_volume)], ["Mkt Cap", big(s.market_cap)],
    ["52W H", money(s.year_high)], ["52W L", money(s.year_low)], ["P/E", num(s.pe)],
    ["EPS", money(s.eps)], ["Beta", num(s.beta)], ["Yield", dy],
  ];
  return `<div class="stats-grid">${rows.map(([k, v]) =>
    `<div class="stat"><span class="stat-k">${k}</span><span class="stat-v">${v}</span></div>`).join("")}</div>`;
}

function newsList(news) {
  if (!news || !news.items || !news.items.length) return `<p class="muted">No recent news.</p>`;
  return `<p class="panel-meta">News source: ${esc(news.provider)}</p>` +
    `<ul class="news-list">${news.items.map((n) =>
      `<li class="news-item">` +
      (n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener" class="news-title">${esc(n.title)}</a>`
             : `<span class="news-title">${esc(n.title)}</span>`) +
      `<div class="news-meta">${esc(n.publisher)}${n.published ? " · " + esc(fmtDate(n.published)) : ""}</div>` +
      (n.summary ? `<div class="news-summary">${esc(n.summary)}</div>` : "") +
      `</li>`).join("")}</ul>`;
}

function rangeBar(ranges) {
  return `<div class="range-bar" role="group" aria-label="Chart range">${ranges.map((r) =>
    `<button class="range-btn${r === curRange ? " active" : ""}" data-range="${r}" type="button" ` +
    `aria-pressed="${r === curRange}">${r}</button>`).join("")}</div>`;
}

async function changeRange(r) {
  curRange = r;
  host.querySelectorAll(".range-btn").forEach((b) => {
    const on = b.dataset.range === r;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  });
  host.querySelector("#chart-area").innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const res = await fetch(`/api/stocks/history/${encodeURIComponent(ticker)}?range=${encodeURIComponent(r)}`);
    const data = await res.json();
    renderChart(data.points); // redraws chart, rewires hover, updates % change
  } catch (e) {
    host.querySelector("#chart-area").innerHTML = `<p class="muted">Could not load chart.</p>`;
  }
}

export async function open(bodyEl, tkr, name) {
  host = bodyEl;
  ticker = tkr;
  curRange = "1M";
  try {
    const res = await fetch(`/api/stocks/detail/${encodeURIComponent(tkr)}?range=${curRange}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      host.innerHTML = `<div class="error-box">${esc(d.detail || "Could not load stock detail.")}</div>`;
      return;
    }

    chartEvents = d.events || [];  // bills in this priority + contracts to this company

    const price = (d.quote && d.quote.price != null)
      ? d.quote.price
      : (d.history && d.history.length ? d.history[d.history.length - 1].close : null);
    const quoteLine = price != null
      ? `<div class="detail-quote"><span class="detail-price">${money(price)}</span> ` +
        `<span id="stock-change">${changeHtml(d.history)}</span></div>`
      : "";

    host.innerHTML =
      `<div class="detail-overview">` +
      `<div class="detail-billtitle">${esc(d.ticker)} <span class="muted">${esc(d.name || name || "")}</span></div>` +
      quoteLine +
      (d.stats && d.stats.exchange ? `<div class="muted">${esc(d.stats.exchange)}</div>` : "") +
      `</div>` +
      rangeBar(d.ranges || ["1D", "1W", "1M", "6M", "1Y", "5Y"]) +
      `<div id="chart-area" class="chart-area"></div>` +
      `<div class="chart-hint muted">Scroll to zoom · drag to pan · double-click to reset · click a ● for details</div>` +
      `<section class="detail-section"><h3>Policy &amp; contract events on this chart</h3>` +
      `<div id="events-area"></div></section>` +
      `<section class="detail-section"><h3>Key stats</h3>${statsGrid(d.stats || {})}</section>` +
      `<section class="detail-section"><h3>News</h3>${newsList(d.news)}</section>`;

    renderChart(d.history); // draw chart + markers + events list + % change

    host.querySelectorAll(".range-btn").forEach((b) =>
      b.addEventListener("click", () => changeRange(b.dataset.range))
    );
  } catch (e) {
    host.innerHTML = `<div class="error-box">Network error loading stock detail.</div>`;
  }
}
