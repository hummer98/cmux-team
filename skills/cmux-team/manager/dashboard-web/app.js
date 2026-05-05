/* T414: cmux-team Web ダッシュボード SPA — vanilla JS */
"use strict";

const PRESETS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const ROLE_COLORS = {
  conductor: "#58a6ff",
  master: "#7e57c2",
  agent: "#30c850",
  unknown: "#777f8c",
  researcher: "#26c6da",
  planner: "#ab47bc",
  implementer: "#42a5f5",
  reviewer: "#ffa726",
  tester: "#ec407a",
  dockeeper: "#9ccc65",
  taskmanager: "#bdbdbd",
  other: "#777f8c",
};

const PAGES = ["overview", "tool-use", "agent-strategy", "tokens", "tasks"];

const state = {
  page: "overview",
  fromIso: isoNow(-PRESETS["24h"]),
  toIso: isoNow(0),
  refreshOn: true,
  drillTaskId: null,
  refreshTimer: null,
};

function isoNow(deltaMs) {
  return new Date(Date.now() + deltaMs).toISOString();
}

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtAxis(n) {
  if (n == null || Number.isNaN(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = n / 1_000_000;
    return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + "M";
  }
  if (abs >= 1000) {
    const v = n / 1000;
    return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + "K";
  }
  if (abs >= 1 || abs === 0) return String(Math.round(n));
  return n.toFixed(2);
}

function fmtPct(r) {
  if (r == null || Number.isNaN(r)) return "—";
  return (r * 100).toFixed(1) + "%";
}

function fmtMs(ms) {
  if (ms == null) return "—";
  const sec = ms / 1000;
  if (sec < 60) return sec.toFixed(1) + "s";
  if (sec < 3600) return (sec / 60).toFixed(1) + "m";
  if (sec < 86400) return (sec / 3600).toFixed(1) + "h";
  return (sec / 86400).toFixed(1) + "d";
}

function fmtIso(s) {
  if (!s) return "—";
  return s.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function bucketToMs(b) {
  if (b.length === 13) return new Date(b + ":00:00Z").getTime();
  return new Date(b + "T00:00:00Z").getTime();
}

async function api(path, extra = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set("from", state.fromIso);
  u.searchParams.set("to", state.toIso);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(`${path} ${res.status}: ${body.error || ""}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return res.json();
}

// ────────────────────────────────────────────────────────────────────
// URL <-> state 同期
// ────────────────────────────────────────────────────────────────────

function parseUrl() {
  const params = new URLSearchParams(location.search);
  if (params.has("from")) state.fromIso = new Date(params.get("from")).toISOString();
  if (params.has("to")) state.toIso = new Date(params.get("to")).toISOString();
  if (params.get("refresh") === "off") state.refreshOn = false;
  let hash = location.hash.replace(/^#/, "");
  let drill = null;
  const qIdx = hash.indexOf("?");
  if (qIdx >= 0) {
    const sub = new URLSearchParams(hash.slice(qIdx + 1));
    if (sub.has("task")) drill = sub.get("task");
    hash = hash.slice(0, qIdx);
  }
  if (PAGES.includes(hash)) state.page = hash;
  state.drillTaskId = drill;
}

function pushUrl() {
  const q = new URLSearchParams();
  q.set("from", state.fromIso);
  q.set("to", state.toIso);
  if (!state.refreshOn) q.set("refresh", "off");
  let hash = "#" + state.page;
  if (state.page === "agent-strategy" && state.drillTaskId) {
    hash += "?task=" + encodeURIComponent(state.drillTaskId);
  }
  history.replaceState(null, "", "?" + q.toString() + hash);
}

// ────────────────────────────────────────────────────────────────────
// uPlot ヘルパ
// ────────────────────────────────────────────────────────────────────

function plotTimeSeries(elt, data, opts) {
  // data: [timestamps_sec[], series1[], series2[], ...]
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const series = (opts.series || []).map((s, i) => ({
    label: s.label,
    stroke: s.color,
    fill: s.fill || undefined,
    width: s.width || 2,
    points: { show: false },
  }));
  const cfg = {
    width: elt.clientWidth || 480,
    height: opts.height || 200,
    title: undefined,
    cursor: { drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      { stroke: cssVar("--fg-dim") },
      {
        stroke: cssVar("--fg-dim"),
        grid: { stroke: cssVar("--border") },
        values: (_self, splits) => splits.map(fmtAxis),
        size: 44,
      },
    ],
    series: [{ label: "time" }, ...series],
  };
  // 既存子要素を消す
  while (elt.firstChild) elt.removeChild(elt.firstChild);
  return new uPlot(cfg, data, elt);
}

function plotStackedBars(elt, buckets, series) {
  // 簡易 stacked: 縦棒を Canvas 自前で描画（uPlot stacked area で代替するのは段違い）
  // bucket: x-axis label, series: [{label, color, values[]}, ...]
  while (elt.firstChild) elt.removeChild(elt.firstChild);
  const w = elt.clientWidth || 480;
  const h = 200;
  const canvas = document.createElement("canvas");
  canvas.width = w * (window.devicePixelRatio || 1);
  canvas.height = h * (window.devicePixelRatio || 1);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  elt.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, w, h);
  if (buckets.length === 0) return;

  const padL = 50, padR = 12, padT = 8, padB = 28;
  const cw = w - padL - padR;
  const ch = h - padT - padB;
  const totalsByBucket = buckets.map((_, i) => series.reduce((s, ser) => s + (ser.values[i] || 0), 0));
  const yMax = Math.max(1, ...totalsByBucket);
  const barW = (cw / buckets.length) * 0.7;
  const xStep = cw / buckets.length;

  // grid + axis
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border");
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg-dim");
  ctx.font = "10px -apple-system, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ch * (4 - i)) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + cw, y);
    ctx.stroke();
    const v = (yMax * i) / 4;
    ctx.fillText(fmtNum(v), 4, y + 3);
  }

  buckets.forEach((b, i) => {
    let yCum = 0;
    const x = padL + i * xStep + xStep / 2 - barW / 2;
    series.forEach((ser) => {
      const v = ser.values[i] || 0;
      if (v <= 0) return;
      const hh = (v / yMax) * ch;
      const y = padT + ch - yCum - hh;
      ctx.fillStyle = ser.color;
      ctx.fillRect(x, y, barW, hh);
      yCum += hh;
    });
    if (i % Math.max(1, Math.ceil(buckets.length / 8)) === 0) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg-dim");
      ctx.fillText(b.slice(5), padL + i * xStep + xStep / 2 - 18, h - 8);
    }
  });
}

function plotHorizontalBars(elt, items, opts = {}) {
  // items: [{label, value, color?, emphasize?}]
  while (elt.firstChild) elt.removeChild(elt.firstChild);
  const w = elt.clientWidth || 480;
  const rowH = 22;
  const h = Math.max(40, items.length * rowH + 12);
  const canvas = document.createElement("canvas");
  canvas.width = w * (window.devicePixelRatio || 1);
  canvas.height = h * (window.devicePixelRatio || 1);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  elt.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  if (items.length === 0) return;
  const padL = opts.labelW || 110;
  const padR = 50;
  const max = Math.max(1, ...items.map((it) => it.value));
  ctx.font = "12px -apple-system, sans-serif";
  items.forEach((it, i) => {
    const y = 6 + i * rowH;
    const barW = ((w - padL - padR) * it.value) / max;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg");
    ctx.fillText(it.label, 4, y + 14);
    ctx.fillStyle = it.color || getComputedStyle(document.documentElement).getPropertyValue("--accent");
    ctx.fillRect(padL, y, barW, rowH - 8);
    if (it.emphasize) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--bash");
      ctx.strokeRect(padL - 1, y - 1, barW + 2, rowH - 6);
    }
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg-dim");
    ctx.fillText(fmtNum(it.value), padL + barW + 6, y + 14);
  });
}

function plotPie(elt, items) {
  while (elt.firstChild) elt.removeChild(elt.firstChild);
  const w = Math.min(elt.clientWidth || 240, 280);
  const h = w;
  const canvas = document.createElement("canvas");
  canvas.width = w * (window.devicePixelRatio || 1);
  canvas.height = h * (window.devicePixelRatio || 1);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  elt.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  const total = items.reduce((s, it) => s + it.value, 0);
  if (total === 0) return;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 8;
  let a0 = -Math.PI / 2;
  items.forEach((it) => {
    const a1 = a0 + (it.value / total) * Math.PI * 2;
    ctx.fillStyle = it.color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fill();
    a0 = a1;
  });
}

function plotHistogram(elt, hist) {
  while (elt.firstChild) elt.removeChild(elt.firstChild);
  if (!hist || !hist.bins || hist.bins.length === 0) return;
  const w = elt.clientWidth || 480;
  const h = 180;
  const canvas = document.createElement("canvas");
  canvas.width = w * (window.devicePixelRatio || 1);
  canvas.height = h * (window.devicePixelRatio || 1);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  elt.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  const padL = 36, padR = 12, padT = 8, padB = 20;
  const cw = w - padL - padR, ch = h - padT - padB;
  const max = Math.max(1, ...hist.counts);
  const barW = cw / hist.counts.length;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  hist.counts.forEach((c, i) => {
    const hh = (c / max) * ch;
    ctx.fillRect(padL + i * barW + 1, padT + ch - hh, barW - 2, hh);
  });
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg-dim");
  ctx.font = "10px -apple-system, sans-serif";
  ctx.fillText(fmtNum(hist.bins[0]), padL, h - 6);
  ctx.fillText(fmtNum(hist.max), w - padR - 36, h - 6);
}

// ────────────────────────────────────────────────────────────────────
// Page renderers
// ────────────────────────────────────────────────────────────────────

const root = () => document.getElementById("page");

function renderEmpty(msg) {
  root().innerHTML = `<div class="empty">${msg || "no data"}</div>`;
}

function renderError(e) {
  root().innerHTML = `<div class="error">Error: ${e.message}</div>`;
}

async function renderOverview() {
  root().innerHTML = `
    <div class="grid">
      <div class="card">
        <h2>Throughput (assigned / completed / aborted / forced_close)</h2>
        <div class="chart" id="ov-throughput"></div>
        <div class="legend">
          <span><i style="background:#58a6ff"></i>assigned</span>
          <span><i style="background:#30c850"></i>completed</span>
          <span><i style="background:#e0524d"></i>aborted</span>
          <span><i style="background:#d6a626"></i>forced_close</span>
        </div>
      </div>
      <div class="card">
        <h2>Tool failure rate (per hour)</h2>
        <div class="chart" id="ov-failrate"></div>
      </div>
      <div class="card">
        <h2>Tokens (per hour, stacked)</h2>
        <div class="chart" id="ov-tokens"></div>
        <div class="legend">
          <span><i style="background:#58a6ff"></i>input</span>
          <span><i style="background:#30c850"></i>output</span>
          <span><i style="background:#ab47bc"></i>cache_creation</span>
          <span><i style="background:#26c6da"></i>cache_read</span>
        </div>
      </div>
      <div class="card">
        <h2>Active tasks &amp; rate limit</h2>
        <div id="ov-side" class="kv"></div>
      </div>
    </div>
  `;
  let data;
  try { data = await api("/api/overview"); } catch (e) { return renderError(e); }
  const { throughput, toolFailureRate, tokens, activeTasks, rateLimit } = data;

  // Throughput: stacked bars
  plotStackedBars(
    document.getElementById("ov-throughput"),
    throughput.map((d) => d.bucket),
    [
      { label: "completed", color: "#30c850", values: throughput.map((d) => d.completed) },
      { label: "aborted", color: "#e0524d", values: throughput.map((d) => d.aborted) },
      { label: "forced_close", color: "#d6a626", values: throughput.map((d) => d.forced_close) },
    ],
  );

  // Failure rate sparkline
  if (toolFailureRate.length > 0) {
    const ts = toolFailureRate.map((d) => bucketToMs(d.bucket) / 1000);
    const rates = toolFailureRate.map((d) => d.rate);
    plotTimeSeries(document.getElementById("ov-failrate"), [ts, rates], {
      series: [{ label: "rate", color: "#e0524d", width: 2 }],
    });
  } else {
    document.getElementById("ov-failrate").innerHTML = '<div class="empty">no tool calls</div>';
  }

  // Tokens stacked area (use uPlot stacked)
  if (tokens.length > 0) {
    const ts = tokens.map((d) => bucketToMs(d.bucket) / 1000);
    const inp = tokens.map((d) => d.input);
    const out = tokens.map((d) => inp[tokens.indexOf(d)] + d.output);
    const cc = tokens.map((d, i) => out[i] + d.cache_creation);
    const cr = tokens.map((d, i) => cc[i] + d.cache_read);
    plotTimeSeries(document.getElementById("ov-tokens"), [ts, cr, cc, out, inp], {
      series: [
        { label: "cache_read", color: "#26c6da", fill: "rgba(38,198,218,.4)" },
        { label: "cache_creation", color: "#ab47bc", fill: "rgba(171,71,188,.4)" },
        { label: "output", color: "#30c850", fill: "rgba(48,200,80,.4)" },
        { label: "input", color: "#58a6ff", fill: "rgba(88,166,255,.4)" },
      ],
    });
  } else {
    document.getElementById("ov-tokens").innerHTML = '<div class="empty">no tokens</div>';
  }

  // Side KV
  const r5 = rateLimit.projection5h, r7 = rateLimit.projection7d;
  document.getElementById("ov-side").innerHTML = `
    <div><strong>active</strong>: ${activeTasks.count}</div>
    <div><strong>5h</strong>: ${fmtPct(r5.utilization)} <span class="risk-badge risk-${r5.risk}">${r5.risk}</span></div>
    <div><strong>7d</strong>: ${fmtPct(r7.utilization)} <span class="risk-badge risk-${r7.risk}">${r7.risk}</span></div>
  `;
}

async function renderToolUse() {
  root().innerHTML = `
    <div class="grid">
      <div class="card">
        <h2>Per-tool calls</h2>
        <div class="chart" id="tu-pertool"></div>
      </div>
      <div class="card">
        <h2>Per-tool failure rate (Bash 強調)</h2>
        <div id="tu-perfail"></div>
      </div>
      <div class="card">
        <h2>Failure timeline (Bash vs other)</h2>
        <div class="chart" id="tu-failtl"></div>
        <div class="legend">
          <span><i style="background:#f59f00"></i>Bash</span>
          <span><i style="background:#777f8c"></i>other</span>
        </div>
      </div>
      <div class="card">
        <h2>Deny timeline (PRE_TOOL_USE_DENIED rate)</h2>
        <div class="chart" id="tu-denytl"></div>
      </div>
      <div class="card" style="grid-column: 1 / -1">
        <h2>Recent failures (last 20)</h2>
        <div id="tu-recent"></div>
      </div>
    </div>
  `;
  let data;
  try { data = await api("/api/tool-use"); } catch (e) { return renderError(e); }

  // Per-tool calls: pin Bash on top, then sort by calls desc
  const perTool = pinBash(data.perTool, (r) => r.tool_name)
    .map((r) => ({
      label: r.tool_name,
      value: r.calls,
      color: r.tool_name === "Bash" ? "#f59f00" : "#58a6ff",
      emphasize: r.tool_name === "Bash",
    }));
  plotHorizontalBars(document.getElementById("tu-pertool"), perTool);

  // Per-tool failure table — pin Bash row, sort rest by total desc
  const failRows = pinBash(data.perToolFailure, (r) => r.tool_name);
  const tu = document.getElementById("tu-perfail");
  if (failRows.length === 0) {
    tu.innerHTML = '<div class="empty">no POST_TOOL_USE</div>';
  } else {
    tu.innerHTML = `<table class="data">
      <thead><tr><th>Tool</th><th class="num">Total</th><th class="num">Failures</th><th class="num">Rate</th></tr></thead>
      <tbody>
      ${failRows
        .map(
          (r) => `<tr class="${r.tool_name === "Bash" ? "bash-row" : ""}">
            <td>${r.tool_name}</td>
            <td class="num">${r.total}</td>
            <td class="num">${r.failures}</td>
            <td class="num">${fmtPct(r.rate)}</td>
          </tr>`,
        )
        .join("")}
      </tbody></table>`;
  }

  // Failure timeline 2 系列
  if (data.failureTimeline.length > 0) {
    const ts = data.failureTimeline.map((d) => bucketToMs(d.bucket) / 1000);
    const bash = data.failureTimeline.map((d) => d.bash);
    const other = data.failureTimeline.map((d) => d.other);
    plotTimeSeries(document.getElementById("tu-failtl"), [ts, bash, other], {
      series: [
        { label: "Bash", color: "#f59f00", width: 3 },
        { label: "other", color: "#777f8c", width: 2 },
      ],
    });
  } else {
    document.getElementById("tu-failtl").innerHTML = '<div class="empty">no failures</div>';
  }

  // Deny timeline
  if (data.denyTimeline.length > 0) {
    const ts = data.denyTimeline.map((d) => bucketToMs(d.bucket) / 1000);
    const rates = data.denyTimeline.map((d) => d.rate);
    plotTimeSeries(document.getElementById("tu-denytl"), [ts, rates], {
      series: [{ label: "deny rate", color: "#d6a626", width: 2 }],
    });
  } else {
    document.getElementById("tu-denytl").innerHTML = '<div class="empty">no denied</div>';
  }

  // Recent failures
  const tr = document.getElementById("tu-recent");
  if (data.recentFailures.length === 0) {
    tr.innerHTML = '<div class="empty">no recent failures</div>';
  } else {
    tr.innerHTML = `<table class="data">
      <thead><tr><th>Time</th><th>Task</th><th>Tool</th><th>Error</th></tr></thead>
      <tbody>
      ${data.recentFailures
        .map(
          (r) => `<tr>
            <td>${fmtIso(r.timestamp)}</td>
            <td>${r.task_id ?? "—"}</td>
            <td>${r.tool_name}</td>
            <td><code>${escapeHtml(r.error).slice(0, 240)}</code></td>
          </tr>`,
        )
        .join("")}
      </tbody></table>`;
  }
}

function pinBash(rows, keyFn) {
  const bash = rows.find((r) => keyFn(r) === "Bash");
  const others = rows.filter((r) => keyFn(r) !== "Bash");
  return bash ? [bash, ...others] : [...others];
}

async function renderAgentStrategy() {
  const isDrill = state.drillTaskId != null;
  root().innerHTML = `
    <div class="grid">
      <div class="card">
        <h2>Strategy distribution</h2>
        <div id="as-pie" class="canvas-wrap"></div>
        <div id="as-pie-legend" class="legend"></div>
      </div>
      <div class="card">
        <h2>Spawn timeline (per day, by role)</h2>
        <div class="chart" id="as-spawn"></div>
      </div>
      <div class="card" style="grid-column: 1 / -1">
        <h2>Per task — recent 30</h2>
        <div id="as-pertask"></div>
      </div>
      ${isDrill ? `<div class="card" style="grid-column: 1 / -1"><h2>Drill-down: ${state.drillTaskId}</h2><div id="as-drill"></div></div>` : ""}
    </div>
  `;

  let data;
  try { data = await api("/api/agent-strategy"); } catch (e) { return renderError(e); }

  // Strategy pie
  const distItems = Object.entries(data.distribution).map(([label, v]) => ({
    label,
    value: v,
    color: ROLE_COLORS[label] || "#58a6ff",
  }));
  plotPie(document.getElementById("as-pie"), distItems);
  document.getElementById("as-pie-legend").innerHTML = distItems
    .map((it) => `<span><i style="background:${it.color}"></i>${it.label} (${it.value})</span>`)
    .join("");

  // Spawn timeline: collect roles
  const roles = new Set();
  data.spawnTimeline.forEach((b) => Object.keys(b.counts).forEach((r) => roles.add(r)));
  const roleList = [...roles];
  if (data.spawnTimeline.length > 0 && roleList.length > 0) {
    plotStackedBars(
      document.getElementById("as-spawn"),
      data.spawnTimeline.map((d) => d.bucket),
      roleList.map((role) => ({
        label: role,
        color: ROLE_COLORS[role] || "#777f8c",
        values: data.spawnTimeline.map((d) => d.counts[role] || 0),
      })),
    );
  } else {
    document.getElementById("as-spawn").innerHTML = '<div class="empty">no agent spawns</div>';
  }

  // Per task table
  const tbl = document.getElementById("as-pertask");
  if (data.perTask.length === 0) {
    tbl.innerHTML = '<div class="empty">no tasks with agent spawns</div>';
  } else {
    const allRoles = new Set();
    data.perTask.forEach((r) => Object.keys(r.roles).forEach((rr) => allRoles.add(rr)));
    const cols = [...allRoles];
    tbl.innerHTML = `<table class="data">
      <thead><tr><th>Task</th><th>Label</th>${cols.map((c) => `<th class="num">${c}</th>`).join("")}</tr></thead>
      <tbody>
      ${data.perTask
        .map(
          (r) => `<tr data-task="${r.task_id}">
            <td>${r.task_id}</td>
            <td><span class="risk-badge risk-${r.label === "solo" ? "gray" : r.label === "full-cycle" ? "green" : "yellow"}">${r.label}</span></td>
            ${cols.map((c) => `<td class="num">${r.roles[c] || 0}</td>`).join("")}
          </tr>`,
        )
        .join("")}
      </tbody></table>`;
    tbl.querySelectorAll("tr[data-task]").forEach((row) => {
      row.addEventListener("click", () => {
        state.drillTaskId = row.dataset.task;
        pushUrl();
        renderAgentStrategy();
      });
    });
  }

  if (isDrill) {
    let drill;
    try {
      drill = await api(`/api/agent-strategy/${encodeURIComponent(state.drillTaskId)}`);
    } catch (e) {
      document.getElementById("as-drill").innerHTML = `<div class="error">${e.message}</div>`;
      return;
    }
    const dr = document.getElementById("as-drill");
    dr.innerHTML = `
      <div class="kv">
        <div><strong>conductor</strong>: ${drill.conductor.surface || "—"}</div>
        <div><strong>assigned</strong>: ${fmtIso(drill.conductor.assignedTs)}</div>
        <div><strong>closed</strong>: ${fmtIso(drill.conductor.closedTs)}</div>
        <div><strong>outcome</strong>: <span class="risk-badge risk-${outcomeRisk(drill.conductor.outcome)}">${drill.conductor.outcome}</span></div>
      </div>
      <table class="data" style="margin-top:10px">
        <thead><tr><th>Spawned</th><th>Role</th><th>Surface</th><th>Session</th></tr></thead>
        <tbody>
        ${drill.agents
          .map(
            (a) => `<tr>
              <td>${fmtIso(a.spawnedTs)}</td>
              <td>${a.role}</td>
              <td>${a.surface || "—"}</td>
              <td><code>${a.sessionId.slice(0, 12)}…</code></td>
            </tr>`,
          )
          .join("")}
        </tbody>
      </table>
    `;
  }
}

function outcomeRisk(o) {
  if (o === "completed") return "green";
  if (o === "open") return "gray";
  if (o === "aborted") return "yellow";
  return "red";
}

async function renderTokens() {
  root().innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: 1 / -1">
        <h2>Tokens timeline (per hour, stacked)</h2>
        <div class="chart" id="tk-tl"></div>
      </div>
      <div class="card">
        <h2>Top tasks by tokens (top 20)</h2>
        <div id="tk-top"></div>
      </div>
      <div class="card">
        <h2>Per role</h2>
        <div id="tk-role" class="canvas-wrap"></div>
        <div id="tk-role-legend" class="legend"></div>
      </div>
      <div class="card">
        <h2>Per-task histogram (input + output)</h2>
        <div id="tk-hist"></div>
        <div class="kv" id="tk-hist-kv"></div>
      </div>
    </div>
  `;
  let data;
  try { data = await api("/api/tokens"); } catch (e) { return renderError(e); }

  // Timeline stacked area
  if (data.timeline.length > 0) {
    const ts = data.timeline.map((d) => bucketToMs(d.bucket) / 1000);
    const inp = data.timeline.map((d) => d.input);
    const out = data.timeline.map((d, i) => inp[i] + d.output);
    const cc = data.timeline.map((d, i) => out[i] + d.cache_creation);
    const cr = data.timeline.map((d, i) => cc[i] + d.cache_read);
    plotTimeSeries(document.getElementById("tk-tl"), [ts, cr, cc, out, inp], {
      series: [
        { label: "cache_read", color: "#26c6da", fill: "rgba(38,198,218,.4)" },
        { label: "cache_creation", color: "#ab47bc", fill: "rgba(171,71,188,.4)" },
        { label: "output", color: "#30c850", fill: "rgba(48,200,80,.4)" },
        { label: "input", color: "#58a6ff", fill: "rgba(88,166,255,.4)" },
      ],
    });
  } else {
    document.getElementById("tk-tl").innerHTML = '<div class="empty">no api_usage</div>';
  }

  // Top tasks
  const tt = document.getElementById("tk-top");
  if (data.topTasks.length === 0) {
    tt.innerHTML = '<div class="empty">no tasks</div>';
  } else {
    tt.innerHTML = `<table class="data">
      <thead><tr><th>Task</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache</th><th class="num">Req</th></tr></thead>
      <tbody>
      ${data.topTasks
        .map(
          (r) => `<tr>
            <td>${r.task_id}</td>
            <td class="num">${fmtNum(r.input)}</td>
            <td class="num">${fmtNum(r.output)}</td>
            <td class="num">${fmtNum(r.cache)}</td>
            <td class="num">${r.requests}</td>
          </tr>`,
        )
        .join("")}
      </tbody></table>`;
  }

  // Per role pie
  const roleItems = data.perRole.map((r) => ({
    label: r.role,
    value: r.input + r.output,
    color: ROLE_COLORS[r.role] || "#777f8c",
  }));
  plotPie(document.getElementById("tk-role"), roleItems);
  document.getElementById("tk-role-legend").innerHTML = roleItems
    .map((it) => `<span><i style="background:${it.color}"></i>${it.label} (${fmtNum(it.value)})</span>`)
    .join("");

  // Histogram
  plotHistogram(document.getElementById("tk-hist"), data.perTaskHistogram);
  document.getElementById("tk-hist-kv").innerHTML = `
    <div><strong>median</strong>: ${fmtNum(data.perTaskHistogram.median)}</div>
    <div><strong>p95</strong>: ${fmtNum(data.perTaskHistogram.p95)}</div>
    <div><strong>max</strong>: ${fmtNum(data.perTaskHistogram.max)}</div>
  `;
}

const tasksSort = { col: "assigned_ts", dir: "desc" };

async function renderTasks() {
  root().innerHTML = `
    <div class="card">
      <h2>Tasks (sortable, click row → Agent Strategy drill-down)</h2>
      <div class="kv" style="margin-bottom:8px">
        <div><button id="tasks-csv">Download CSV</button></div>
      </div>
      <div id="tasks-table"></div>
    </div>
  `;
  let data;
  try { data = await api("/api/tasks"); } catch (e) { return renderError(e); }
  const cont = document.getElementById("tasks-table");
  if (data.rows.length === 0) {
    cont.innerHTML = '<div class="empty">no tasks in this period</div>';
    return;
  }
  const cols = [
    { id: "task_id", label: "Task" },
    { id: "outcome", label: "Outcome" },
    { id: "assigned_ts", label: "Assigned" },
    { id: "duration_ms", label: "Duration", num: true },
    { id: "tool_call_total", label: "Tools", num: true },
    { id: "tool_failure_rate", label: "Fail %", num: true },
    { id: "tokens", label: "Tokens", num: true },
    { id: "agent_count", label: "Agents", num: true },
    { id: "time_to_first_edit_ms", label: "1st edit", num: true },
  ];
  const sorted = [...data.rows].sort((a, b) => {
    let va, vb;
    if (tasksSort.col === "tokens") {
      va = a.tokens.input + a.tokens.output;
      vb = b.tokens.input + b.tokens.output;
    } else {
      va = a[tasksSort.col];
      vb = b[tasksSort.col];
    }
    if (va == null) va = -Infinity;
    if (vb == null) vb = -Infinity;
    if (va < vb) return tasksSort.dir === "asc" ? -1 : 1;
    if (va > vb) return tasksSort.dir === "asc" ? 1 : -1;
    return 0;
  });
  cont.innerHTML = `<table class="data">
    <thead><tr>${cols
      .map(
        (c) => `<th${c.num ? ' class="num"' : ""} data-sort="${c.id}" style="cursor:pointer">${c.label}${tasksSort.col === c.id ? (tasksSort.dir === "asc" ? " ▲" : " ▼") : ""}</th>`,
      )
      .join("")}</tr></thead>
    <tbody>
    ${sorted
      .map(
        (r) => `<tr data-task="${r.task_id}">
          <td>${r.task_id}</td>
          <td><span class="risk-badge risk-${outcomeRisk(r.outcome)}">${r.outcome}</span></td>
          <td>${fmtIso(r.assigned_ts)}</td>
          <td class="num">${fmtMs(r.duration_ms)}</td>
          <td class="num">${r.tool_call_total}</td>
          <td class="num">${fmtPct(r.tool_failure_rate)}</td>
          <td class="num">${fmtNum(r.tokens.input + r.tokens.output)}</td>
          <td class="num">${r.agent_count}</td>
          <td class="num">${fmtMs(r.time_to_first_edit_ms)}</td>
        </tr>`,
      )
      .join("")}
    </tbody></table>`;
  cont.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (tasksSort.col === col) {
        tasksSort.dir = tasksSort.dir === "asc" ? "desc" : "asc";
      } else {
        tasksSort.col = col;
        tasksSort.dir = "desc";
      }
      renderTasks();
    });
  });
  cont.querySelectorAll("tr[data-task]").forEach((row) => {
    row.addEventListener("click", () => {
      state.page = "agent-strategy";
      state.drillTaskId = row.dataset.task;
      pushUrl();
      route();
    });
  });

  document.getElementById("tasks-csv").addEventListener("click", () => {
    const csv = toCsv(sorted);
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tasks_${state.fromIso.slice(0, 10)}_${state.toIso.slice(0, 10)}.csv`;
    a.click();
  });
}

function toCsv(rows) {
  const header = ["task_id", "outcome", "assigned_ts", "closed_ts", "duration_ms", "tool_call_total", "tool_failure_rate", "tokens_input", "tokens_output", "tokens_cache", "tokens_requests", "agent_count", "time_to_first_edit_ms"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.task_id, r.outcome, r.assigned_ts, r.closed_ts ?? "",
      r.duration_ms ?? "", r.tool_call_total, r.tool_failure_rate,
      r.tokens.input, r.tokens.output, r.tokens.cache, r.tokens.requests,
      r.agent_count, r.time_to_first_edit_ms ?? "",
    ].join(","));
  }
  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ────────────────────────────────────────────────────────────────────
// Router + 初期化
// ────────────────────────────────────────────────────────────────────

function route() {
  document.querySelectorAll("#sidebar nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === state.page);
  });
  document.querySelectorAll("#topbar [data-preset]").forEach((b) => {
    const ms = PRESETS[b.dataset.preset];
    const fromMs = Date.parse(state.fromIso);
    const toMs = Date.parse(state.toIso);
    const matches = Math.abs(toMs - fromMs - ms) < 60_000;
    b.classList.toggle("active", matches);
  });
  if (state.page === "overview") return renderOverview();
  if (state.page === "tool-use") return renderToolUse();
  if (state.page === "agent-strategy") return renderAgentStrategy();
  if (state.page === "tokens") return renderTokens();
  if (state.page === "tasks") return renderTasks();
  return renderEmpty("unknown page");
}

function setupRefresh() {
  if (state.refreshTimer != null) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
  if (state.refreshOn) {
    state.refreshTimer = setInterval(() => {
      // refresh: 期間を「相対」から再計算する場合は先送りで複雑になるため、現状の from/to を保持する
      route();
    }, 30_000);
  }
}

function syncCustomInputs() {
  const f = document.getElementById("from-input");
  const t = document.getElementById("to-input");
  f.value = isoToLocalInput(state.fromIso);
  t.value = isoToLocalInput(state.toIso);
}

function isoToLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function init() {
  parseUrl();
  // sidebar nav
  document.querySelectorAll("#sidebar nav a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      state.page = a.dataset.page;
      state.drillTaskId = null;
      pushUrl();
      route();
    });
  });
  // preset chips
  document.querySelectorAll("#topbar [data-preset]").forEach((b) => {
    b.addEventListener("click", () => {
      const ms = PRESETS[b.dataset.preset];
      state.toIso = isoNow(0);
      state.fromIso = isoNow(-ms);
      pushUrl();
      syncCustomInputs();
      route();
    });
  });
  // custom datetime
  document.getElementById("apply-custom").addEventListener("click", () => {
    const f = document.getElementById("from-input").value;
    const t = document.getElementById("to-input").value;
    if (!f || !t) return;
    state.fromIso = new Date(f).toISOString();
    state.toIso = new Date(t).toISOString();
    pushUrl();
    route();
  });
  // refresh toggle
  const tog = document.getElementById("refresh-toggle");
  tog.checked = state.refreshOn;
  tog.addEventListener("change", () => {
    state.refreshOn = tog.checked;
    pushUrl();
    setupRefresh();
  });
  // health badge
  fetch("/api/health", { cache: "no-store" })
    .then((r) => r.json())
    .then((h) => {
      document.getElementById("health").innerHTML = `
        v${h.version}<br>
        port ${h.serverPort}${h.proxyPort ? " · proxy " + h.proxyPort : ""}<br>
        up ${Math.floor(h.uptimeSec / 60)}m
      `;
    })
    .catch(() => {});

  syncCustomInputs();
  route();
  setupRefresh();
}

window.addEventListener("hashchange", () => {
  parseUrl();
  route();
});
window.addEventListener("popstate", () => {
  parseUrl();
  route();
});
window.addEventListener("DOMContentLoaded", init);
