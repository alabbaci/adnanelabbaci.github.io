"""Shared settings for the Morocco September temperature-anomaly animation."""

from __future__ import annotations

from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_DIR / "data"
OUTPUT_DIR = PROJECT_DIR / "output"
CACHE_DIR = PROJECT_DIR / ".cache"

# ARCO-ERA5: Google's analysis-ready, cloud-optimised copy of ECMWF ERA5
# (hourly, 0.25 deg, 1940 -> present). Public, no CDS key needed.
ARCO_ERA5_URL = (
    "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/"
    "full_37-1h-0p25deg-chunk-1.zarr-v3"
)
ERA5_VARIABLE = "2m_temperature"
# Daily mean is the mean of the four synoptic hours, for both the target
# month and the baseline, so they are directly comparable.
SYNOPTIC_HOURS = (0, 6, 12, 18)

# WMO climate normal.
BASELINE_YEARS = (1991, 2020)
# The daily climatology is smoothed with a centred running mean of this many
# days, so the baseline for each September day uses days either side of it.
CLIM_WINDOW_DAYS = 11

DEFAULT_YEAR = 2026

# Morocco incl. the southern provinces (Western Sahara), with a margin so the
# ERA5 field can be interpolated right up to the coastline.
ERA5_BBOX = (-18.5, 20.0, 0.0, 37.0)  # (west, south, east, north), degrees

# Natural Earth admin-0 names merged into the map outline.
NATURAL_EARTH_URL = (
    "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_0_countries.zip"
)
BOUNDARY_ADMINS = ("Morocco", "Western Sahara")

# Lambert azimuthal equal-area centred on the country.
TARGET_CRS = "+proj=laea +lat_0=28 +lon_0=-9 +datum=WGS84 +units=m +no_defs"
DEM_RESOLUTION_M = 1000.0
# Mapzen/Tilezen Terrarium elevation tiles on AWS Open Data.
TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TERRARIUM_ZOOM = 8


def anomaly_path(year: int) -> Path:
    return DATA_DIR / f"morocco_t2m_anomaly_sep{year}.nc"


def dem_path() -> Path:
    return DATA_DIR / "morocco_dem_laea_1km.tif"


def boundary_path() -> Path:
    return DATA_DIR / "morocco_boundary.geojson"
