let map;
let rasterLayer = null;
let manifest = null;
let currentGeoraster = null;
let hoverTooltip = null;
let hoverRAF = null;
let minSlider = null;
let maxSlider = null;
let displayMin = null;
let displayMax = null;


function makeLegend(min, max) {
  const scale = chroma.scale("viridis").domain([min, max]);
  const steps = 40;
  const colors = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    colors.push(scale(min + t * (max - min)).hex());
  }

  const gradient = `linear-gradient(to right, ${colors.join(",")})`;

  document.getElementById("legend").innerHTML = `
    <div>
      <div class="legend-bar" style="background:${gradient}"></div>
      <div class="legend-labels">
        <span>${min.toExponential(2)}</span>
        <span>${max.toExponential(2)}</span>
      </div>
    </div>
  `;
}

async function loadLayer(varName, year) {
  const entry = manifest?.data?.[varName]?.[year];
  if (!entry) return;

  document.getElementById("downloadNc").href = entry.nc;

  const dataMin = entry.min;
  const dataMax = entry.max;

  // Initialize display range (only on new layer)
  displayMin = dataMin;
  displayMax = dataMax;

  minSlider.min = dataMin;
  minSlider.max = dataMax;
  minSlider.value = dataMin;

  maxSlider.min = dataMin;
  maxSlider.max = dataMax;
  maxSlider.value = dataMax;

  makeLegend(displayMin, displayMax);

  if (rasterLayer) map.removeLayer(rasterLayer);

  const resp = await fetch(entry.tif);
  const arrayBuffer = await resp.arrayBuffer();
  const georaster = await parseGeoraster(arrayBuffer);
  currentGeoraster = georaster;

  rasterLayer = new GeoRasterLayer({
    georaster,
    opacity: 0.75,
    resolution: 256,
    pixelValuesToColorFn: (vals) => {
      const v = vals?.[0];
      if (v == null || Number.isNaN(v)) return null;

      // Clamp to display range
      const t = Math.max(
        0,
        Math.min(1, (v - displayMin) / (displayMax - displayMin))
      );

      return chroma.scale("viridis")(t).hex();
    }
  });

  rasterLayer.addTo(map);
}

function populateSelect(selectEl, items, defaultValue) {
  selectEl.innerHTML = "";
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = item;
    selectEl.appendChild(opt);
  }
  selectEl.value = defaultValue ?? items[0];
}

async function main() {
  // Restrict map to North America
  const northAmericaBounds = L.latLngBounds(
    [5, -170],
    [85, -45]
  );

  map = L.map("map", {
    maxBounds: northAmericaBounds,
    maxBoundsViscosity: 1.0,
    minZoom: 3,
    maxZoom: 12
  }).setView([39, -98], 4);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  hoverTooltip = L.tooltip({
    direction: "top",
    offset: [0, -8],
    opacity: 0.9
  });

  // Hover handler
  map.on("mousemove", (e) => {
    if (hoverRAF) return;
    hoverRAF = requestAnimationFrame(async () => {
      hoverRAF = null;
      if (!currentGeoraster) return;

      const { lat, lng } = e.latlng;
      const { xmin, ymax, pixelWidth, pixelHeight, width, height } = currentGeoraster;

      const col = Math.floor((lng - xmin) / pixelWidth);
      const row = Math.floor((ymax - lat) / pixelHeight);

      if (col < 0 || row < 0 || col >= width || row >= height) {
        map.closeTooltip(hoverTooltip);
        return;
      }

      let v;
      if (currentGeoraster.values) {
        v = currentGeoraster.values[0][row][col];
      } else if (currentGeoraster.getValues) {
        const values = await currentGeoraster.getValues({
          left: col,
          top: row,
          right: col + 1,
          bottom: row + 1,
          width: 1,
          height: 1
        });
        v = values?.[0]?.[0]?.[0];
      }

      if (v == null || Number.isNaN(v)) {
        map.closeTooltip(hoverTooltip);
        return;
      }

      hoverTooltip
        .setLatLng(e.latlng)
        .setContent(
          `<strong>${document.getElementById("varSelect").value}</strong><br>` +
          `Value: ${Number(v).toExponential(3)}<br>` +
          `Lat: ${lat.toFixed(3)}, Lon: ${lng.toFixed(3)}`
        )
        .addTo(map);
    });
  });

  map.on("mouseout", () => map.closeTooltip(hoverTooltip));

  manifest = await (await fetch("data/manifest.json")).json();

  const varSelect = document.getElementById("varSelect");
  const yearSelect = document.getElementById("yearSelect");

  minSlider = document.getElementById("minSlider");
  maxSlider = document.getElementById("maxSlider");
  
  function updateColorScale() {
    displayMin = Number(minSlider.value);
    displayMax = Number(maxSlider.value);

    // Prevent inverted ranges
    if (displayMin >= displayMax) return;

    makeLegend(displayMin, displayMax);

    // Force redraw
    if (rasterLayer) {
      rasterLayer.redraw();
    }
  }

  minSlider.addEventListener("input", updateColorScale);
  maxSlider.addEventListener("input", updateColorScale);

  const variables = manifest.variables ?? Object.keys(manifest.data).sort();
  const years = manifest.years ??
    Object.keys(manifest.data[variables[0]]).sort();

  populateSelect(varSelect, variables, variables[0]);
  populateSelect(yearSelect, years, years[years.length - 1]);

  const refresh = () => loadLayer(varSelect.value, yearSelect.value);
  varSelect.addEventListener("change", refresh);
  yearSelect.addEventListener("change", refresh);

  await refresh();
}

main();
