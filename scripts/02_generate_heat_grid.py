"""
02_generate_heat_grid.py  (Dakhla edition)

Builds a uniform 200m x 200m spatial grid over Dakhla, intersects it with the
3D building footprints to compute urban density per cell, and derives a
temperature_proxy attribute (a density-driven stand-in for true LST/MRT).

Input:
    data/processed/dakhla_buildings_3d.geojson  (from 01_fetch_osm_geometry.py)

Output:
    data/processed/dakhla_heat_grid.geojson

Note: this density-based proxy is a placeholder. For a research-grade
analysis, replace temperature_proxy with actual Land Surface Temperature
(Landsat 8/9 or Sentinel-3, see docs/heat_data_sources.md) or a SOLWEIG
Mean Radiant Temperature simulation. In Dakhla the ocean moderates ambient
temperature, but dense mineral urban fabric with no vegetation still traps
heat locally — which is exactly what the density proxy expresses.

Requirements: geopandas, numpy, shapely
"""

import os

import geopandas as gpd
import numpy as np
from shapely.geometry import box

INPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed")
BUILDINGS_PATH = os.path.join(INPUT_DIR, "dakhla_buildings_3d.geojson")
OUTPUT_PATH = os.path.join(INPUT_DIR, "dakhla_heat_grid.geojson")

GRID_SIZE_METERS = 200
METRIC_CRS = "EPSG:32628"  # UTM Zone 28N, appropriate for Dakhla
GEOGRAPHIC_CRS = "EPSG:4326"  # required by Kepler.gl / deck.gl

# Dakhla's coastal-desert baseline: ocean-moderated summer ambient (~26-27C),
# with the density bonus expressing heat trapped by the unvegetated built
# fabric of the dense old town.
BASELINE_TEMP_C = 26.0
MAX_DENSITY_BONUS_C = 6.5
MIN_DENSITY_THRESHOLD = 0.01


def build_grid(bounds, grid_size: int, crs) -> gpd.GeoDataFrame:
    xmin, ymin, xmax, ymax = bounds
    x_coords = np.arange(xmin, xmax, grid_size)
    y_coords = np.arange(ymin, ymax, grid_size)

    cells = [
        box(x, y, x + grid_size, y + grid_size)
        for x in x_coords
        for y in y_coords
    ]

    grid = gpd.GeoDataFrame(geometry=cells, crs=crs)
    # Explicit unique id so the later groupby is unambiguous
    grid["grid_id"] = range(len(grid))
    return grid


def main():
    print("📖 Loading Dakhla buildings data...")
    buildings = gpd.read_file(BUILDINGS_PATH)

    print(f"🌐 Reprojecting data to metric CRS ({METRIC_CRS})...")
    buildings_metric = buildings.to_crs(METRIC_CRS)

    print(f"📐 Creating a uniform spatial grid mesh ({GRID_SIZE_METERS}m cells)...")
    grid = build_grid(buildings_metric.total_bounds, GRID_SIZE_METERS, buildings_metric.crs)

    print("🔬 Computing urban density per cell (spatial intersection)...")
    joined = gpd.overlay(buildings_metric, grid, how="intersection")
    joined["bld_area"] = joined.geometry.area

    building_areas = joined.groupby("grid_id")["bld_area"].sum()
    grid["total_building_area"] = grid["grid_id"].map(building_areas).fillna(0)
    grid["cell_area"] = grid.geometry.area
    grid["urban_density"] = grid["total_building_area"] / grid["cell_area"]

    grid["temperature_proxy"] = BASELINE_TEMP_C + (
        grid["urban_density"] * MAX_DENSITY_BONUS_C
    )

    grid_filtered = grid[grid["urban_density"] > MIN_DENSITY_THRESHOLD].copy()

    print("💾 Converting back to WGS84 and saving...")
    grid_final = grid_filtered.to_crs(GEOGRAPHIC_CRS)
    grid_final = grid_final[["geometry", "urban_density", "temperature_proxy"]]
    grid_final.to_file(OUTPUT_PATH, driver="GeoJSON")

    print(f"✅ Success! Created {len(grid_final)} grid cells: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
