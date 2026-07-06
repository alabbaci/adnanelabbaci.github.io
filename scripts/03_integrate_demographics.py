"""
03_integrate_demographics.py  (Dakhla edition)

Joins census-district demographic data (population, elderly share) onto the
same 200m grid used for the heat proxy, so the final scene can answer: do
the most vulnerable residents live in the most severe heat traps?

Expected input:
    data/raw/hcp_census_districts.geojson
        - a polygon layer of census districts ("districts de recensement")
          for the Dakhla-Oued Ed-Dahab region from Morocco's HCP
          (Haut-Commissariat au Plan) RGPH 2024 census, containing at least
          a total-population column and a 60+/65+ population column
          (adjust COLUMN_MAP below to your extract's column names).
          See docs/demographic_data_sources.md.

Output:
    data/processed/dakhla_demographics_grid.geojson
        grid cells carrying population_count, elderly_share

This step is OPTIONAL: HCP census geodata is not openly downloadable at
district granularity, so the script exits gracefully when the input layer
is absent and the rest of the pipeline (steps 1-2 and the visualization)
works without it.

Requirements: geopandas, pandas
"""

import os
import sys

import geopandas as gpd
import pandas as pd

RAW_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
PROCESSED_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed")

CENSUS_PATH = os.path.join(RAW_DIR, "hcp_census_districts.geojson")
HEAT_GRID_PATH = os.path.join(PROCESSED_DIR, "dakhla_heat_grid.geojson")
OUTPUT_PATH = os.path.join(PROCESSED_DIR, "dakhla_demographics_grid.geojson")

METRIC_CRS = "EPSG:32628"
GEOGRAPHIC_CRS = "EPSG:4326"

# Map the raw census column names to readable names used downstream.
# Update these to match the actual columns in your HCP extract.
COLUMN_MAP = {
    "POP_TOTAL": "population_count",
    "POP_60_PLUS": "population_65plus",
}


def load_census(path: str) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(path)
    gdf = gdf.rename(columns=COLUMN_MAP)
    keep_cols = ["geometry", "population_count", "population_65plus"]
    return gdf[[c for c in keep_cols if c in gdf.columns]]


def main():
    if not os.path.exists(CENSUS_PATH):
        print(
            f"⏭️  Skipping demographics: no census layer found at {CENSUS_PATH}.\n"
            "   Place an HCP RGPH census-district polygon layer for Dakhla there\n"
            "   (see docs/demographic_data_sources.md) and re-run this script.\n"
            "   Steps 1-2 outputs and the visualization work without it."
        )
        sys.exit(0)

    print("📖 Loading HCP demographic data and the heat grid...")
    census = load_census(CENSUS_PATH)
    heat_grid = gpd.read_file(HEAT_GRID_PATH)

    census_metric = census.to_crs(METRIC_CRS)
    grid_metric = heat_grid.to_crs(METRIC_CRS)
    grid_metric["grid_id"] = range(len(grid_metric))

    print("🔬 Apportioning population onto the heat grid by area overlap...")
    census_metric["section_area"] = census_metric.geometry.area
    joined = gpd.overlay(census_metric, grid_metric, how="intersection")
    joined["overlap_area"] = joined.geometry.area
    joined["area_fraction"] = joined["overlap_area"] / joined["section_area"]

    for col in ["population_count", "population_65plus"]:
        if col in joined.columns:
            joined[col] = joined[col] * joined["area_fraction"]

    agg = joined.groupby("grid_id")[
        [c for c in ["population_count", "population_65plus"] if c in joined.columns]
    ].sum()

    grid_metric = grid_metric.merge(agg, on="grid_id", how="left").fillna(0)

    if "population_count" in grid_metric.columns and "population_65plus" in grid_metric.columns:
        grid_metric["elderly_share"] = (
            grid_metric["population_65plus"] / grid_metric["population_count"].replace(0, pd.NA)
        ).fillna(0)

    print("💾 Converting back to WGS84 and saving...")
    grid_final = grid_metric.to_crs(GEOGRAPHIC_CRS)
    grid_final.to_file(OUTPUT_PATH, driver="GeoJSON")

    print(f"✅ Success! Created: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
