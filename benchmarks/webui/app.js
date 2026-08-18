// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

// === Marina Benchmark Web UI ===

// API base. Resolution order:
//   1. ?api=<url> query parameter (ad-hoc testing)
//   2. window.__BENCHMARK_API_URL (set in index.html or a wrapping page
//      when the webui is served from a different origin than the API)
//   3. window.location.origin (default — same-origin deployment)
const API =
  new URLSearchParams(window.location.search).get("api") ||
  window.__BENCHMARK_API_URL ||
  window.location.origin;
let allResults = [];
let benchmarks = [];
let overviewChart = null;
let detailChart = null;
let compareBarChart = null;
let compareRadarChart = null;
const activeRuns = new Map(); // id -> run state
let pollInterval = null;

// Chart.js global config
Chart.defaults.color = "#5a6a7a";
Chart.defaults.borderColor = "#1a2538";
Chart.defaults.font.family = "'Share Tech Mono', monospace";
Chart.defaults.font.size = 11;

const COLORS = {
  primary: "#00ffe7",
  secondary: "#0088ff",
  accent: "#bf00ff",
  success: "#00ff88",
  warning: "#ffcc00",
  danger: "#ff4444",
  teal: "#4ecdc4",
  coral: "#ff6b6b",
  pink: "#ff00cc",
};

const BENCHMARK_COLORS = {
  "mmlu-pro": COLORS.primary,
  ifeval: COLORS.secondary,
  truthfulqa: COLORS.teal,
  humaneval: COLORS.success,
  narrativeqa: COLORS.accent,
  "mt-bench": COLORS.pink,
  retention: COLORS.warning,
};

// === Init ===
document.addEventListener("DOMContentLoaded", async () => {
  await checkServer();
  await loadBenchmarks();
  await loadResults();
  startPolling();
});

async function checkServer() {
  try {
    const resp = await fetch(`${API}/api/health`);
    if (resp.ok) {
      document.getElementById("serverStatus").className = "status-dot online";
      document.getElementById("serverStatusLabel").textContent = "connected";
    }
  } catch {
    document.getElementById("serverStatus").className = "status-dot offline";
    document.getElementById("serverStatusLabel").textContent = "disconnected";
  }
}

async function loadBenchmarks() {
  try {
    const resp = await fetch(`${API}/api/benchmarks`);
    benchmarks = await resp.json();
    populateBenchmarkSelectors();
    renderBenchmarkInfo();
  } catch {
    /* ignore */
  }
}

async function loadResults() {
  try {
    const resp = await fetch(`${API}/api/results`);
    allResults = await resp.json();
    allResults.sort((a, b) => b.timestamp - a.timestamp);
    updateDashboard();
    updateResultsTab();
    updateCompareSelectors();
  } catch {
    /* ignore */
  }
}

function startPolling() {
  pollInterval = setInterval(async () => {
    await pollActiveRuns();
    // Refresh results every 10s
    if (Date.now() % 10000 < 2000) await loadResults();
  }, 2000);
}

// === Tab Navigation ===
function switchTab(tab) {
  for (const t of document.querySelectorAll(".tab")) t.classList.remove("active");
  for (const c of document.querySelectorAll(".tab-content")) c.classList.remove("active");
  document.querySelector(`.tab[data-tab="${tab}"]`).classList.add("active");
  document.getElementById(`tab-${tab}`).classList.add("active");
}

// === Dashboard ===
function updateDashboard() {
  const total = allResults.length;
  const avgScore = total > 0 ? allResults.reduce((s, r) => s + r.scores.overall, 0) / total : 0;
  const lastDate = total > 0 ? timeAgo(allResults[0].timestamp) : "—";

  document.getElementById("totalRuns").textContent = total;
  document.getElementById("avgScore").textContent = total > 0 ? pct(avgScore) : "—";
  document.getElementById("lastRun").textContent = lastDate;

  renderOverviewChart();
  renderRecentRuns();
}

function renderOverviewChart() {
  const canvas = document.getElementById("overviewChart");
  const msg = document.getElementById("noDataMsg");

  if (allResults.length === 0) {
    canvas.style.display = "none";
    msg.style.display = "block";
    return;
  }
  canvas.style.display = "block";
  msg.style.display = "none";

  // Group latest result per benchmark+mode
  const latest = new Map();
  for (const r of allResults) {
    const key = `${r.config.dataset}|${r.config.mode}`;
    if (!latest.has(key)) latest.set(key, r);
  }

  const labels = [];
  const scores = [];
  const colors = [];
  const borderColors = [];

  for (const [key, r] of latest) {
    const [dataset, mode] = key.split("|");
    labels.push(`${dataset} (${mode})`);
    scores.push(r.scores.overall * 100);
    const c = BENCHMARK_COLORS[dataset] || COLORS.primary;
    colors.push(`${c}40`);
    borderColors.push(c);
  }

  if (overviewChart) overviewChart.destroy();
  overviewChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Score %",
          data: scores,
          backgroundColor: colors,
          borderColor: borderColors,
          borderWidth: 1,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0d1420",
          borderColor: "#1a2538",
          borderWidth: 1,
          titleFont: { family: "'Orbitron', sans-serif", size: 11 },
          callbacks: {
            label: (ctx) => `${ctx.parsed.y.toFixed(1)}%`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: "#1a253840" },
          ticks: { callback: (v) => `${v}%` },
        },
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, maxRotation: 45 },
        },
      },
    },
  });
}

function renderRecentRuns() {
  const container = document.getElementById("recentRuns");
  if (allResults.length === 0) {
    container.innerHTML = '<div class="empty-state">No runs yet</div>';
    return;
  }

  container.innerHTML = allResults
    .slice(0, 10)
    .map(
      (r) => `
    <div class="list-item" onclick="showResultDetail('${r.config.dataset}-${r.config.mode}-${r.timestamp}')">
      <span class="mode-badge ${r.config.mode}">${r.config.mode}</span>
      <span class="list-item-name">${r.config.name}</span>
      <span class="score-badge ${scoreTier(r.scores.overall)}">${pct(r.scores.overall)}</span>
      <span class="list-item-meta">${r.metadata.answered}/${r.metadata.total} items</span>
      <span class="list-item-meta">${timeAgo(r.timestamp)}</span>
    </div>
  `,
    )
    .join("");
}

// === Results Tab ===
function updateResultsTab() {
  // Populate filter
  const benchFilter = document.getElementById("filterBenchmark");
  const seen = new Set();
  const current = benchFilter.value;
  benchFilter.innerHTML = '<option value="">All Benchmarks</option>';
  for (const r of allResults) {
    if (!seen.has(r.config.dataset)) {
      seen.add(r.config.dataset);
      benchFilter.innerHTML += `<option value="${r.config.dataset}">${r.config.name}</option>`;
    }
  }
  benchFilter.value = current;
  filterResults();
}

function filterResults() {
  const benchFilter = document.getElementById("filterBenchmark").value;
  const modeFilter = document.getElementById("filterMode").value;
  let filtered = allResults;
  if (benchFilter) filtered = filtered.filter((r) => r.config.dataset === benchFilter);
  if (modeFilter) filtered = filtered.filter((r) => r.config.mode === modeFilter);
  renderResultsTable(filtered);
}

function renderResultsTable(results) {
  const container = document.getElementById("resultsTable");
  if (results.length === 0) {
    container.innerHTML = '<div class="empty-state">No results match filters</div>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>BENCHMARK</th>
          <th>MODE</th>
          <th>SCORE</th>
          <th>ITEMS</th>
          <th>ERRORS</th>
          <th>AVG LATENCY</th>
          <th>DURATION</th>
          <th>DATE</th>
        </tr>
      </thead>
      <tbody>
        ${results
          .map(
            (r) => `
          <tr class="clickable" onclick="showResultDetail('${r.config.dataset}-${r.config.mode}-${r.timestamp}')">
            <td class="text-bright">${r.config.name}</td>
            <td><span class="mode-badge ${r.config.mode}">${r.config.mode}</span></td>
            <td><span class="score-badge ${scoreTier(r.scores.overall)}">${pct(r.scores.overall)}</span></td>
            <td>${r.metadata.answered}/${r.metadata.total}</td>
            <td class="${r.metadata.errors > 0 ? "text-danger" : "text-dim"}">${r.metadata.errors}</td>
            <td>${r.metadata.avgLatencyMs.toFixed(0)}ms</td>
            <td>${(r.duration_ms / 1000).toFixed(1)}s</td>
            <td class="text-dim">${formatDate(r.timestamp)}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function showResultDetail(key) {
  const [dataset, mode, ts] =
    key.split("-").length === 3
      ? key.split("-")
      : [
          key.substring(0, key.lastIndexOf("-", key.lastIndexOf("-") - 1)),
          key.substring(key.lastIndexOf("-", key.lastIndexOf("-") - 1) + 1, key.lastIndexOf("-")),
          key.substring(key.lastIndexOf("-") + 1),
        ];

  const result = allResults.find(
    (r) => r.config.dataset === dataset && r.config.mode === mode && String(r.timestamp) === ts,
  );

  // Fallback: try matching by composite key
  const r =
    result ||
    allResults.find((r) => {
      const k = `${r.config.dataset}-${r.config.mode}-${r.timestamp}`;
      return k === key;
    });

  if (!r) return;
  showResultDetailPanel(r);
}

function showResultDetailPanel(r) {
  const panel = document.getElementById("resultDetail");
  panel.style.display = "block";

  document.getElementById("detailTitle").textContent =
    `${r.config.name} — ${r.config.mode} — ${formatDate(r.timestamp)}`;

  // Stats
  document.getElementById("detailStats").innerHTML = `
    <div class="detail-stat-row"><span class="label">Overall Score</span><span class="value score-badge ${scoreTier(r.scores.overall)}">${pct(r.scores.overall)}</span></div>
    <div class="detail-stat-row"><span class="label">Items Answered</span><span class="value">${r.metadata.answered}/${r.metadata.total}</span></div>
    <div class="detail-stat-row"><span class="label">Errors</span><span class="value ${r.metadata.errors > 0 ? "text-danger" : ""}">${r.metadata.errors}</span></div>
    <div class="detail-stat-row"><span class="label">Timeouts</span><span class="value">${r.metadata.timeouts}</span></div>
    <div class="detail-stat-row"><span class="label">Avg Latency</span><span class="value">${r.metadata.avgLatencyMs.toFixed(0)}ms</span></div>
    <div class="detail-stat-row"><span class="label">Duration</span><span class="value">${(r.duration_ms / 1000).toFixed(1)}s</span></div>
    <div class="detail-stat-row"><span class="label">Model</span><span class="value">${r.config.model}</span></div>
    <div class="detail-stat-row"><span class="label">Endpoint</span><span class="value text-dim">${r.config.endpoint}</span></div>
    <div class="detail-stat-row"><span class="label">Concurrency</span><span class="value">${r.config.concurrency}</span></div>
  `;

  // Category breakdown chart
  renderDetailChart(r);

  // Items table
  renderDetailItems(r);

  panel.scrollIntoView({ behavior: "smooth" });
}

function renderDetailChart(r) {
  const canvas = document.getElementById("detailChart");
  const entries = Object.entries(r.scores.breakdown);

  if (entries.length <= 1) {
    canvas.parentElement.style.display = "none";
    return;
  }
  canvas.parentElement.style.display = "block";

  const labels = entries.map(([k]) => k);
  const values = entries.map(([, v]) => v * 100);
  const color = BENCHMARK_COLORS[r.config.dataset] || COLORS.primary;

  if (detailChart) detailChart.destroy();

  if (entries.length > 6) {
    // Bar chart for many categories
    detailChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: `${color}40`,
            borderColor: color,
            borderWidth: 1,
            borderRadius: 2,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            beginAtZero: true,
            max: 100,
            ticks: { callback: (v) => `${v}%` },
            grid: { color: "#1a253840" },
          },
          y: { grid: { display: false }, ticks: { font: { size: 9 } } },
        },
      },
    });
  } else {
    // Radar for few categories
    detailChart = new Chart(canvas, {
      type: "radar",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: `${color}20`,
            borderColor: color,
            borderWidth: 2,
            pointBackgroundColor: color,
            pointRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            grid: { color: "#1a253830" },
            angleLines: { color: "#1a253830" },
            ticks: { display: false },
          },
        },
      },
    });
  }
}

function renderDetailItems(r) {
  const container = document.getElementById("detailItems");
  if (!r.items || r.items.length === 0) {
    container.innerHTML = '<div class="empty-state">No item data</div>';
    return;
  }

  const hasScore = r.items.some((i) => i.score !== undefined);
  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>CORRECT</th>
          ${hasScore ? "<th>SCORE</th>" : ""}
          <th>CATEGORY</th>
          <th>LATENCY</th>
          <th>QUESTION</th>
          <th>EXPECTED</th>
          <th>ACTUAL</th>
        </tr>
      </thead>
      <tbody>
        ${r.items
          .slice(0, 200)
          .map(
            (i) => `
          <tr>
            <td class="text-dim">${i.id}</td>
            <td>${i.correct ? '<span class="text-success">✓</span>' : '<span class="text-danger">✗</span>'}</td>
            ${hasScore ? `<td>${i.score !== undefined ? i.score : "—"}</td>` : ""}
            <td class="text-dim">${i.category || "—"}</td>
            <td>${i.latencyMs.toFixed(0)}ms</td>
            <td title="${esc(i.question)}">${esc(i.question.slice(0, 60))}${i.question.length > 60 ? "…" : ""}</td>
            <td title="${esc(i.expected)}">${esc(i.expected.slice(0, 40))}${i.expected.length > 40 ? "…" : ""}</td>
            <td title="${esc(i.actual)}">${esc(i.actual.slice(0, 40))}${i.actual.length > 40 ? "…" : ""}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
    ${r.items.length > 200 ? `<div class="empty-state">Showing 200 of ${r.items.length} items</div>` : ""}
  `;
}

function closeDetail() {
  document.getElementById("resultDetail").style.display = "none";
}

// === Compare Tab ===
function updateCompareSelectors() {
  const options = allResults
    .map(
      (r) =>
        `<option value="${r.config.dataset}-${r.config.mode}-${r.timestamp}">${r.config.name} (${r.config.mode}) — ${formatDate(r.timestamp)}</option>`,
    )
    .join("");

  const base = '<option value="">Select a run...</option>';
  document.getElementById("compareA").innerHTML = base + options;
  document.getElementById("compareB").innerHTML = base + options;
}

function updateComparison() {
  const aKey = document.getElementById("compareA").value;
  const bKey = document.getElementById("compareB").value;
  const panel = document.getElementById("comparisonResults");

  if (!aKey || !bKey) {
    panel.style.display = "none";
    return;
  }

  const a = findResultByKey(aKey);
  const b = findResultByKey(bKey);
  if (!a || !b) return;

  panel.style.display = "block";
  renderCompareCharts(a, b);
  renderDeltaTable(a, b);
}

function findResultByKey(key) {
  return allResults.find((r) => `${r.config.dataset}-${r.config.mode}-${r.timestamp}` === key);
}

function renderCompareCharts(a, b) {
  // Bar chart
  const barCanvas = document.getElementById("compareBarChart");
  if (compareBarChart) compareBarChart.destroy();

  compareBarChart = new Chart(barCanvas, {
    type: "bar",
    data: {
      labels: ["Overall Score", "Items Answered", "Avg Latency (s)"],
      datasets: [
        {
          label: `${a.config.name} (${a.config.mode})`,
          data: [
            a.scores.overall * 100,
            (a.metadata.answered / a.metadata.total) * 100,
            a.metadata.avgLatencyMs / 1000,
          ],
          backgroundColor: `${COLORS.primary}40`,
          borderColor: COLORS.primary,
          borderWidth: 1,
          borderRadius: 3,
        },
        {
          label: `${b.config.name} (${b.config.mode})`,
          data: [
            b.scores.overall * 100,
            (b.metadata.answered / b.metadata.total) * 100,
            b.metadata.avgLatencyMs / 1000,
          ],
          backgroundColor: `${COLORS.accent}40`,
          borderColor: COLORS.accent,
          borderWidth: 1,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { font: { family: "'Orbitron', sans-serif", size: 10 }, padding: 16 },
        },
      },
      scales: {
        y: { beginAtZero: true, grid: { color: "#1a253840" } },
        x: { grid: { display: false } },
      },
    },
  });

  // Radar chart for category breakdown
  const radarCanvas = document.getElementById("compareRadarChart");
  if (compareRadarChart) compareRadarChart.destroy();

  const allCats = new Set([...Object.keys(a.scores.breakdown), ...Object.keys(b.scores.breakdown)]);

  if (allCats.size < 2) {
    radarCanvas.parentElement.querySelector(".panel-title").textContent =
      "CATEGORY BREAKDOWN (need 2+ categories)";
    compareRadarChart = null;
    return;
  }

  const catLabels = [...allCats];
  compareRadarChart = new Chart(radarCanvas, {
    type: "radar",
    data: {
      labels: catLabels,
      datasets: [
        {
          label: `${a.config.name} (${a.config.mode})`,
          data: catLabels.map((c) => (a.scores.breakdown[c] || 0) * 100),
          backgroundColor: `${COLORS.primary}20`,
          borderColor: COLORS.primary,
          borderWidth: 2,
          pointBackgroundColor: COLORS.primary,
        },
        {
          label: `${b.config.name} (${b.config.mode})`,
          data: catLabels.map((c) => (b.scores.breakdown[c] || 0) * 100),
          backgroundColor: `${COLORS.accent}20`,
          borderColor: COLORS.accent,
          borderWidth: 2,
          pointBackgroundColor: COLORS.accent,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { font: { family: "'Orbitron', sans-serif", size: 10 }, padding: 16 },
        },
      },
      scales: {
        r: {
          beginAtZero: true,
          max: 100,
          grid: { color: "#1a253830" },
          angleLines: { color: "#1a253830" },
          ticks: { display: false },
        },
      },
    },
  });
}

function renderDeltaTable(a, b) {
  const delta = (va, vb) => {
    const d = vb - va;
    const sign = d >= 0 ? "+" : "";
    const cls = d > 0 ? "delta-positive" : d < 0 ? "delta-negative" : "delta-neutral";
    return `<span class="${cls}">${sign}${d.toFixed(2)}</span>`;
  };

  const pctDelta = (va, vb) => {
    const d = (vb - va) * 100;
    const sign = d >= 0 ? "+" : "";
    const cls = d > 0 ? "delta-positive" : d < 0 ? "delta-negative" : "delta-neutral";
    return `<span class="${cls}">${sign}${d.toFixed(1)}%</span>`;
  };

  document.getElementById("deltaTable").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>METRIC</th>
          <th>RUN A</th>
          <th>RUN B</th>
          <th>DELTA</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="text-bright">Overall Score</td>
          <td>${pct(a.scores.overall)}</td>
          <td>${pct(b.scores.overall)}</td>
          <td>${pctDelta(a.scores.overall, b.scores.overall)}</td>
        </tr>
        <tr>
          <td class="text-bright">Answered</td>
          <td>${a.metadata.answered}/${a.metadata.total}</td>
          <td>${b.metadata.answered}/${b.metadata.total}</td>
          <td>${delta(a.metadata.answered, b.metadata.answered)}</td>
        </tr>
        <tr>
          <td class="text-bright">Errors</td>
          <td>${a.metadata.errors}</td>
          <td>${b.metadata.errors}</td>
          <td>${delta(a.metadata.errors, b.metadata.errors)}</td>
        </tr>
        <tr>
          <td class="text-bright">Avg Latency</td>
          <td>${a.metadata.avgLatencyMs.toFixed(0)}ms</td>
          <td>${b.metadata.avgLatencyMs.toFixed(0)}ms</td>
          <td>${delta(a.metadata.avgLatencyMs, b.metadata.avgLatencyMs)}ms</td>
        </tr>
        <tr>
          <td class="text-bright">Duration</td>
          <td>${(a.duration_ms / 1000).toFixed(1)}s</td>
          <td>${(b.duration_ms / 1000).toFixed(1)}s</td>
          <td>${delta(a.duration_ms / 1000, b.duration_ms / 1000)}s</td>
        </tr>
      </tbody>
    </table>
  `;
}

// === Run Tab ===
function populateBenchmarkSelectors() {
  const select = document.getElementById("runBenchmark");
  select.innerHTML = '<option value="">Select benchmark...</option>';
  for (const b of benchmarks) {
    select.innerHTML += `<option value="${b.key}">${b.name} (Phase ${b.phase}) — ${b.description}</option>`;
  }
}

function renderBenchmarkInfo() {
  document.getElementById("benchmarkInfo").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>NAME</th>
          <th>PHASE</th>
          <th>ADAPTER</th>
          <th>SCORING</th>
          <th>DESCRIPTION</th>
        </tr>
      </thead>
      <tbody>
        ${benchmarks
          .map(
            (b) => `
          <tr>
            <td class="text-bright">${b.key}</td>
            <td><span class="phase-badge ${b.phase.toLowerCase()}">${b.phase}</span></td>
            <td>${b.adapter}</td>
            <td>${b.scoring}</td>
            <td class="text-dim">${b.description}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

async function startBenchmark(event) {
  event.preventDefault();

  const benchmark = document.getElementById("runBenchmark").value;
  if (!benchmark) return;

  const config = {
    benchmark,
    mode: document.getElementById("runMode").value,
    compare: document.getElementById("runCompare").value || undefined,
    limit: document.getElementById("runLimit").value || undefined,
    concurrency: document.getElementById("runConcurrency").value || "5",
    endpoint: document.getElementById("runEndpoint").value,
    model: document.getElementById("runModel").value,
    apiKey: document.getElementById("runApiKey").value || undefined,
    seed: document.getElementById("runSeed").value || undefined,
  };

  try {
    const resp = await fetch(`${API}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    const data = await resp.json();
    if (data.error) {
      appendOutput(`Error: ${data.error}`, "error");
      return;
    }

    // Track the run
    const runId = data.runId;
    const benchName = benchmarks.find((b) => b.key === benchmark)?.name || benchmark;
    activeRuns.set(runId, {
      id: runId,
      name: benchName,
      mode: config.mode,
      status: "downloading",
      progress: 0,
      total: 0,
      startTime: Date.now(),
    });

    appendOutput(`Started: ${benchName} (${config.mode}) — Run ID: ${runId}`, "info");
    updateActiveRunsPanel();
  } catch (e) {
    appendOutput(`Failed to start: ${e.message}`, "error");
  }
}

async function pollActiveRuns() {
  if (activeRuns.size === 0) return;

  for (const [runId, run] of activeRuns) {
    try {
      const resp = await fetch(`${API}/api/run/${runId}`);
      const data = await resp.json();

      run.status = data.status;
      run.progress = data.progress || 0;
      run.total = data.total || 0;

      if (data.output) {
        for (const line of data.output) {
          appendOutput(line.text, line.type || "info");
        }
      }

      if (data.status === "complete") {
        appendOutput(`Complete: ${run.name} (${run.mode}) — Score: ${pct(data.score)}`, "success");
        activeRuns.delete(runId);
        await loadResults();
      } else if (data.status === "error") {
        appendOutput(`Error: ${run.name} — ${data.error}`, "error");
        activeRuns.delete(runId);
      }
    } catch {
      // Server may be temporarily unavailable
    }
  }

  updateActiveRunsPanel();
}

function updateActiveRunsPanel() {
  let panel = document.getElementById("activeRunsPanel");

  if (activeRuns.size === 0) {
    if (panel) panel.classList.add("hidden");
    return;
  }

  if (!panel) {
    panel = document.createElement("div");
    panel.id = "activeRunsPanel";
    panel.className = "active-runs-panel";
    document.body.appendChild(panel);
  }

  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div class="active-runs-header">
      <span class="active-runs-title">
        <span class="spinner"></span>
        ACTIVE RUNS
        <span class="active-runs-count">${activeRuns.size}</span>
      </span>
    </div>
    ${[...activeRuns.values()]
      .map(
        (r) => `
      <div class="run-row">
        <span class="run-row-name">${r.name}</span>
        <span class="run-row-mode"><span class="mode-badge ${r.mode}">${r.mode}</span></span>
        <div class="run-row-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${r.total > 0 ? (r.progress / r.total) * 100 : 0}%"></div>
          </div>
          <span class="progress-label">${r.total > 0 ? `${r.progress}/${r.total}` : "..."}</span>
        </div>
        <span class="run-row-status ${r.status}">${r.status.toUpperCase()}</span>
      </div>
    `,
      )
      .join("")}
  `;
}

function appendOutput(text, type = "info") {
  const container = document.getElementById("runOutput");
  // Remove "waiting" message
  const waiting = container.querySelector(".dim");
  if (waiting?.textContent.includes("Waiting")) waiting.remove();

  const line = document.createElement("div");
  line.className = `terminal-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;

  // Keep max 200 lines
  while (container.children.length > 200) container.removeChild(container.firstChild);
}

// === Utilities ===
function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function scoreTier(score) {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "mid";
  return "low";
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
