// Stock detail view: hand-drawn SVG price chart (dependency-light), range
// switcher, stats grid, and news. Reads the lazy /api/stocks/detail endpoint.

let host = null;     // overlay body element
let ticker = null;
let curRange = "1M";

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

function drawChart(points) {
  if (!points || points.length < 2) return `<p class="muted">No chart data for this range.</p>`;
  const W = 720, H = 240, padL = 6, padR = 54, padT = 14, padB = 16;
  const closes = points.map((p) => p.close);
  const min = Math.min(...closes), max = Math.max(...closes), rng = max - min || 1;
  const up = closes[closes.length - 1] >= closes[0];
  const iW = W - padL - padR, iH = H - padT - padB;
  const x = (i) => padL + (i / (points.length - 1)) * iW;
  const y = (v) => padT + (1 - (v - min) / rng) * iH;

  let line = "";
  points.forEach((p, i) => { line += `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.close).toFixed(1)} `; });
  const area = `M${x(0).toFixed(1)} ${(padT + iH).toFixed(1)} ` +
    points.map((p, i) => `L${x(i).toFixed(1)} ${y(p.close).toFixed(1)}`).join(" ") +
    ` L${x(points.length - 1).toFixed(1)} ${(padT + iH).toFixed(1)} Z`;

  return `<svg class="price-chart ${up ? "chart-up" : "chart-down"}" viewBox="0 0 ${W} ${H}" ` +
    `role="img" aria-label="Price chart, ${up ? "up" : "down"} over ${esc(curRange)}">` +
    `<path class="chart-fill" d="${area}"/>` +
    `<path class="chart-line" d="${line}"/>` +
    `<text class="chart-label" x="${W - padR + 6}" y="${(y(max) + 4).toFixed(1)}">${max.toFixed(2)}</text>` +
    `<text class="chart-label" x="${W - padR + 6}" y="${(y(min) + 4).toFixed(1)}">${min.toFixed(2)}</text>` +
    `</svg>`;
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
  const chartEl = host.querySelector("#chart-area");
  chartEl.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const res = await fetch(`/api/stocks/history/${encodeURIComponent(ticker)}?range=${encodeURIComponent(r)}`);
    const data = await res.json();
    chartEl.innerHTML = drawChart(data.points);
  } catch (e) {
    chartEl.innerHTML = `<p class="muted">Could not load chart.</p>`;
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

    const q = d.quote || {};
    const up = (q.change || 0) > 0, down = (q.change || 0) < 0;
    const cls = up ? "chg-up" : down ? "chg-down" : "chg-flat";
    const arrow = up ? "▲" : down ? "▼" : "▬";
    const sign = up ? "+" : "";
    const quoteLine = q.price != null
      ? `<div class="detail-quote"><span class="detail-price">${money(q.price)}</span> ` +
        `<span class="${cls}"><span aria-hidden="true">${arrow}</span> ${sign}${num(q.change)} (${sign}${num(q.change_pct)}%)</span></div>`
      : "";

    host.innerHTML =
      `<div class="detail-overview">` +
      `<div class="detail-billtitle">${esc(d.ticker)} <span class="muted">${esc(d.name || name || "")}</span></div>` +
      quoteLine +
      (d.stats && d.stats.exchange ? `<div class="muted">${esc(d.stats.exchange)}</div>` : "") +
      `</div>` +
      rangeBar(d.ranges || ["1D", "1W", "1M", "6M", "1Y", "5Y"]) +
      `<div id="chart-area" class="chart-area">${drawChart(d.history)}</div>` +
      `<section class="detail-section"><h3>Key stats</h3>${statsGrid(d.stats || {})}</section>` +
      `<section class="detail-section"><h3>News</h3>${newsList(d.news)}</section>`;

    host.querySelectorAll(".range-btn").forEach((b) =>
      b.addEventListener("click", () => changeRange(b.dataset.range))
    );
  } catch (e) {
    host.innerHTML = `<div class="error-box">Network error loading stock detail.</div>`;
  }
}
