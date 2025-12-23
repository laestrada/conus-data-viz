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

// ==================================================

// ---- Global state ----
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

function buildBarData(year, state) {
  const row = dataByYear?.[year]?.[state];
  if (!row) return { labels: [], values: [], mins: [], maxs: [] };

  const labels = sectorNames;
  const values = labels.map(s => scaleVal(parseNumber(row[`${s}${SCENARIO_SUFFIX}`])));
  const mins   = labels.map(s => scaleVal(parseNumber(row[`${s}_min`])));
  const maxs   = labels.map(s => scaleVal(parseNumber(row[`${s}_max`])));
  return { labels, values, mins, maxs };
}

function buildLineData(state, sector) {
  const labels = YEARS.map(String);

  const values = YEARS.map(y => {
    const row = dataByYear?.[y]?.[state];
    return row ? scaleVal(parseNumber(row[`${sector}${SCENARIO_SUFFIX}`])) : null;
  });

  const mins = YEARS.map(y => {
    const row = dataByYear?.[y]?.[state];
    return row ? scaleVal(parseNumber(row[`${sector}_min`])) : null;
  });

  const maxs = YEARS.map(y => {
    const row = dataByYear?.[y]?.[state];
    return row ? scaleVal(parseNumber(row[`${sector}_max`])) : null;
  });

  return { labels, values, mins, maxs };
}

function updateCharts() {
  const year = Number(document.getElementById("yearSelect").value);
  const sector = document.getElementById("sectorSelect").value;

  document.getElementById("selectedState").textContent = selectedState ?? "(none)";
  if (!barChart || !lineChart) return;

  // no state selected: clear
  if (!selectedState) {
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
  const bar = buildBarData(year, selectedState);
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
  barChart.options.plugins.title.text = `${selectedState} – ${year}`;
  barChart.update();

  // Line chart (min/max shaded + central)
  const line = buildLineData(selectedState, sector);
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

  // Map must be initialized BEFORE grid overlay can be added
  await initMap();
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

      gridMaxT = Number(gridMaxSliderEl.value) / 1000; // [0,1]
      gridDisplayMax = dataMin + gridMaxT * (dataMax - dataMin);
      if (gridLayer && typeof gridLayer.redraw === "function") gridLayer.redraw();
      updateGridLegend();

      if (gridMaxValueEl) gridMaxValueEl.innerHTML = `${fmt(gridDisplayMax)} ${GRID_UNITS_LABEL}`;


      // redraw should now change colors reliably
      if (gridLayer && typeof gridLayer.redraw === "function") gridLayer.redraw();
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
