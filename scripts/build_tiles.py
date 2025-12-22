import json
from pathlib import Path

import numpy as np
import xarray as xr
import rasterio
from rasterio.transform import from_bounds
from rasterio.enums import Resampling

# ---------- user settings ----------
IN_DIR = Path("data/nc")   # netcdf files
OUT_DIR = Path("data")     # geotiffs + manifest.json

# Put the variables you want in the dropdown here:
VARS = [
    "EmisCH4_Total",
    "EmisCH4_Oil",
    "EmisCH4_Gas",
    "EmisCH4_Coal",
    "EmisCH4_Livestock",
    "EmisCH4_Wastewater",
    "EmisCH4_Landfills",
    "EmisCH4_Rice",
    "EmisCH4_Reservoirs",
    "EmisCH4_Wetlands",
]

# optional: clamp tiny negatives to 0 (often numerical noise)
CLAMP_NEG_TO_ZERO = True
# ----------------------------------

OUT_DIR.mkdir(parents=True, exist_ok=True)

def infer_year(path: Path) -> str:
    for token in path.stem.split("_"):
        if token.isdigit() and len(token) == 4:
            return token
    tail = path.stem[-4:]
    if tail.isdigit():
        return tail
    raise ValueError(f"Couldn't infer year from {path.name}")

manifest = {
    "variables": VARS,
    "years": [],
    "data": {},  # data[var][year] = {tif,nc,min,max}
}

for nc_path in sorted(IN_DIR.glob("*.nc")):
    year = infer_year(nc_path)
    if year not in manifest["years"]:
        manifest["years"].append(year)

    ds = xr.open_dataset(nc_path)

    lon = ds["lon"].values
    lat = ds["lat"].values
    left, right = float(lon.min()), float(lon.max())
    bottom, top = float(lat.min()), float(lat.max())

    for var in VARS:
        if var not in ds:
            print(f"Skipping {var} (not in {nc_path.name})")
            continue

        da = ds[var]
        arr = da.values.astype("float32")

        if CLAMP_NEG_TO_ZERO:
            arr = np.where(np.isfinite(arr) & (arr < 0), 0.0, arr)

        # Ensure north-up
        if lat[0] < lat[-1]:
            arr = arr[::-1, :]

        height, width = arr.shape
        transform = from_bounds(left, bottom, right, top, width, height)

        tif_name = f"{var}_{year}.tif"
        tif_path = OUT_DIR / tif_name

        profile = dict(
            driver="GTiff",
            height=height,
            width=width,
            count=1,
            dtype="float32",
            crs="EPSG:4326",
            transform=transform,
            tiled=True,
            blockxsize=256,
            blockysize=256,
            compress="DEFLATE",
            predictor=3,
        )

        with rasterio.open(tif_path, "w", **profile) as dst:
            dst.write(arr, 1)
            dst.build_overviews([2, 4, 8, 16], Resampling.average)
            dst.update_tags(ns="rio_overview", resampling="average")

        vmin = float(np.nanmin(arr))
        vmax = float(np.nanmax(arr))

        manifest["data"].setdefault(var, {})
        manifest["data"][var][year] = {
            "tif": f"data/{tif_name}",
            "nc": f"data/nc/{nc_path.name}",
            "min": vmin,
            "max": vmax,
        }

        print(f"Wrote {tif_path}")

    ds.close()

manifest["years"] = sorted(manifest["years"])
(OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
print("Wrote data/manifest.json")
