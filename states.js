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

function parseNumber(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
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
  if (!row) return { labels: [], values: [] };

  const labels = [];
  const values = [];
  
  for (const s of sectorNames) {
    const v = parseNumber(row[`${s}${SCENARIO_SUFFIX}`]);
    if (v == null || v === 0) continue;
    labels.push(s);
    values.push(v);
  }

//   const labels = sectorNames;
//   const values = labels.map(s => parseNumber(row[`${s}${SCENARIO_SUFFIX}`]) ?? 0);
  return { labels, values };

}

function buildLineData(state, sector) {
  const labels = YEARS.map(String);
  const values = YEARS.map(y => {
    const row = dataByYear?.[y]?.[state];
    return row ? parseNumber(row[`${sector}${SCENARIO_SUFFIX}`]) : null;
  });
  return { labels, values };
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
    barChart.options.plugins.title.text = "";

    lineChart.data.labels = [];
    lineChart.data.datasets[0].data = [];
    lineChart.options.plugins.title.text = "";

    barChart.update();
    lineChart.update();
    return;
  }

  // Bar chart (sector breakdown for selected year)
  const bar = buildBarData(year, selectedState);
  barChart.data.labels = bar.labels.map(s => SECTOR_LABELS[s] ?? s);
  barChart.data.datasets[0].data = bar.values;
  barChart.options.plugins.title.text = `${selectedState} – ${year}`;
  barChart.update();

  // Line chart (timeseries for selected sector)
  const line = buildLineData(selectedState, sector);
  lineChart.data.labels = line.labels;
  lineChart.data.datasets[0].data = line.values;
  lineChart.options.plugins.title.text = `${selectedState} – ${sector}${SCENARIO_SUFFIX}`;
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
        data: []
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
    }
  });

  const lineCtx = document.getElementById("lineChart");
  lineChart = new Chart(lineCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: `Value${SCENARIO_SUFFIX}`,
        data: [],
        tension: 0.2,
        pointRadius: 2
      }]
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
