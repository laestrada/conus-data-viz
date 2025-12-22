// ---- CONFIG: update these paths/years to match your data ----
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024]; // <- change as needed
const CSV_PATH = (year) => `data/states/estrada_states_${year}.csv`;
const STATES_GEOJSON_PATH = "data/ne/us_states_simplified.geojson";

// which column to color the map by for the chosen year:
const MAP_VALUE_COL = "Total_posterior";

// which "scenario" to chart in bar + line:
const SCENARIO_SUFFIX = "_posterior";

// Exclude these sectors everywhere (bar + line + dropdown)
const EXCLUDED_SECTORS = [
  "Total",        // just in case
  "OtherAnth",        
  "Gas",   
  "Oil",   
  "Lakes",   
  "Seeps",   
  "Termites",   
  "SoilAbsorb",   
];

const SECTOR_LABELS = {
  ONG: "Oil/Gas",
  Livestock: "Livestock",
  Total_ExclSoilAbs: "Total (excl. Soil Absorb)"
};

// ------------------------------------------------------------

let map;
let statesLayer = null;

// dataByYear[year][stateName] = rowObject (strings/numbers)
const dataByYear = {};
let selectedState = null;

let sectorNames = []; // derived from CSV columns, like ["ONG","Waste",...]
let barChart = null;
let lineChart = null;

// Draw min/max error bars for bar charts
const barErrorBarsPlugin = {
  id: "barErrorBars",
  afterDatasetsDraw(chart, args, pluginOptions) {
    const { ctx } = chart;

    // we assume dataset 0 is the bar dataset
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data) return;

    const ds = chart.data.datasets[0];
    const mins = ds._errMin || [];
    const maxs = ds._errMax || [];
    if (!mins.length || !maxs.length) return;

    ctx.save();
    ctx.lineWidth = 1;

    meta.data.forEach((barElem, i) => {
      const yMin = mins[i];
      const yMax = maxs[i];
      if (yMin == null || yMax == null || Number.isNaN(yMin) || Number.isNaN(yMax)) return;

      // pixel positions
      const x = barElem.x;
      const yTop = chart.scales.y.getPixelForValue(yMax);
      const yBot = chart.scales.y.getPixelForValue(yMin);

      // whisker cap width (pixels)
      const cap = 8;

      // vertical line
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBot);
      ctx.stroke();

      // top cap
      ctx.beginPath();
      ctx.moveTo(x - cap, yTop);
      ctx.lineTo(x + cap, yTop);
      ctx.stroke();

      // bottom cap
      ctx.beginPath();
      ctx.moveTo(x - cap, yBot);
      ctx.lineTo(x + cap, yBot);
      ctx.stroke();
    });

    ctx.restore();
  }
};


function parseNumber(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function getNiceLimits(minVal, maxVal) {
  // simple padding so whiskers don't touch the border
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return { min: undefined, max: undefined };
  if (minVal === maxVal) return { min: 0, max: maxVal * 1.1 + 1e-9 };

  const pad = 0.06 * (maxVal - minVal); // 6% padding
  let lo = minVal - pad;
  let hi = maxVal + pad;

  // if emissions can't be negative, clamp at 0
  lo = Math.max(0, lo);

  return { min: lo, max: hi };
}

function deriveSectorsFromRow(row) {
  return Object.keys(row)
    .filter(k => k.endsWith(SCENARIO_SUFFIX))
    .map(k => k.replace(SCENARIO_SUFFIX, ""))
    .filter(s => s !== "Total")                 // always exclude Total
    .filter(s => !EXCLUDED_SECTORS.includes(s)) // user-defined excludes
    .sort();
}

async function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: false,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: reject
    });
  });
}

async function loadAllCSVs() {
  for (const y of YEARS) {
    const rows = await fetchCSV(CSV_PATH(y));
    dataByYear[y] = {};
    for (const r of rows) {
      const state = r.State?.trim();
      if (!state) continue;
      dataByYear[y][state] = r;
    }
    // derive sectors from first year we successfully load
    if (sectorNames.length === 0 && rows.length > 0) {
      sectorNames = deriveSectorsFromRow(rows[0]);
    }
  }
}

function makeChoroplethStyle(year, feature) {
  const stateName = feature.properties?.name || feature.properties?.NAME || feature.properties?.STATE_NAME;
  const row = dataByYear?.[year]?.[stateName];

  const v = row ? parseNumber(row[MAP_VALUE_COL]) : null;

  // very simple styling (quantiles later if you want)
  const fill = (v == null) ? "#00000000" : "#3388ff";
  const opacity = (v == null) ? 0.0 : 0.45;

  return {
    color: "#444",
    weight: 1,
    fillColor: fill,
    fillOpacity: opacity
  };
}

function recolorStates() {
  const year = Number(document.getElementById("yearSelect").value);
  if (!statesLayer) return;

  statesLayer.setStyle((feature) => makeChoroplethStyle(year, feature));
  // highlight selected
  if (selectedState) {
    statesLayer.eachLayer(layer => {
      const n = layer.feature.properties?.name || layer.feature.properties?.NAME || layer.feature.properties?.STATE_NAME;
      if (n === selectedState) {
        layer.setStyle({ weight: 2, color: "#000" });
      }
    });
  }
}

function initSelects() {
  const yearSelect = document.getElementById("yearSelect");
  yearSelect.innerHTML = "";
  for (const y of YEARS) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    yearSelect.appendChild(opt);
  }
  yearSelect.value = YEARS[YEARS.length - 1];

  const sectorSelect = document.getElementById("sectorSelect");
  sectorSelect.innerHTML = "";
  for (const s of sectorNames) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = SECTOR_LABELS[s] ?? s;
    sectorSelect.appendChild(opt);
  }
  sectorSelect.value = sectorNames[0] ?? "";

  yearSelect.addEventListener("change", () => {
    recolorStates();
    updateCharts();
  });
  sectorSelect.addEventListener("change", updateCharts);
}

function buildBarData(year, state) {
  const row = dataByYear?.[year]?.[state];
  if (!row) return { labels: [], values: [], mins: [], maxs: [] };

  const labels = sectorNames;

  const values = labels.map(s => parseNumber(row[`${s}${SCENARIO_SUFFIX}`]));
  const mins = labels.map(s => parseNumber(row[`${s}_min`]));
  const maxs = labels.map(s => parseNumber(row[`${s}_max`]));

  return { labels, values, mins, maxs };
}

function buildLineData(state, sector) {
  const labels = YEARS.map(String);

  const values = YEARS.map(y => {
    const row = dataByYear?.[y]?.[state];
    return row ? parseNumber(row[`${sector}${SCENARIO_SUFFIX}`]) : null;
  });

  const mins = YEARS.map(y => {
    const row = dataByYear?.[y]?.[state];
    return row ? parseNumber(row[`${sector}_min`]) : null;
  });

  const maxs = YEARS.map(y => {
    const row = dataByYear?.[y]?.[state];
    return row ? parseNumber(row[`${sector}_max`]) : null;
  });

  return { labels, values, mins, maxs };
}


function ensureChartDatasets() {
  if (!barChart) return;

  if (!barChart.data) barChart.data = { labels: [], datasets: [] };
  if (!Array.isArray(barChart.data.datasets) || barChart.data.datasets.length === 0) {
    barChart.data.datasets = [{
      label: `Sector${SCENARIO_SUFFIX}`,
      data: []
    }];
  }

  if (!lineChart) return;

  if (!lineChart.data) lineChart.data = { labels: [], datasets: [] };
  if (!Array.isArray(lineChart.data.datasets) || lineChart.data.datasets.length === 0) {
    lineChart.data.datasets = [{
      label: `Value${SCENARIO_SUFFIX}`,
      data: [],
      tension: 0.2,
      pointRadius: 2
    }];
  }
}

function updateCharts() {
  const year = Number(document.getElementById("yearSelect").value);
  const sector = document.getElementById("sectorSelect").value;

  document.getElementById("selectedState").textContent = selectedState ?? "(none)";

  // If charts aren't initialized yet, bail safely
  if (!barChart || !lineChart) return;

  ensureChartDatasets();

  // If no state selected, clear charts
  if (!selectedState) {
    barChart.data.labels = [];
    barChart.data.datasets[0].data = [];
    barChart.data.datasets[0]._errMin = [];
    barChart.data.datasets[0]._errMax = [];
    barChart.update();
    
    lineChart.data.labels = [];
    lineChart.data.datasets[0].data = [];
    lineChart.data.datasets[1].data = [];
    lineChart.data.datasets[2].data = [];
    lineChart.update();
    return;
  }

  // Bar chart (sector breakdown for selected year)
  const bar = buildBarData(year, selectedState);
  barChart.data.labels = bar.labels.map(s => SECTOR_LABELS[s] ?? s);
  barChart.data.datasets[0].data = bar.values;
  barChart.data.datasets[0]._errMin = bar.mins;
  barChart.data.datasets[0]._errMax = bar.maxs;
  const barFiniteMins = bar.mins.filter(v => Number.isFinite(v));
  const barFiniteMaxs = bar.maxs.filter(v => Number.isFinite(v));
  
  const overallMin = barFiniteMins.length ? Math.min(...barFiniteMins) : 0;
  const overallMax = barFiniteMaxs.length ? Math.max(...barFiniteMaxs) : Math.max(...bar.values.filter(v => Number.isFinite(v)));
  
  const lim = getNiceLimits(overallMin, overallMax);
  
  // tell Chart.js to respect these limits
  barChart.options.scales.y.min = lim.min;
  barChart.options.scales.y.max = lim.max;
  
  barChart.options.plugins.title.text = `${selectedState} – ${year}`;
  barChart.update();

  // Line
  const line = buildLineData(selectedState, sector);
  lineChart.data.labels = line.labels;
  
  // datasets: [min, max(fill), central]
  lineChart.data.datasets[0].data = line.mins;
  lineChart.data.datasets[1].data = line.maxs;
  lineChart.data.datasets[2].data = line.values;
  
  const prettySector = SECTOR_LABELS[sector] ?? sector;
  lineChart.options.plugins.title.text = `${selectedState} – ${prettySector}${SCENARIO_SUFFIX}`;
  lineChart.update();
}

function initCharts() {
  const barCtx = document.getElementById("barChart");
  barChart = new Chart(barCtx, {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        label: `Sector${SCENARIO_SUFFIX}`,
        data: [],
        _errMin: [],
        _errMax: []
      }]
    },
    options: {
      responsive: true,
      plugins: {
        title: { display: true, text: "" },
        legend: { display: false }
      },
      scales: {
        y: { beginAtZero: true }
      }
    },
    plugins: [barErrorBarsPlugin]
  });


  const lineCtx = document.getElementById("lineChart");
  lineChart = new Chart(lineCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        // min (invisible line, used for fill target)
        {
          label: "min",
          data: [],
          pointRadius: 0,
          borderWidth: 0
        },
        // max (fills down to previous dataset = min)
        {
          label: "max",
          data: [],
          pointRadius: 0,
          borderWidth: 0,
          fill: "-1",
          backgroundColor: "rgba(0,0,0,0.12)" // shaded uncertainty band
        },
        // central posterior line
        {
          label: `Value${SCENARIO_SUFFIX}`,
          data: [],
          tension: 0.2,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: { display: true, text: "" },
        legend: { display: false }
      },
      scales: {
        y: { beginAtZero: false }
      }
    }
  });
}

async function initMap() {
  map = L.map("map").setView([39, -98], 4);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 10,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const res = await fetch(STATES_GEOJSON_PATH);
  const statesGeo = await res.json();

  statesLayer = L.geoJSON(statesGeo, {
    style: (feature) => makeChoroplethStyle(Number(document.getElementById("yearSelect").value), feature),
    onEachFeature: (feature, layer) => {
      layer.on("click", () => {
        const n = feature.properties?.name || feature.properties?.NAME || feature.properties?.STATE_NAME;
        selectedState = n;
        recolorStates();
        updateCharts();
      });

      layer.on("mouseover", () => layer.setStyle({ weight: 2 }));
      layer.on("mouseout", () => recolorStates());
    }
  }).addTo(map);
}

async function main() {
  await loadAllCSVs();
  initSelects();
  initCharts();
  await initMap();
  recolorStates();
  updateCharts();
}

main();
