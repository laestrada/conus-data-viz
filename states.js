// ===================== CONFIG =====================

// CSV years + paths
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024];
const CSV_PATH = (year) => `data/states/estrada_states_${year}.csv`;

// States polygons (for clicks / outlines)
const STATES_GEOJSON_PATH = "data/ne/us_states_simplified.geojson";

// Column used to color states (keep subtle, just context)
const MAP_VALUE_COL = "Total_posterior";

// Use only *_posterior for central values
const SCENARIO_SUFFIX = "_posterior";

// Exclude these sectors everywhere (dropdown + bar + line)
const EXCLUDED_SECTORS = [
  "Total",        // just in case (we're using Total_ExclSoilAbs instead)
  "OtherAnth",
  "Gas",
  "Oil",
  "Lakes",
  "Seeps",
  "Termites",
  "SoilAbsorb",
];

// Friendly labels for UI
const SECTOR_LABELS = {
  ONG: "Oil/Gas",
  Livestock: "Livestock",
  Total_ExclSoilAbs: "Total",
};

// Grid overlay settings
const GRID_MANIFEST_PATH = "data/manifest.json";

// CSV sector -> GeoTIFF variable key in manifest.json
// (Make sure these keys match manifest.data keys)
const GRID_VAR_BY_SECTOR = {
  Total_ExclSoilAbs: "EmisCH4_Total",
  Landfills: "EmisCH4_Landfills",
  Wastewater: "EmisCH4_Wastewater",
  Livestock: "EmisCH4_Livestock",
  Coal: "EmisCH4_Coal",
  ONG: "EmisCH4_ONG",
  Rice: "EmisCH4_Rice",
  BiomassBurning: "EmisCH4_BiomassBurning",
  Wetlands: "EmisCH4_Wetlands",
  Reservoirs: "EmisCH4_Reservoirs",
  // fallback handled in code
};


// Grid appearance
const GRID_UNITS_LABEL = "kg km<sup>-2</sup> h<sup>-1</sup>";
const GRID_COLORMAP = "ylorrd";   // e.g. "viridis", "magma", "inferno", "plasma", "ylorrd"
const GRID_OPACITY = 0.60;        // lower => more transparent
const GRID_RESOLUTION = 256;
let gridLegendControl = null;

// States appearance (more transparent)
const STATES_FILL_OPACITY = 0.0;
const STATES_LINE_COLOR = "#666";
const STATES_LINE_WEIGHT = 0.8;

// Default sector to show on load
const DEFAULT_SECTOR = "Total_ExclSoilAbs";
const NATIONAL_CSV_PATH = "data/states/national_emissions.csv"; // adjust path to where you put it

// ==================================================

// ---- Global state ----
let nationalByYear = {}; // nationalByYear[year] = row object
let map;
let statesLayer = null;

let gridManifest = null;
let gridLayer = null;
let gridGeoraster = null;
let currentGridEntry = null;
let currentGridVar = null;

// Slider elements (grid max)
let gridMaxSliderEl = null;
let gridMaxValueEl = null;
let gridDisplayMax = null; // null => use entry.max
let gridMaxT = 1.0; // normalized slider position in [0,1]


// Data: dataByYear[year][stateName] = row
const dataByYear = {};
let selectedState = null;

// Sector keys derived from CSV columns
let sectorNames = [];

// Charts
let barChart = null;
let lineChart = null;

// Units toggle for charts
let unit = "Tg";
let unitFactor = 1;
let unitLabel = "Tg/yr";

// ===================== Helpers =====================
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCSV(rows) {
  return rows.map(r => r.map(csvEscape).join(",")).join("\n") + "\n";
}

function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getChartMode() {
  const el = document.querySelector('input[name="chartMode"]:checked');
  return el ? el.value : "state";
}

function centralCol(sector, mode) {
  // state uses *_posterior; national uses base column name
  return (mode === "national") ? sector : `${sector}${SCENARIO_SUFFIX}`;
}

function minCol(sector, mode) {
  // both use *_min (state columns are "Sector_min"; not "Sector_posterior_min")
  return `${sector}_min`;
}

function maxCol(sector, mode) {
  return `${sector}_max`;
}

function parseNumber(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return "";

  const abs = Math.abs(v);

  // Very small values
  if (abs < 0.001) {
    return v.toFixed(4);
  }

  // Small values
  if (abs < 1) {
    return v.toFixed(3);
  }

  // Medium values
  if (abs < 10) {
    return v.toFixed(2);
  }

  // Large values
  if (abs < 100) {
    return v.toFixed(1);
  }

  // Very large values
  return Math.round(v).toString();
}

function setUnits(newUnit) {
  unit = newUnit;
  unitFactor = (unit === "Gg") ? 1000 : 1;
  unitLabel = (unit === "Gg") ? "Gg/yr" : "Tg/yr";
}

function scaleVal(v) {
  return (v == null || !Number.isFinite(v)) ? null : v * unitFactor;
}

function getNiceLimits(minVal, maxVal) {
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return { min: undefined, max: undefined };
  if (minVal === maxVal) return { min: 0, max: maxVal * 1.1 + 1e-9 };

  const pad = 0.06 * (maxVal - minVal);
  let lo = minVal - pad;
  let hi = maxVal + pad;

  lo = Math.max(0, lo);
  return { min: lo, max: hi };
}

function deriveSectorsFromRow(row) {
  return Object.keys(row)
    .filter(k => k.endsWith(SCENARIO_SUFFIX))
    .map(k => k.replace(SCENARIO_SUFFIX, ""))
    .filter(s => s !== "Total")
    .filter(s => !EXCLUDED_SECTORS.includes(s))
    .sort();
}

// ===================== CSV Loading =====================

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
    if (sectorNames.length === 0 && rows.length > 0) {
      sectorNames = deriveSectorsFromRow(rows[0]);
    }
  }
}

async function loadNationalCSV() {
  const rows = await fetchCSV(NATIONAL_CSV_PATH);
  nationalByYear = {};
  for (const r of rows) {
    const y = Number(r.Year);
    if (!Number.isFinite(y)) continue;
    nationalByYear[y] = r;
  }
}

function currentPlaceLabel(mode) {
  return (mode === "national") ? "National" : (selectedState ?? "None");
}

function makeBarCsvRows() {
  const mode = getChartMode();
  const year = Number(document.getElementById("yearSelect").value);
  const place = currentPlaceLabel(mode);

  const bar = buildBarData(year, mode); // {labels, values, mins, maxs}
  const rows = [];

  // metadata header
  rows.push(["type", "bar"]);
  rows.push(["mode", mode]);
  rows.push(["place", place]);
  rows.push(["year", year]);
  rows.push(["units", unitLabel]);
  rows.push([]); // blank line

  // table header
  rows.push(["sector", "value", "min", "max"]);

  for (let i = 0; i < bar.labels.length; i++) {
    const sectorKey = bar.labels[i];
    const sectorName = SECTOR_LABELS[sectorKey] ?? sectorKey;
    rows.push([
      sectorName,
      bar.values[i],
      bar.mins[i],
      bar.maxs[i],
    ]);
  }

  return rows;
}

function makeLineCsvRows() {
  const mode = getChartMode();
  const sectorKey = document.getElementById("sectorSelect").value;
  const sectorName = SECTOR_LABELS[sectorKey] ?? sectorKey;
  const place = currentPlaceLabel(mode);

  const line = buildLineData(mode, sectorKey); // {labels (years), values, mins, maxs}
  const rows = [];

  // metadata header
  rows.push(["type", "timeseries"]);
  rows.push(["mode", mode]);
  rows.push(["place", place]);
  rows.push(["sector", sectorName]);
  rows.push(["units", unitLabel]);
  rows.push([]); // blank line

  // table header
  rows.push(["year", "value", "min", "max"]);

  for (let i = 0; i < line.labels.length; i++) {
    rows.push([
      line.labels[i],
      line.values[i],
      line.mins[i],
      line.maxs[i],
    ]);
  }

  return rows;
}

// ===================== States Layer =====================

function makeChoroplethStyle(year, feature) {
  const stateName = feature.properties?.name || feature.properties?.NAME || feature.properties?.STATE_NAME;
  const row = dataByYear?.[year]?.[stateName];
  const v = row ? parseNumber(row[MAP_VALUE_COL]) : null;

  const fill = (v == null) ? "#00000000" : "#3388ff";
  const opacity = (v == null) ? 0.0 : STATES_FILL_OPACITY;

  return {
    color: STATES_LINE_COLOR,
    weight: STATES_LINE_WEIGHT,
    fillColor: fill,
    fillOpacity: opacity
  };
}

function recolorStates() {
  const year = Number(document.getElementById("yearSelect").value);
  if (!statesLayer) return;

  statesLayer.setStyle((feature) => makeChoroplethStyle(year, feature));

  // highlight selected state
  if (selectedState) {
    statesLayer.eachLayer(layer => {
      const n = layer.feature.properties?.name || layer.feature.properties?.NAME || layer.feature.properties?.STATE_NAME;
      if (n === selectedState) {
        layer.setStyle({ weight: 2, color: "#000" });
      }
    });
  }
}

// ===================== Grid Layer =====================

function gridVarForSector(sector) {
  return GRID_VAR_BY_SECTOR[sector] ?? "EmisCH4_Total";
}

function syncGridMaxSliderFromEntry() {
  if (!gridMaxSliderEl || !gridMaxValueEl || !currentGridEntry) return;

  const dataMin = Number(currentGridEntry.min);
  const dataMax = Number(currentGridEntry.max);

  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMax <= dataMin) {
    gridMaxSliderEl.disabled = true;
    gridMaxValueEl.textContent = "";
    return;
  }

  gridMaxSliderEl.disabled = false;

  // If user hasn't overridden, default to max
  if (gridDisplayMax == null) gridDisplayMax = dataMax;

  // clamp within data bounds
  gridDisplayMax = Math.max(dataMin, Math.min(dataMax, gridDisplayMax));

  // compute normalized slider position
  gridMaxT = (gridDisplayMax - dataMin) / (dataMax - dataMin);
  gridMaxT = Math.max(0, Math.min(1, gridMaxT));

  gridMaxSliderEl.value = String(Math.round(gridMaxT * 1000));
  gridMaxValueEl.innerHTML = `${fmt(gridDisplayMax)} ${GRID_UNITS_LABEL}`;

}

function updateGridLegend() {
  if (!gridLegendControl || !gridLegendControl._container) return;
  if (!currentGridEntry) {
    gridLegendControl._container.innerHTML = "";
    return;
  }

  const min = Number(currentGridEntry.min ?? 0);
  const maxRaw = Number(currentGridEntry.max ?? 1);
  const max = (gridDisplayMax != null) ? Number(gridDisplayMax) : maxRaw;

  // Build gradient
  const steps = 40;
  const colors = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    colors.push(chroma.scale(GRID_COLORMAP)(t).hex());
  }
  const gradient = `linear-gradient(to right, ${colors.join(",")})`;

  // const prettyVar = currentGridVar ?? "Emissions";
  // use SECTOR_LABELS to get friendly name
  const sector = Object.keys(GRID_VAR_BY_SECTOR).find(
    key => GRID_VAR_BY_SECTOR[key] === currentGridVar
  ) || "Total_ExclSoilAbs";
  const prettyVar = SECTOR_LABELS[sector] ?? sector;

  gridLegendControl._container.innerHTML = `
    <div class="legend">
      <div class="title">${prettyVar}</div>
      <div class="units">${GRID_UNITS_LABEL}</div>
      <div class="bar" style="background:${gradient};"></div>
      <div class="labels">
        <span>${fmt(min)}</span>
        <span>${fmt(max)}</span>
      </div>
    </div>
  `;
}

async function setGridLayer(year, sector) {
  if (!gridManifest) {
    gridManifest = await (await fetch(GRID_MANIFEST_PATH)).json();
  }

  // remove existing
  if (gridLayer) {
    map.removeLayer(gridLayer);
    gridLayer = null;
    gridGeoraster = null;
  }

  const gridVar = gridVarForSector(sector);
  const entry = gridManifest?.data?.[gridVar]?.[String(year)];
  if (!entry) {
    console.warn("No GeoTIFF entry for", { gridVar, year, sector, entry });
    currentGridEntry = null;
    currentGridVar = null;
    syncGridMaxSliderFromEntry();
    return;
  }

  currentGridEntry = entry;
  currentGridVar = gridVar;

  const resp = await fetch(entry.tif);
  const arrayBuffer = await resp.arrayBuffer();
  const georaster = await parseGeoraster(arrayBuffer);
  gridGeoraster = georaster;

  // Create layer whose color mapping reads currentGridEntry + gridDisplayMax dynamically
  gridLayer = new GeoRasterLayer({
    georaster,
    opacity: GRID_OPACITY,
    resolution: GRID_RESOLUTION,
    pixelValuesToColorFn: (vals) => {
      const v = vals?.[0];
      if (v == null || Number.isNaN(v)) return null;

      const min = Number(currentGridEntry?.min ?? 0);
      const maxRaw = Number(currentGridEntry?.max ?? 1);
      const max = (gridDisplayMax != null) ? Number(gridDisplayMax) : maxRaw;
      const denom = (max - min) || 1;

      const t = Math.max(0, Math.min(1, (v - min) / denom));
      return chroma.scale(GRID_COLORMAP)(t).hex();
    }
  });

  gridLayer.addTo(map);

  // keep state outlines clickable on top
  if (statesLayer) statesLayer.bringToFront();

  // sync slider range to this layer's min/max
  syncGridMaxSliderFromEntry();
  updateGridLegend();
}

// ===================== Charts =====================

// Draw min/max error bars for bar charts (uses dataset[0]._errMin/_errMax)
const barErrorBarsPlugin = {
  id: "barErrorBars",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;

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

      const x = barElem.x;
      const yTop = chart.scales.y.getPixelForValue(yMax);
      const yBot = chart.scales.y.getPixelForValue(yMin);
      const cap = 8;

      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBot);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x - cap, yTop);
      ctx.lineTo(x + cap, yTop);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x - cap, yBot);
      ctx.lineTo(x + cap, yBot);
      ctx.stroke();
    });

    ctx.restore();
  }
};

function buildBarData(year, mode) {
  const row = (mode === "national")
    ? nationalByYear?.[year]
    : dataByYear?.[year]?.[selectedState];

  if (!row) return { labels: [], values: [], mins: [], maxs: [] };

  const labels = sectorNames;

  const values = labels.map(s => scaleVal(parseNumber(row[centralCol(s, mode)])));
  const mins   = labels.map(s => scaleVal(parseNumber(row[minCol(s, mode)])));
  const maxs   = labels.map(s => scaleVal(parseNumber(row[maxCol(s, mode)])));

  return { labels, values, mins, maxs };
}

function buildLineData(mode, sector) {
  const labels = YEARS.map(String);

  const values = YEARS.map(y => {
    const row = (mode === "national") ? nationalByYear?.[y] : dataByYear?.[y]?.[selectedState];
    return row ? scaleVal(parseNumber(row[centralCol(sector, mode)])) : null;
  });

  const mins = YEARS.map(y => {
    const row = (mode === "national") ? nationalByYear?.[y] : dataByYear?.[y]?.[selectedState];
    return row ? scaleVal(parseNumber(row[minCol(sector, mode)])) : null;
  });

  const maxs = YEARS.map(y => {
    const row = (mode === "national") ? nationalByYear?.[y] : dataByYear?.[y]?.[selectedState];
    return row ? scaleVal(parseNumber(row[maxCol(sector, mode)])) : null;
  });

  return { labels, values, mins, maxs };
}

function updateCharts() {
  const mode = getChartMode();
  const place = (mode === "national") ? "National" : selectedState;
  const year = Number(document.getElementById("yearSelect").value);
  const sector = document.getElementById("sectorSelect").value;

  document.getElementById("selectedState").textContent = (mode === "national") ? "National" : (selectedState ?? "(none)");

  if (!barChart || !lineChart) return;

  // no state selected: clear
  if (mode === "state" && !selectedState) {
    barChart.data.labels = [];
    barChart.data.datasets[0].data = [];
    barChart.data.datasets[0]._errMin = [];
    barChart.data.datasets[0]._errMax = [];
    barChart.options.plugins.title.text = "Click a state";
    barChart.update();

    lineChart.data.labels = [];
    lineChart.data.datasets[0].data = [];
    lineChart.data.datasets[1].data = [];
    lineChart.data.datasets[2].data = [];
    lineChart.options.plugins.title.text = "";
    lineChart.update();
    return;
  }

  // Bar chart
  const bar = buildBarData(year, mode);
  barChart.data.labels = bar.labels.map(s => SECTOR_LABELS[s] ?? s);
  barChart.data.datasets[0].data = bar.values;
  barChart.data.datasets[0]._errMin = bar.mins;
  barChart.data.datasets[0]._errMax = bar.maxs;

  const barFiniteMins = bar.mins.filter(v => Number.isFinite(v));
  const barFiniteMaxs = bar.maxs.filter(v => Number.isFinite(v));
  const overallMin = barFiniteMins.length ? Math.min(...barFiniteMins) : 0;
  const overallMax = barFiniteMaxs.length
    ? Math.max(...barFiniteMaxs)
    : Math.max(...bar.values.filter(v => Number.isFinite(v)));

  const lim = getNiceLimits(overallMin, overallMax);
  barChart.options.scales.y.min = lim.min;
  barChart.options.scales.y.max = lim.max;
  barChart.options.scales.y.title.text = `Emissions (${unitLabel})`;
  barChart.options.plugins.title.text = `${place} – ${year}`;
  barChart.update();

  // Line chart (min/max shaded + central)
  const line = buildLineData(mode, sector);
  lineChart.data.labels = line.labels;
  lineChart.data.datasets[0].data = line.mins;   // min
  lineChart.data.datasets[1].data = line.maxs;   // max (fills to min)
  lineChart.data.datasets[2].data = line.values; // central

  const finiteMins = line.mins.filter(v => Number.isFinite(v));
  const finiteMaxs = line.maxs.filter(v => Number.isFinite(v));
  const lmin = finiteMins.length ? Math.min(...finiteMins) : 0;
  const lmax = finiteMaxs.length ? Math.max(...finiteMaxs) : 1;
  const lim2 = getNiceLimits(lmin, lmax);

  lineChart.options.scales.y.min = lim2.min;
  lineChart.options.scales.y.max = lim2.max;
  lineChart.options.scales.y.title.text = `Emissions (${unitLabel})`;

  const prettySector = SECTOR_LABELS[sector] ?? sector;
  lineChart.options.plugins.title.text = `${place} – ${prettySector}${(mode === "state") ? SCENARIO_SUFFIX : ""}`;
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
        title: { display: true, text: "Click a state" },
        legend: { display: false }
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: `Emissions (${unitLabel})` }
        }
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
        // min
        { label: "min", data: [], pointRadius: 0, borderWidth: 0 },
        // max (shaded band down to min)
        {
          label: "max",
          data: [],
          pointRadius: 0,
          borderWidth: 0,
          fill: "-1",
          backgroundColor: "rgba(0,0,0,0.12)"
        },
        // central
        { label: `Value${SCENARIO_SUFFIX}`, data: [], tension: 0.2, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: { display: true, text: "" },
        legend: { display: false }
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: `Emissions (${unitLabel})` }
        }
      }
    }
  });
}

// ===================== UI Wiring =====================

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
    opt.value = s; // raw key for lookups
    opt.textContent = SECTOR_LABELS[s] ?? s;
    sectorSelect.appendChild(opt);
  }

  // Default to Total (if available)
  sectorSelect.value = sectorNames.includes(DEFAULT_SECTOR)
    ? DEFAULT_SECTOR
    : (sectorNames[0] ?? "");

  // Listeners for charts/states only; grid overlay wiring is in main() so we can await map
  yearSelect.addEventListener("change", () => {
    recolorStates();
    updateCharts();
  });

  sectorSelect.addEventListener("change", () => {
    updateCharts();
  });
}

function hideStatesOverlay() {
  if (statesLayer && map && map.hasLayer(statesLayer)) {
    map.removeLayer(statesLayer);
  }
}

function showStatesOverlay() {
  if (statesLayer && map && !map.hasLayer(statesLayer)) {
    statesLayer.addTo(map);
    statesLayer.bringToFront();
  }
}

// ===================== Map =====================

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

// ===================== Main =====================

async function main() {
  await loadAllCSVs();
  await loadNationalCSV();
  initSelects();

  // Units
  const unitSelect = document.getElementById("unitSelect");
  setUnits(unitSelect.value);
  unitSelect.addEventListener("change", () => {
    setUnits(unitSelect.value);
    updateCharts();
  });

  // Charts
  initCharts();
  document.getElementById("downloadBarCsv")?.addEventListener("click", () => {
    const mode = getChartMode();
    if (mode === "state" && !selectedState) {
      alert("Click a state first (or switch to National).");
      return;
    }

    const year = document.getElementById("yearSelect").value;
    const place = (mode === "national") ? "National" : selectedState;
    const filename = `bar_${mode}_${place}_${year}_${unit}.csv`.replace(/\s+/g, "_");

    downloadText(filename, toCSV(makeBarCsvRows()));
  });

  document.getElementById("downloadLineCsv")?.addEventListener("click", () => {
    const mode = getChartMode();
    if (mode === "state" && !selectedState) {
      alert("Click a state first (or switch to National).");
      return;
    }

    const sectorKey = document.getElementById("sectorSelect").value;
    const sectorName = (SECTOR_LABELS[sectorKey] ?? sectorKey).replace(/\s+/g, "_");
    const place = (mode === "national") ? "National" : selectedState;
    const filename = `timeseries_${mode}_${place}_${sectorName}_${unit}.csv`.replace(/\s+/g, "_");

    downloadText(filename, toCSV(makeLineCsvRows()));
  });

  // Map must be initialized BEFORE grid overlay can be added
  await initMap();
  if (getChartMode() === "national") hideStatesOverlay();
  recolorStates();
  updateCharts();
  gridLegendControl = L.control({ position: "bottomright" });
  gridLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div");
    div.className = "legend";
    div.innerHTML = "";
    return div;
  };
  gridLegendControl.addTo(map);

  // Prevent map drag/scroll when interacting with legend
  L.DomEvent.disableClickPropagation(gridLegendControl.getContainer());

  document.querySelectorAll('input[name="chartMode"]').forEach(el => {
    el.addEventListener("change", async () => {
      const mode = getChartMode();

      if (mode === "national") {
        hideStatesOverlay();
      } else {
        showStatesOverlay();
        recolorStates();
      }

      updateCharts();

      // Optional: keep grid outline/click layer ordering sane
      if (gridLayer && statesLayer && mode === "state") statesLayer.bringToFront();
    });
  });

  // Grid UI elements
  const yearSelect = document.getElementById("yearSelect");
  const sectorSelect = document.getElementById("sectorSelect");
  const gridToggle = document.getElementById("gridToggle");

  gridMaxSliderEl = document.getElementById("gridMaxSlider");
  gridMaxValueEl = document.getElementById("gridMaxValue");

  // Slider behavior (max only)
  if (gridMaxSliderEl) {
    gridMaxSliderEl.addEventListener("input", () => {
      if (!currentGridEntry) return;

      const dataMin = Number(currentGridEntry.min);
      const dataMax = Number(currentGridEntry.max);
      if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMax <= dataMin) return;

      gridMaxT = Number(gridMaxSliderEl.value) / 1000;
      gridDisplayMax = dataMin + gridMaxT * (dataMax - dataMin);

      if (gridMaxValueEl) gridMaxValueEl.innerHTML = `${fmt(gridDisplayMax)} ${GRID_UNITS_LABEL}`;

      if (gridLayer && typeof gridLayer.redraw === "function") gridLayer.redraw();
      updateGridLegend();
    });
  }

  async function refreshGridIfOn() {
    if (!gridToggle || !gridToggle.checked) return;
    await setGridLayer(Number(yearSelect.value), sectorSelect.value);
  }

  // Initial grid draw (if toggle is checked)
  await refreshGridIfOn();

  // Toggle on/off
  if (gridToggle) {
    gridToggle.addEventListener("change", async () => {
      if (gridToggle.checked) {
        await refreshGridIfOn();
      } else {
        if (gridLayer) map.removeLayer(gridLayer);
        gridLayer = null;
        gridGeoraster = null;
        currentGridEntry = null;
        currentGridVar = null;
        updateGridLegend();
        syncGridMaxSliderFromEntry();
      }
    });
  }

  // When year changes, refresh grid too (if enabled)
  yearSelect.addEventListener("change", async () => {
    await refreshGridIfOn();
  });

  // When sector changes, refresh grid too (if enabled)
  sectorSelect.addEventListener("change", async () => {
    await refreshGridIfOn();
  });
}

main();
