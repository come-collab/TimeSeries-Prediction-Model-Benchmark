"use strict";
/* Forecastalytics — static front-end. Reads data.json (built by build_site.py); no framework, no build step.
   All text from data goes through textContent (never innerHTML). */

const NS = "http://www.w3.org/2000/svg";
const ORG_COLOR = { "Mistral AI": "var(--c-mistral)", "H2O.ai": "var(--c-h2o)", Baseline: "var(--c-baseline)" };
const LOCAL_METRICS = {
  mae: { label: "MAE", unit: " °C", d: 3, help: "Mean absolute error of the median forecast, in °C." },
  mase: { label: "MASE", unit: "", d: 3, help: "MAE divided by the in-sample error of repeating the previous day (period 24). < 1 beats that rule." },
  wql: { label: "WQL ≈ CRPS", unit: "", d: 3, help: "Weighted quantile loss over the 0.1…0.9 quantiles — scores the whole forecast distribution, as GIFT-Eval's CRPS." },
  mse_norm: { label: "MSE (norm.)", unit: "", d: 3, help: "MSE after z-normalising with train-split mean / std — the scale ETTh1 papers report." },
  rmse: { label: "RMSE", unit: " °C", d: 3, help: "Root mean squared error of the median forecast, in °C." },
};
const BOARDS = {
  "gift-crps": { label: "GIFT-Eval · CRPS", src: "gift", all: "crps", ett: "ettCrps", lower: true },
  "gift-mase": { label: "GIFT-Eval · MASE", src: "gift", all: "mase", ett: "ettMase", lower: true },
  "fev-sql": { label: "fev-bench · skill (SQL)", src: "fev", all: "skillSQL", ett: "ett1hSql", lower: false },
  "fev-mase": { label: "fev-bench · skill (MASE)", src: "fev", all: "skillMASE", ett: "ett1hSql", lower: false },
};

let D;
const state = {
  hidden: new Set(), orgsOff: new Set(), search: "",
  accMetric: "mae", sizeMetric: "mae", pareto: true, win: 0, board: "gift-crps", scope: "all",
};
const sections = [];

/* ---------- tiny DOM helpers ---------- */
function h(tag, attrs = {}, parent, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function sv(tag, attrs = {}, parent, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const pct = (v, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const params = (p) => (!p ? "—" : p >= 1e9 ? `${(p / 1e9).toFixed(1)}B` : p >= 1e6 ? `${Math.round(p / 1e6 * 10) / 10}M` : `${p}`);
const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
const logs = (d0, d1, r0, r1) => (v) => r0 + ((Math.log(v) - Math.log(d0)) / (Math.log(d1) - Math.log(d0))) * (r1 - r0);
function ticks(lo, hi, n = 5) {
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}
function cover(lo, hi, n = 4) {
  let t = ticks(lo, hi, n);
  const step = t.length > 1 ? t[1] - t[0] : hi - lo || 1;
  if (t[0] > lo + 1e-9) t = [+(t[0] - step).toFixed(10), ...t];
  if (t[t.length - 1] < hi - 1e-9) t = [...t, +(t[t.length - 1] + step).toFixed(10)];
  return t;
}
function parseLocal(iso) { const [d, t = "00:00:00"] = iso.split("T"); const [y, m, dd] = d.split("-").map(Number); const [hh] = t.split(":").map(Number); return new Date(y, m - 1, dd, hh); }
const dateFmt = (d, withHour = true) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + (withHour ? ` ${String(d.getHours()).padStart(2, "0")}:00` : "");

/* ---------- model helpers ---------- */
const isSmall = (m) => m.params > 0 && m.params < 20e6;
const colorOf = (m) => ORG_COLOR[m.org] || "var(--c-ref)";
const visibleModels = () => D.models.filter((m) => !state.hidden.has(m.name) && !state.orgsOff.has(m.org));
const byKey = () => Object.fromEntries(D.models.map((m) => [m.key, m]));
const baseline = () => D.models.find((m) => m.org === "Baseline");

function swatchDot(m, parent) {
  const s = h("i", { class: `swatch-dot${isSmall(m) ? " hollow" : ""}` }, parent);
  s.style.background = colorOf(m); s.style.borderColor = colorOf(m);
  return s;
}
function swatchLine(m, parent) {
  const s = h("i", { class: `swatch-line${isSmall(m) ? " dashed" : ""}` }, parent);
  s.style.borderColor = colorOf(m);
  return s;
}

/* ---------- tooltip ---------- */
const tip = () => document.getElementById("tooltip");
function showTip(evt, head, sub, rows) {
  const t = tip();
  t.replaceChildren();
  h("div", { class: "tooltip-head" }, t, head);
  if (sub) h("p", {}, t, sub);
  for (const r of rows) {
    const row = h("div", { class: "tooltip-value" }, t);
    const lab = h("span", {}, row);
    if (r.model) swatchLine(r.model, lab);
    lab.appendChild(document.createTextNode(r.label));
    h("b", {}, row, r.value);
  }
  t.hidden = false;
  const x = evt.clientX, y = evt.clientY, w = t.offsetWidth, ht = t.offsetHeight;
  t.style.left = `${Math.max(8, x + 16 + w > innerWidth ? x - w - 16 : x + 16)}px`;
  t.style.top = `${Math.max(8, Math.min(innerHeight - ht - 8, y + 16))}px`;
}
const hideTip = () => { tip().hidden = true; };

/* ---------- chart canvas: redraws on resize ---------- */
function canvas(parent, draw, sec) {
  const div = h("div", { class: "chart-canvas" }, parent);
  const ro = new ResizeObserver(() => {
    const { width: w, height: ht } = div.getBoundingClientRect();
    if (w < 10 || ht < 10) return;
    div.replaceChildren();
    const svg = sv("svg", { viewBox: `0 0 ${w} ${ht}`, role: "img" }, div);
    draw(svg, w, ht);
  });
  ro.observe(div);
  sec.observers.push(ro);
  return div;
}
function axes(svg, { x0, x1, y0, y1, yTicks, yScale, yFmt, xTicks, xScale, xFmt, yLabel, xLabel }) {
  for (const t of yTicks) {
    const y = yScale(t);
    sv("line", { class: "gridline", x1: x0, x2: x1, y1: y, y2: y }, svg);
    sv("text", { x: x0 - 8, y: y + 4, "text-anchor": "end" }, svg, yFmt(t));
  }
  sv("line", { class: "axisline", x1: x0, x2: x1, y1: y1, y2: y1 }, svg);
  for (const t of xTicks) sv("text", { x: xScale(t), y: y1 + 18, "text-anchor": "middle" }, svg, xFmt(t));
  if (yLabel) sv("text", { x: x0, y: y0 - 6 }, svg, yLabel);
  if (xLabel) sv("text", { x: x1, y: y1 + 34, "text-anchor": "end" }, svg, xLabel);
}

/* ---------- section scaffolding ---------- */
function section(id, tab, render, opts = {}) { sections.push({ id, tab, render, observers: [], ...opts }); }
function heading(root, title, controls) {
  const head = h("div", { class: "chart-heading" }, root);
  h("h2", {}, head, title);
  const c = h("div", { class: "chart-controls" }, head);
  if (controls) controls(c);
  return head;
}
function segmented(parent, options, current, onPick) {
  const g = h("div", { class: "chart-scale", role: "group" }, parent);
  for (const [value, label] of options) {
    const b = h("button", { "aria-pressed": String(value === current) }, g, label);
    b.addEventListener("click", () => onPick(value));
  }
  return g;
}
function rerender(ids) {
  for (const sec of sections) if (!ids || ids.includes(sec.id)) {
    sec.observers.forEach((o) => o.disconnect()); sec.observers = [];
    sec.el.replaceChildren(); sec.render(sec.el, sec);
  }
  hideTip();
}

/* =================================================================================== sections */

/* 1. Accuracy (dot plot) */
section("accuracy", "Accuracy", (root, sec) => {
  heading(root, "Accuracy on ETTh1 oil temperature", (c) =>
    segmented(c, Object.entries(LOCAL_METRICS).map(([k, v]) => [k, v.label]), state.accMetric, (v) => { state.accMetric = v; rerender(["accuracy"]); }));
  const metric = LOCAL_METRICS[state.accMetric];
  h("p", { class: "chart-sub" }, root,
    `Every model forecasts the next ${D.run.horizon} hours from ${D.run.windows} starting points across the last four months of ETTh1, using all the history before each point. The future is hidden from the model and only used to score it. ${metric.help} Lower is better.`);

  const ms = visibleModels();
  const best = [...D.models].filter((m) => m.org !== "Baseline").sort((a, b) => a.local.mae - b.local.mae)[0];
  const naive = baseline();
  const stats = h("div", { class: "pop-stats" }, root);
  const tile = (label, value, small) => { const d = h("div", {}, stats); h("span", {}, d, label); h("strong", {}, d, value); if (small) h("small", {}, d, small); };
  tile("Forecast windows", `${D.run.windows} × ${D.run.horizon} h`, `one every ${D.run.stride} h`);
  tile("Best MAE", `${fmt(best.local.mae, 2)} °C`, best.name);
  tile("vs repeat-yesterday", naive ? `−${pct(1 - best.local.mae / naive.local.mae, 0)}` : "—", "error reduction, best model");
  tile("Context", "full history", `≤ ${D.run.test_split[1].toLocaleString("en")} h, no truncation`);
  tile("Hardware", D.run.gpu ? D.run.gpu.replace("NVIDIA GeForce ", "") : D.run.device, "local GPU");
  tile("Run date", D.run.date, "zero-shot, no fine-tuning");

  const sorted = [...ms].sort((a, b) => a.local[state.accMetric] - b.local[state.accMetric]);
  const isMae = state.accMetric === "mae";
  const vals = sorted.flatMap((m) => (isMae ? [...m.windowMae].sort((a, b) => a - b).filter((_, i, a) => i === Math.floor(a.length * 0.75)) : []).concat([m.local[state.accMetric]]));
  const accTicks = cover(0, Math.max(...vals, 0) || 1, 4), max = accTicks[accTicks.length - 1];
  const plot = h("div", { class: "dot-plot" }, root);
  const ax = h("div", { class: "dot-axis" }, plot);
  accTicks.forEach((t) => h("span", {}, ax, fmt(t, 1)));
  sorted.forEach((m, i) => {
    const v = m.local[state.accMetric];
    const item = h("div", { class: "dot-item" }, plot);
    const row = h("button", { class: "dot-row", "aria-expanded": "false" }, item);
    h("span", { class: "dot-rank" }, row, String(i + 1));
    const name = h("span", { class: "dot-name" }, row); swatchDot(m, name); h("span", {}, name, m.name);
    h("span", { class: "dot-range" }, row, `${fmt(v, metric.d)}${metric.unit}`);
    const track = h("span", { class: "dot-track" }, row);
    if (isMae) {
      const s = [...m.windowMae].sort((a, b) => a - b), q1 = s[Math.floor(s.length * 0.25)], q3 = s[Math.floor(s.length * 0.75)];
      const span = h("i", { class: "dot-span" }, track);
      span.style.left = `${(q1 / max) * 100}%`; span.style.width = `${((q3 - q1) / max) * 100}%`; span.style.background = colorOf(m);
    }
    const dot = h("i", { class: `dot${isSmall(m) ? " hollow" : ""}` }, track);
    dot.style.left = `${(v / max) * 100}%`; dot.style.background = colorOf(m); dot.style.borderColor = colorOf(m);
    const det = h("div", { class: "dot-detail" }, item);
    const kv = (k, val) => { const d = h("div", {}, det); h("span", {}, d, k); h("b", {}, d, val); };
    kv("Lab", m.org); kv("Parameters", params(m.params));
    for (const [k, mm] of Object.entries(LOCAL_METRICS)) kv(mm.label, `${fmt(m.local[k], mm.d)}${mm.unit}`);
    kv("80% band coverage", m.org === "Baseline" ? "— (no band)" : pct(m.local.coverage80));
    kv("Inference", `${fmt(m.local.seconds, 1)} s for ${D.run.windows} forecasts`);
    kv("Licence", m.license);
    if (m.repo) { const d = h("div", {}, det); h("span", {}, d, "Weights"); const b = h("b", {}, d); h("a", { href: `https://huggingface.co/${m.repo}`, target: "_blank", rel: "noopener" }, b, `${m.repo}@${(m.revision || "").slice(0, 8)}`); }
    row.addEventListener("click", () => { item.classList.toggle("open"); row.setAttribute("aria-expanded", item.classList.contains("open")); });
  });
  if (isMae) h("div", { class: "chart-caption" }, root).append(
    h("span", {}, null, "Dot = average over all windows · bar = middle 50% of the per-window errors · hollow = ~5M-parameter variant · click a row for every metric."),
  );
});

/* 2 & 3. Scatter: skill vs size / vs speed */
function scatterSection(id, tab, title, sub, xOf, xFmt, xLabel) {
  section(id, tab, (root, sec) => {
    heading(root, title, (c) => {
      segmented(c, [["mae", "MAE"], ["mase", "MASE"], ["wql", "WQL"]], state.sizeMetric, (v) => { state.sizeMetric = v; rerender(["size", "speed"]); });
      const p = h("button", { class: "pareto-toggle", "aria-pressed": String(state.pareto) }, c, "Pareto line");
      p.addEventListener("click", () => { state.pareto = !state.pareto; rerender(["size", "speed"]); });
    });
    h("p", { class: "chart-sub" }, root, sub);
    const naive = baseline();
    const pts = visibleModels().filter((m) => m.org !== "Baseline" && xOf(m) > 0)
      .map((m) => ({ m, x: xOf(m), y: 1 - m.local[state.sizeMetric] / naive.local[state.sizeMetric] }));
    canvas(root, (svg, w, ht) => {
      if (!pts.length) { sv("text", { x: w / 2, y: ht / 2, "text-anchor": "middle" }, svg, "No models selected."); return; }
      const M = { l: 52, r: 120, t: 22, b: 42 };
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const xlo = Math.min(...xs) / 2, xhi = Math.max(...xs) * 2;
      const ylo = Math.max(0, Math.floor((Math.min(...ys) - 0.04) * 50) / 50), yhi = Math.ceil((Math.max(...ys) + 0.03) * 50) / 50;
      const X = logs(xlo, xhi, M.l, w - M.r), Y = lin(ylo, yhi, ht - M.b, M.t);
      const xt = []; for (let e = Math.floor(Math.log10(xlo)); e <= Math.ceil(Math.log10(xhi)); e++) for (const k of [1, 3]) { const v = k * 10 ** e; if (v >= xlo && v <= xhi) xt.push(v); }
      axes(svg, { x0: M.l, x1: w - M.r, y0: M.t, y1: ht - M.b, yTicks: ticks(ylo, yhi, 5), yScale: Y, yFmt: (t) => pct(t, 0), xTicks: xt, xScale: X, xFmt, yLabel: `↑ better than repeat-yesterday (${LOCAL_METRICS[state.sizeMetric].label})`, xLabel });
      if (state.pareto) {
        const front = [...pts].sort((a, b) => a.x - b.x).filter((p, i, a) => a.slice(0, i).every((q) => q.y < p.y));
        if (front.length > 1) sv("polyline", { points: front.map((p) => `${X(p.x)},${Y(p.y)}`).join(" "), fill: "none", stroke: "var(--accent)", "stroke-width": 1.5, "stroke-dasharray": "5 4" }, svg);
      }
      // labels: to the right of each point, nudged apart vertically
      const placed = pts.map((p) => ({ ...p, px: X(p.x), py: Y(p.y), ly: Y(p.y) })).sort((a, b) => a.py - b.py);
      for (let i = 1; i < placed.length; i++) if (Math.abs(placed[i].px - placed[i - 1].px) < 140 && placed[i].ly - placed[i - 1].ly < 16) placed[i].ly = placed[i - 1].ly + 16;
      for (const p of placed) {
        const g = sv("g", { tabindex: 0, role: "button", "aria-label": `${p.m.name}: ${pct(p.y)}` }, svg);
        sv("circle", { cx: p.px, cy: p.py, r: 16, fill: "transparent" }, g);
        sv("circle", { cx: p.px, cy: p.py, r: 6, fill: isSmall(p.m) ? "var(--bg)" : colorOf(p.m), stroke: isSmall(p.m) ? colorOf(p.m) : "var(--bg)", "stroke-width": 2 }, g);
        sv("text", { class: "label", x: p.px + 12, y: p.ly + 4 }, g, p.m.name);
        const show = (e) => showTip(e, p.m.name, `${p.m.org} · ${params(p.m.params)} parameters`, [
          { label: "vs repeat-yesterday", value: pct(p.y) },
          { label: LOCAL_METRICS[state.sizeMetric].label, value: fmt(p.m.local[state.sizeMetric]) },
          { label: "Time / forecast", value: `${fmt((p.m.local.seconds / D.run.windows) * 1000, 0)} ms` },
        ]);
        g.addEventListener("pointermove", show); g.addEventListener("pointerleave", hideTip);
        g.addEventListener("focus", (e) => { const r = e.target.getBoundingClientRect(); show({ clientX: r.right, clientY: r.top }); });
        g.addEventListener("blur", hideTip);
      }
    }, sec);
    h("div", { class: "chart-caption" }, root).append(
      h("span", {}, null, "Filled = large model · hollow = ~5M variant · dashed line = Pareto frontier (nothing else is both smaller/faster and more accurate)."),
    );
  });
}

/* 4. Calibration */
section("calibration", "Calibration", (root) => {
  heading(root, "Are the uncertainty bands honest?");
  h("p", { class: "chart-sub" }, root,
    "Each model also gives a 10%–90% range for every hour. If that range is well calibrated, the real temperature lands inside it 80% of the time. Above 80% = the range is wider than needed (cautious); below = overconfident.");
  const ms = visibleModels().filter((m) => m.org !== "Baseline").sort((a, b) => Math.abs(a.local.coverage80 - 0.8) - Math.abs(b.local.coverage80 - 0.8));
  const lo = 0.6, hi = 1;
  const plot = h("div", { class: "dot-plot" }, root);
  const ax = h("div", { class: "dot-axis" }, plot);
  [0.6, 0.7, 0.8, 0.9, 1].forEach((t) => h("span", {}, ax, pct(t, 0)));
  ms.forEach((m, i) => {
    const v = m.local.coverage80;
    const item = h("div", { class: "dot-item" }, plot);
    const row = h("div", { class: "dot-row" }, item);
    h("span", { class: "dot-rank" }, row, String(i + 1));
    const name = h("span", { class: "dot-name" }, row); swatchDot(m, name); h("span", {}, name, m.name);
    h("span", { class: "dot-range" }, row, `${pct(v)}  (${v >= 0.8 ? "+" : ""}${((v - 0.8) * 100).toFixed(1)} pt)`);
    const track = h("span", { class: "dot-track" }, row);
    const target = h("i", { class: "dot-target" }, track); target.style.left = `${((0.8 - lo) / (hi - lo)) * 100}%`;
    const span = h("i", { class: "dot-span" }, track);
    const a = Math.min(v, 0.8), b = Math.max(v, 0.8);
    span.style.left = `${((a - lo) / (hi - lo)) * 100}%`; span.style.width = `${((b - a) / (hi - lo)) * 100}%`; span.style.background = colorOf(m);
    const dot = h("i", { class: `dot${isSmall(m) ? " hollow" : ""}` }, track);
    dot.style.left = `${((v - lo) / (hi - lo)) * 100}%`; dot.style.background = colorOf(m); dot.style.borderColor = colorOf(m);
  });
  h("div", { class: "chart-caption" }, root).append(h("span", {}, null, "Vertical tick = the 80% target. Sorted by distance to the target. The seasonal-naive baseline has no range, so it is left out."));
}, { auto: true });

/* 5. Forecast explorer */
section("forecasts", "Forecasts", (root, sec) => {
  const n = D.origins.length;
  heading(root, "Forecast explorer", (c) => {
    const wc = h("div", { class: "window-control" }, c);
    const prev = h("button", { "aria-label": "Previous window" }, wc, "‹");
    const range = h("input", { type: "range", min: 0, max: n - 1, value: state.win, "aria-label": "Forecast window" }, wc);
    const next = h("button", { "aria-label": "Next window" }, wc, "›");
    h("b", {}, wc, `${dateFmt(parseLocal(D.origins[state.win]))}`);
    h("span", {}, wc, `window ${state.win + 1}/${n}`);
    const go = (i) => { state.win = Math.max(0, Math.min(n - 1, i)); rerender(["forecasts"]); };
    prev.addEventListener("click", () => go(state.win - 1)); next.addEventListener("click", () => go(state.win + 1));
    range.addEventListener("change", () => go(+range.value));
  });
  h("p", { class: "chart-sub" }, root, `The last ${D.history} hours the model saw, then its ${D.run.horizon}-hour forecast (line = median, shaded = 10–90% range of the large models) against what really happened (white). Pick any of the ${n} windows — every number on this page is computed from these forecasts.`);
  const ms = visibleModels();
  const H = D.run.horizon, oIdx = D.history + state.win * D.run.stride;
  const start = parseLocal(D.series.start);
  const hist = D.series.values.slice(oIdx - D.history, oIdx);
  const actual = D.series.values.slice(oIdx, oIdx + H);
  const fc = ms.map((m) => ({ m, q10: D.forecasts[m.name].q10[state.win], q50: D.forecasts[m.name].q50[state.win], q90: D.forecasts[m.name].q90[state.win] }));
  canvas(root, (svg, w, ht) => {
    const M = { l: 44, r: 16, t: 20, b: 40 };
    const all = [...hist, ...actual, ...fc.flatMap((f) => [...f.q10, ...f.q90])].filter((v) => v != null);
    const ylo = Math.floor(Math.min(...all) - 0.5), yhi = Math.ceil(Math.max(...all) + 0.5);
    const total = D.history + H;
    const X = lin(0, total - 1, M.l, w - M.r), Y = lin(ylo, yhi, ht - M.b, M.t);
    const tAt = (i) => new Date(start.getTime() + (oIdx - D.history + i) * 3600e3);
    const xt = []; for (let i = 0; i < total; i++) if (tAt(i).getHours() === 0 && (tAt(i).getDate() % (w < 600 ? 2 : 1) === 0)) xt.push(i);
    axes(svg, { x0: M.l, x1: w - M.r, y0: M.t, y1: ht - M.b, yTicks: ticks(ylo, yhi, 6), yScale: Y, yFmt: (t) => `${t}`, xTicks: xt, xScale: X, xFmt: (i) => tAt(i).toLocaleDateString("en-GB", { day: "numeric", month: "short" }), yLabel: "OT (°C)" });
    sv("line", { class: "refline", x1: X(D.history - 0.5), x2: X(D.history - 0.5), y1: M.t, y2: ht - M.b }, svg);
    sv("text", { x: X(D.history - 0.5) + 6, y: M.t + 10 }, svg, "forecast starts");
    const path = (arr, off) => arr.map((v, i) => `${i ? "L" : "M"}${X(off + i)},${Y(v)}`).join("");
    for (const f of fc) if (f.m.org !== "Baseline" && !isSmall(f.m)) {
      const d = path(f.q90, D.history) + f.q10.map((v, i) => `L${X(D.history + f.q10.length - 1 - i)},${Y(f.q10[f.q10.length - 1 - i])}`).join("") + "Z";
      sv("path", { d, fill: colorOf(f.m), "fill-opacity": 0.14, stroke: "none" }, svg);
    }
    sv("path", { d: path(hist, 0), fill: "none", stroke: "var(--fg-2)", "stroke-width": 1.5 }, svg);
    for (const f of fc) sv("path", { d: path(f.q50, D.history), fill: "none", stroke: colorOf(f.m), "stroke-width": 2, "stroke-dasharray": isSmall(f.m) ? "5 4" : f.m.org === "Baseline" ? "2 3" : null }, svg);
    sv("path", { d: path(actual, D.history), fill: "none", stroke: "var(--fg)", "stroke-width": 2 }, svg);
    // crosshair
    const cross = sv("line", { x1: 0, x2: 0, y1: M.t, y2: ht - M.b, stroke: "var(--fg-3)", visibility: "hidden" }, svg);
    const hit = sv("rect", { x: M.l, y: M.t, width: w - M.l - M.r, height: ht - M.t - M.b, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(total - 1, Math.round(((e.clientX - r.left - M.l) / (w - M.l - M.r)) * (total - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      const rows = [];
      if (i < D.history) rows.push({ label: "Observed", value: `${fmt(hist[i], 2)} °C` });
      else {
        const j = i - D.history;
        rows.push({ label: "Actual (hidden)", value: `${fmt(actual[j], 2)} °C` });
        for (const f of fc) rows.push({ model: f.m, label: f.m.name, value: f.m.org === "Baseline" ? `${fmt(f.q50[j], 2)}` : `${fmt(f.q50[j], 2)}  [${fmt(f.q10[j], 1)}–${fmt(f.q90[j], 1)}]` });
      }
      showTip(e, dateFmt(tAt(i)), i < D.history ? "history given to the models" : `+${i - D.history + 1} h ahead · median [10–90%]`, rows);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  }, sec);
  const leg = h("div", { class: "chart-legend" }, root);
  const a = h("span", {}, leg); h("i", { class: "swatch-line" }, a).style.borderColor = "var(--fg)"; a.append("Actual");
  for (const f of fc) {
    const s = h("span", {}, leg); swatchLine(f.m, s);
    s.append(`${f.m.name} · MAE ${fmt(f.m.windowMae[state.win], 2)} °C`);
  }
});

/* 6. Error over time */
section("over-time", "Over time", (root, sec) => {
  heading(root, "Error across the test period");
  h("p", { class: "chart-sub" }, root, "Average error of each 96-hour forecast, by the date it was made. Spikes are sudden drops in temperature that no model saw coming. Click the chart to open that window in the forecast explorer.");
  const ms = visibleModels();
  const dates = D.origins.map(parseLocal);
  canvas(root, (svg, w, ht) => {
    const M = { l: 44, r: 16, t: 20, b: 40 };
    const all = ms.flatMap((m) => m.windowMae);
    const yhi = Math.ceil(Math.max(...all, 1));
    const X = lin(0, dates.length - 1, M.l, w - M.r), Y = lin(0, yhi, ht - M.b, M.t);
    const xt = dates.map((d, i) => (d.getDate() === 1 ? i : -1)).filter((i) => i >= 0);
    axes(svg, { x0: M.l, x1: w - M.r, y0: M.t, y1: ht - M.b, yTicks: ticks(0, yhi, 5), yScale: Y, yFmt: (t) => `${t}`, xTicks: xt, xScale: X, xFmt: (i) => dates[i].toLocaleDateString("en-GB", { month: "short", year: "2-digit" }), yLabel: "MAE per window (°C)" });
    for (const m of ms) sv("path", { d: m.windowMae.map((v, i) => `${i ? "L" : "M"}${X(i)},${Y(v)}`).join(""), fill: "none", stroke: colorOf(m), "stroke-width": m.org === "Baseline" ? 1.5 : 2, "stroke-dasharray": isSmall(m) ? "5 4" : m.org === "Baseline" ? "2 3" : null, "stroke-linejoin": "round" }, svg);
    const cross = sv("line", { y1: M.t, y2: ht - M.b, stroke: "var(--fg-3)", visibility: "hidden" }, svg);
    const hit = sv("rect", { x: M.l, y: M.t, width: w - M.l - M.r, height: ht - M.t - M.b, fill: "transparent", style: "cursor:pointer" }, svg);
    const idx = (e) => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(dates.length - 1, Math.round(((e.clientX - r.left - M.l) / (w - M.l - M.r)) * (dates.length - 1)))); };
    hit.addEventListener("pointermove", (e) => {
      const i = idx(e);
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      showTip(e, dateFmt(dates[i]), "MAE of the next 96 h · click to inspect", [...ms].sort((a, b) => a.windowMae[i] - b.windowMae[i]).map((m) => ({ model: m, label: m.name, value: `${fmt(m.windowMae[i], 2)} °C` })));
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
    hit.addEventListener("click", (e) => { state.win = idx(e); rerender(["forecasts"]); document.getElementById("forecasts").scrollIntoView({ behavior: "smooth" }); });
  }, sec);
  const leg = h("div", { class: "chart-legend" }, root);
  for (const m of ms) { const s = h("span", {}, leg); swatchLine(m, s); s.append(m.name); }
});

/* 7. Head-to-head */
section("head-to-head", "Head-to-head", (root) => {
  heading(root, "Head-to-head: who wins more windows?");
  h("p", { class: "chart-sub" }, root, `Share of the ${D.run.windows} forecast windows in which the row model has a lower error than the column model (ties count half). 50% = a coin flip.`);
  const ms = visibleModels();
  const wrap = h("div", { class: "matrix-wrap" }, root);
  const t = h("table", { class: "matrix" }, wrap);
  const hr = h("tr", {}, h("thead", {}, t)); h("th", {}, hr, "row beats column →");
  ms.forEach((m) => h("th", { scope: "col" }, hr, m.name));
  const tb = h("tbody", {}, t);
  for (const a of ms) {
    const tr = h("tr", {}, tb); h("th", { scope: "row" }, tr, a.name);
    for (const b of ms) {
      if (a === b) { h("td", { class: "diag" }, tr, "—"); continue; }
      const v = D.pairwise[a.name][b.name];
      const td = h("td", {}, tr, pct(v, 0));
      const mix = Math.round(Math.min(1, Math.abs(v - 0.5) * 2.2) * 70);
      td.style.background = `color-mix(in srgb, ${v >= 0.5 ? "var(--div-pos)" : "var(--div-neg)"} ${mix}%, var(--surface))`;
      td.title = `${a.name} beats ${b.name} in ${pct(v)} of windows`;
    }
  }
  const lr = h("div", { class: "legend-ramp" }, root);
  h("span", {}, lr, "row loses");
  h("i", {}, lr).style.background = "linear-gradient(90deg, var(--div-neg), var(--surface), var(--div-pos))";
  h("span", {}, lr, "row wins");
}, { auto: true });

/* 8. Public leaderboards */
section("leaderboards", "Leaderboards", (root) => {
  const cfg = BOARDS[state.board];
  heading(root, "Public leaderboards (Hugging Face)", (c) => {
    segmented(c, Object.entries(BOARDS).map(([k, v]) => [k, v.label]), state.board, (v) => { state.board = v; rerender(["leaderboards"]); });
    segmented(c, [["all", "All tasks"], ["ett", "ETT only"]], state.scope, (v) => { state.scope = v; rerender(["leaderboards"]); });
  });
  const L = D.leaderboards;
  const ettNote = cfg.src === "gift" ? `the ${L.giftEttConfigs} ETT configs` : "the ETT_1H task (hourly ETT, 168 h horizon, 20 windows; SQL)";
  const lower = state.scope === "ett" ? true : cfg.lower;
  h("p", { class: "chart-sub" }, root, cfg.src === "gift"
    ? `GIFT-Eval scores each model on ${L.giftConfigs} dataset × frequency × horizon configurations, divides each score by the seasonal-naive score, and takes the geometric mean. ${state.scope === "ett" ? `Here restricted to ${ettNote}.` : ""} Lower is better; 1.0 = no better than repeating the last season.`
    : state.scope === "ett"
      ? `fev-bench error on ${ettNote}, divided by seasonal naive. Lower is better.`
      : `fev-bench runs ${L.fevTasks} tasks with their own horizons and rolling windows. Skill = 1 − geometric mean of (model error ÷ seasonal-naive error), computed with the official fev package. Higher is better.`);
  const rows = (cfg.src === "gift" ? L.gift : L.fev).map((r) => ({ ...r, v: r[state.scope === "ett" ? cfg.ett : cfg.all] }))
    .filter((r) => r.v != null).sort((a, b) => (lower ? a.v - b.v : b.v - a.v));
  const tested = byKey();
  const vs = rows.map((r) => r.v);
  const lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * 0.15 || 0.05;
  const lbTicks = cover(Math.max(0, lo - pad), hi + pad, 4), x0 = lbTicks[0], x1 = lbTicks[lbTicks.length - 1];
  const plot = h("div", { class: "dot-plot" }, root);
  const ax = h("div", { class: "dot-axis" }, plot);
  lbTicks.forEach((t) => h("span", {}, ax, fmt(t, 2)));
  rows.forEach((r, i) => {
    const m = tested[r.key];
    const shown = m && !state.hidden.has(m.name) && !state.orgsOff.has(m.org);
    const item = h("div", { class: `dot-item${shown ? "" : " ref-row"}` }, plot);
    const row = h("button", { class: "dot-row", "aria-expanded": "false" }, item);
    h("span", { class: "dot-rank" }, row, String(i + 1));
    const name = h("span", { class: "dot-name" }, row);
    if (shown) swatchDot(m, name); else h("i", { class: "swatch-dot" }, name).style.background = "var(--c-ref)";
    h("span", {}, name, r.name);
    if (m) h("small", {}, name, "tested here");
    h("span", { class: "dot-range" }, row, fmt(r.v, 4));
    const track = h("span", { class: "dot-track" }, row);
    const dot = h("i", { class: `dot${shown && isSmall(m) ? " hollow" : ""}` }, track);
    dot.style.left = `${((r.v - x0) / (x1 - x0)) * 100}%`;
    dot.style.background = shown ? colorOf(m) : "var(--c-ref)"; dot.style.borderColor = shown ? colorOf(m) : "var(--c-ref)";
    const det = h("div", { class: "dot-detail" }, item);
    const kv = (k, val) => { if (val == null) return; const d = h("div", {}, det); h("span", {}, d, k); h("b", {}, d, val); };
    if (cfg.src === "gift") {
      kv("Organisation", r.org); kv("Type", r.type); kv("Test-data leakage", r.leakage);
      kv("CRPS (all / ETT)", `${fmt(r.crps, 4)} / ${fmt(r.ettCrps, 4)}`); kv("MASE (all / ETT)", `${fmt(r.mase, 4)} / ${fmt(r.ettMase, 4)}`);
    } else {
      kv("Skill SQL / MASE", `${pct(r.skillSQL)} / ${pct(r.skillMASE)}`);
      kv("Win rate SQL (among these models)", pct(r.winSQL)); kv("ETT_1H SQL ÷ naive", fmt(r.ett1hSql, 4));
    }
    row.addEventListener("click", () => { item.classList.toggle("open"); row.setAttribute("aria-expanded", item.classList.contains("open")); });
  });
  const cap = h("div", { class: "chart-caption" }, root);
  h("span", {}, cap, `Recomputed from the official per-task result files (${L.fetched || "date unknown"}). Grey = reference models not tested locally. Win rates are among the models listed here only.`);
  const links = h("span", {}, cap);
  h("a", { href: "https://huggingface.co/spaces/Salesforce/GIFT-Eval", target: "_blank", rel: "noopener" }, links, "GIFT-Eval ↗");
  links.append("  ·  ");
  h("a", { href: "https://huggingface.co/spaces/autogluon/fev-bench", target: "_blank", rel: "noopener" }, links, "fev-bench ↗");
}, { auto: true });

/* 9. Data & methodology */
section("methodology", "Data & methodology", (root) => {
  heading(root, "Data & methodology");
  const ms = D.models;
  const cols = [["mae", "MAE °C", 3], ["rmse", "RMSE °C", 3], ["mse_norm", "MSE norm", 3], ["mae_norm", "MAE norm", 3], ["mase", "MASE", 3], ["wql", "WQL", 3], ["coverage80", "Cov. 80%", 3], ["win_rate", "Win rate", 3], ["seconds", "Seconds", 1]];
  const sc = h("div", { class: "table-scroll" }, root);
  const t = h("table", { class: "data-table" }, sc);
  const hr = h("tr", {}, h("thead", {}, t));
  ["Model", "Lab", "Params", ...cols.map((c) => c[1])].forEach((c) => h("th", { scope: "col" }, hr, c));
  const tb = h("tbody", {}, t);
  const bestOf = Object.fromEntries(cols.map(([k]) => [k, k === "win_rate" ? Math.max(...ms.map((m) => m.local[k] ?? -1)) : k === "coverage80" ? null : Math.min(...ms.filter((m) => m.org !== "Baseline").map((m) => m.local[k]))]));
  for (const m of [...ms].sort((a, b) => a.local.mae - b.local.mae)) {
    const tr = h("tr", {}, tb);
    h("td", {}, tr, m.name); h("td", {}, tr, m.org); h("td", {}, tr, params(m.params));
    for (const [k, , d] of cols) {
      const v = m.local[k];
      h("td", { class: v != null && v === bestOf[k] && m.org !== "Baseline" ? "best" : null }, tr, k === "coverage80" && m.org === "Baseline" ? "—" : fmt(v, d));
    }
  }
  const md = h("div", { class: "method", id: "method-text" }, root);
  const p = (title, ...paras) => { if (title) h("h3", {}, md, title); for (const x of paras) h("p", {}, md, x); };
  p("What is tested",
    `Dataset: ETTh1 (Electricity Transformer Temperature, hourly, July 2016 – June 2018). Target: OT, the transformer oil temperature, forecast on its own (univariate, no covariates). Split: the standard 12 / 4 / 4 months (30-day months) used in the literature; forecasts start inside the last 4 months (hours ${D.run.test_split[0].toLocaleString("en")}–${D.run.test_split[1].toLocaleString("en")}).`,
    `Windows: a forecast starts every ${D.run.stride} h, ${D.run.windows} windows of ${D.run.horizon} h. Each model receives the full history before the window (no truncation: Timestral accepts 32,768 steps, TimeH2O 16,384) and no information after it. All models are zero-shot: pretrained weights, no fine-tuning.`);
  p("Metrics",
    "MAE and RMSE use the median forecast, in °C. MSE / MAE (norm.) divide errors by the standard deviation of the training months, the scale most ETTh1 papers report. MASE divides each window's MAE by the average error of repeating the value from 24 h earlier over that window's history. WQL is the weighted quantile loss over the nine quantiles 0.1…0.9 — the CRPS approximation GIFT-Eval uses. Coverage is the share of real values inside the 10–90% range. Win rate is the share of (window, opponent) pairs with a lower MAE, ties counting half, as fev-bench does.");
  p("Public leaderboards",
    "GIFT-Eval (Salesforce) and fev-bench (AutoGluon) are the leaderboards hosted on Hugging Face for this type of model. Their pages render in the browser, so the scores here are recomputed from the per-task result files each leaderboard publishes on GitHub, using the same aggregation: GIFT-Eval divides each config's MASE / CRPS by seasonal naive and takes a geometric mean; fev-bench uses the official fev package (skill = 1 − geometric mean of clipped relative errors).");
  h("h3", {}, md, "Reproduce");
  h("pre", {}, md, "git clone https://github.com/come-collab/TimeSeries-Prediction-Model-Benchmark\ncd TimeSeries-Prediction-Model-Benchmark\nscripts/setup.sh                 # venv + packages + ETTh1 data\nexport HF_TOKEN=...              # TimeH2O weights are gated (accept the licence first)\n.venv/bin/python benchmark.py    # runs every model, writes results/benchmark/\nscripts/fetch_leaderboards.sh    # official GIFT-Eval / fev-bench result files\n.venv/bin/python build_site.py   # rebuilds site/data.json");
  p(null, "Every forecast (all nine quantiles, every model, every hour) is in results/benchmark/predictions.csv next to the true value, so each number on this page can be recomputed in a spreadsheet.");
  h("h3", {}, md, "Models & licences");
  const ul = h("ul", {}, md);
  for (const m of ms.filter((x) => x.repo)) h("li", {}, ul, `${m.name} — ${m.org}, ${params(m.params)} parameters, huggingface.co/${m.repo} @ ${m.revision}. Licence: ${m.license}.`);
  p(null, `TimeH2O-v1 and TimeH2O-v1-tiny were evaluated on ${D.run.date} under the H2O Model Non-Commercial Licence v1.0 for benchmarking purposes, with the exact revisions above and the method described on this page. Results are illustrative and not an endorsement by H2O.ai or Mistral AI.`);
  p("Data", "ETT dataset by Zhou et al. (Informer, AAAI 2021), github.com/zhouhaoyi/ETDataset, licensed CC BY-ND 4.0.");
}, { auto: true });

scatterSection("size", "Size",
  "Accuracy vs model size",
  "How much better than repeating yesterday each model is, against its number of parameters. A model on the upper left gives more accuracy for its size.",
  (m) => m.params, (v) => params(v), "parameters (log) →");
scatterSection("speed", "Speed",
  "Accuracy vs inference time",
  "Same accuracy axis, against the time to produce one 96-hour forecast on the local GPU (full-history context, batch of one). Upper left = fast and accurate.",
  (m) => m.local.seconds / D.run.windows, (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(1)} s`), "time per forecast (log) →");

/* ---------- order, tabs, sidebar ---------- */
const ORDER = ["accuracy", "size", "speed", "calibration", "forecasts", "over-time", "head-to-head", "|", "leaderboards", "|", "methodology"];

function buildFeed() {
  const feed = document.getElementById("feed");
  feed.replaceChildren();
  const tabs = document.getElementById("tabs");
  tabs.replaceChildren();
  for (const id of ORDER) {
    if (id === "|") { h("span", { class: "tab-divider" }, tabs); continue; }
    const sec = sections.find((s) => s.id === id);
    sec.el = h("section", { class: `chart-section${sec.auto ? " auto" : ""}`, id }, feed);
    sec.tabBtn = h("button", {}, tabs, sec.tab);
    sec.tabBtn.addEventListener("click", () => sec.el.scrollIntoView({ behavior: "smooth" }));
  }
  rerender();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      for (const s of sections) s.tabBtn?.classList.toggle("active", s.el === e.target);
    }
  }, { root: innerWidth > 900 ? feed : null, rootMargin: "-30% 0px -60% 0px" });
  sections.forEach((s) => io.observe(s.el));
}

function buildSidebar() {
  const orgs = [...new Set(D.models.map((m) => m.org))];
  const of = document.getElementById("org-filter");
  of.replaceChildren();
  for (const o of orgs) {
    const b = h("button", { "aria-pressed": String(!state.orgsOff.has(o)) }, of, o);
    b.addEventListener("click", () => { state.orgsOff.has(o) ? state.orgsOff.delete(o) : state.orgsOff.add(o); buildSidebar(); rerender(); });
  }
  const list = document.getElementById("model-list");
  list.replaceChildren();
  const q = state.search.toLowerCase();
  const shown = D.models.filter((m) => !q || `${m.name} ${m.org}`.toLowerCase().includes(q));
  for (const m of shown) {
    const on = !state.hidden.has(m.name) && !state.orgsOff.has(m.org);
    const b = h("button", { class: "model-row", "aria-pressed": String(on) }, list);
    swatchDot(m, b); h("span", { class: "model-name" }, b, m.name); h("small", {}, b, params(m.params));
    b.addEventListener("click", () => {
      if (state.orgsOff.has(m.org)) { state.orgsOff.delete(m.org); D.models.filter((x) => x.org === m.org && x !== m).forEach((x) => state.hidden.add(x.name)); state.hidden.delete(m.name); }
      else state.hidden.has(m.name) ? state.hidden.delete(m.name) : state.hidden.add(m.name);
      buildSidebar(); rerender();
    });
  }
  document.getElementById("model-count").textContent = `${visibleModels().length}/${D.models.length}`;
  document.getElementById("side-note").textContent = "Colour = lab (orange Mistral AI, blue H2O.ai, grey baseline). Filled / solid = large model, hollow / dashed = ~5M-parameter variant. Click a model to hide or show it everywhere.";
}

function init() {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.dataset.theme = saved;
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next; localStorage.setItem("theme", next);
    document.querySelector('meta[name="theme-color"]').content = next === "light" ? "#ffffff" : "#000000";
  });
  const sb = document.getElementById("sidebar");
  document.getElementById("open-sidebar").addEventListener("click", () => sb.classList.add("open"));
  document.getElementById("close-sidebar").addEventListener("click", () => sb.classList.remove("open"));
  const search = document.getElementById("search");
  search.addEventListener("input", () => { state.search = search.value; buildSidebar(); });
  addEventListener("keydown", (e) => { if (e.key === "/" && document.activeElement !== search) { e.preventDefault(); search.focus(); } });
  document.getElementById("select-all").addEventListener("click", () => { state.hidden.clear(); state.orgsOff.clear(); buildSidebar(); rerender(); });
  addEventListener("scroll", hideTip, true);

  fetch("data.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((data) => {
    D = data;
    { const w = D.models[0].windowMae, med = [...w].sort((a, b) => a - b)[Math.floor(w.length / 2)]; state.win = w.indexOf(med); }
    document.getElementById("footer-run").textContent = `${D.run.dataset} · ${D.run.target} · ${D.run.windows} windows × ${D.run.horizon} h · run ${D.run.date}`;
    buildSidebar();
    buildFeed();
  }).catch((err) => {
    document.getElementById("feed").replaceChildren(h("div", { class: "pop-loading" }, null, `Could not load data.json (${err.message}).`));
  });
}
init();
