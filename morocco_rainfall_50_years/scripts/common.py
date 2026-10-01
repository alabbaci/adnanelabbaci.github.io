"""Shared settings for the Morocco 50-year rainfall animation."""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_DIR / "data"
OUTPUT_DIR = PROJECT_DIR / "output"
CACHE_DIR = PROJECT_DIR / ".cache"

# Terrain, outline and the forge3d draping code are shared with the
# September temperature project next door.
SEPTEMBER_DIR = PROJECT_DIR.parent / "morocco_september_anomalies"
sys.path.append(str(SEPTEMBER_DIR / "scripts"))
DEM_PATH = SEPTEMBER_DIR / "data" / "morocco_dem_laea_1km.tif"

# Hydrological (agricultural) years, 1 September -> 31 August, labelled by
# the year they start in: 1976 = Sept 1976 - Aug 1977.
FIRST_YEAR = 1976
LAST_YEAR = 2025
# WMO 1991-2020 normal, as hydrological years 1991/92 - 2020/21.
BASELINE_YEARS = (1991, 2020)

# Same box as the temperature project: Morocco incl. the southern provinces,
# with a margin for interpolating up to the coastline.
ERA5_BBOX = (-18.5, 20.0, 0.0, 37.0)  # (west, south, east, north), degrees

# ERA5 daily and 7-day precipitation from WeatherBench 2 (to 10 Jan 2023) and
# hourly precipitation from ARCO-ERA5 (to ~5 days ago); both public on Google
# Cloud Storage.
WB2 = "https://storage.googleapis.com/weatherbench2/datasets/"
WB2_DAILY_URL = WB2 + "era5_daily/1959-2023_01_10-full_37-1h-0p25deg-chunk-1-s2s.zarr"
WB2_WEEKLY_URL = WB2 + "era5_weekly/1959-2023_01_10-full_37-1h-0p25deg-chunk-1-s2s.zarr"
ARCO_ERA5_URL = (
    "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/"
    "full_37-1h-0p25deg-chunk-1.zarr-v3"
)


def precip_path() -> Path:
    return DATA_DIR / f"morocco_precip_hydro_years_{FIRST_YEAR}_{LAST_YEAR + 1}.nc"


def season_label(year: int) -> str:
    """1976 -> '1976/77'."""
    return f"{year}/{(year + 1) % 100:02d}"
