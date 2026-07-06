"""
02_generate_heat_grid.py

Builds a uniform 200m x 200m spatial grid over the city, intersects it with
the 3D building footprints to compute urban density per cell, and derives a
temperature_proxy attribute (a density-driven stand-in for true LST/MRT).

Usage:
    python scripts/02_generate_heat_grid.py [dakhla|rabat]

Input:
    data/processed/<city>_buildings_3d.geojson  (from 01_fetch_osm_geometry.py)

Output:
    data/processed/<city>_heat_grid.geojson

Note: this density-based proxy is a placeholder. For a research-grade
analysis, replace temperature_proxy with actual Land Surface Temperature
(Landsat 8/9 or Sentinel-3, see docs/heat_data_sources.md) or a SOLWEIG
Mean Radiant Temperature simulation. On the Moroccan Atlantic coast the
ocean moderates ambient temperature, but dense mineral urban fabric with
little vegetation still traps heat locally — which is exactly what the
density proxy expresses.

Requirements: geopandas, numpy, shapely
"""

import os

import geopandas as gpd
import numpy as np
from shapely.geometry import box

from city_config import (
    GEOGRAPHIC_CRS,
    GRID_SIZE_METERS,
    MAX_DENSITY_BONUS_C,
    get_city,
)

INPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed")

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
    slug, city = get_city()
    buildings_path = os.path.join(INPUT_DIR, f"{slug}_buildings_3d.geojson")
    output_path = os.path.join(INPUT_DIR, f"{slug}_heat_grid.geojson")

    print(f"📖 Loading {city['label']} buildings data...")
    buildings = gpd.read_file(buildings_path)

    print(f"🌐 Reprojecting data to metric CRS ({city['metric_crs']})...")
    buildings_metric = buildings.to_crs(city["metric_crs"])

    print(f"📐 Creating a uniform spatial grid mesh ({GRID_SIZE_METERS}m cells)...")
    grid = build_grid(buildings_metric.total_bounds, GRID_SIZE_METERS, buildings_metric.crs)

    print("🔬 Computing urban density per cell (spatial intersection)...")
    joined = gpd.overlay(buildings_metric, grid, how="intersection")
    joined["bld_area"] = joined.geometry.area

    building_areas = joined.groupby("grid_id")["bld_area"].sum()
    grid["total_building_area"] = grid["grid_id"].map(building_areas).fillna(0)
    grid["cell_area"] = grid.geometry.area
    grid["urban_density"] = grid["total_building_area"] / grid["cell_area"]

    grid["temperature_proxy"] = city["baseline_temp_c"] + (
        grid["urban_density"] * MAX_DENSITY_BONUS_C
    )

    grid_filtered = grid[grid["urban_density"] > MIN_DENSITY_THRESHOLD].copy()

    print("💾 Converting back to WGS84 and saving...")
    grid_final = grid_filtered.to_crs(GEOGRAPHIC_CRS)
    grid_final = grid_final[["geometry", "urban_density", "temperature_proxy"]]
    grid_final.to_file(output_path, driver="GeoJSON", COORDINATE_PRECISION=6)

    print(f"✅ Success! Created {len(grid_final)} grid cells: {output_path}")


if __name__ == "__main__":
    main()
