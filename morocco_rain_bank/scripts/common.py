"""Shared settings for the Morocco rain-bank animation."""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_DIR / "data"
OUTPUT_DIR = PROJECT_DIR / "output"
CACHE_DIR = PROJECT_DIR / ".cache"

# Terrain grid, outline and the forge3d draping code come from the September
# temperature project; seasonal ERA5 precipitation from the rainfall project.
SEPTEMBER_DIR = PROJECT_DIR.parent / "morocco_september_anomalies"
sys.path.append(str(SEPTEMBER_DIR / "scripts"))
DEM_PATH = SEPTEMBER_DIR / "data" / "morocco_dem_laea_1km.tif"
PRECIP_PATH = PROJECT_DIR.parent / "morocco_rainfall_50_years" / "data" / "morocco_precip_hydro_years_1976_2026.nc"

# The GRACE era: hydrological years (Sep-Aug) 2002/03 - 2025/26, labelled by
# the year they start in.
FIRST_YEAR = 2002
LAST_YEAR = 2025


def balance_path() -> Path:
    return DATA_DIR / f"morocco_cumulative_rain_anomaly_{FIRST_YEAR}_{LAST_YEAR + 1}.nc"


def season_label(year: int) -> str:
    """2002 -> '2002/03'."""
    return f"{year}/{(year + 1) % 100:02d}"
