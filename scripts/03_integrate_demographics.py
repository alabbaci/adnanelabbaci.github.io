"""
03_integrate_demographics.py

Attaches a population estimate to the same 200m grid used for the heat
proxy, so the final Kepler.gl scene can answer: do the most vulnerable
residents live in the most severe heat traps?

Two modes, checked in order:

1. Census mode — if data/raw/census_sections.geojson exists (an HCP
   "districts de recensement" polygon layer for Dakhla with population
   columns, see docs/demographic_data_sources.md), its population is
   apportioned onto the grid by area-weighted overlap, exactly like the
   ISTAT step in the original Torino pipeline.

2. Dasymetric proxy mode (default) — Morocco's HCP does not publish
   sub-communal census geodata openly the way ISTAT does, so out of the box
   this script distributes Dakhla's official 2024 census population
   (161,723 — RGPH 2024) across grid cells proportionally to residential
   building *volume* (footprint area x height) from the buildings layer.
   Clearly a model, not a measurement — the column is named
   population_estimate to keep that visible.

Output:
    data/processed/dakhla_demographics_grid.geojson
        grid cells carrying population_estimate (+ elderly_share and
        population_count in census mode)

Requirements: geopandas, pandas
"""

import os

import geopandas as gpd
import pandas as pd

RAW_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
PROCESSED_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed")

CENSUS_PATH = os.path.join(RAW_DIR, "census_sections.geojson")
BUILDINGS_PATH = os.path.join(PROCESSED_DIR, "dakhla_buildings_3d.geojson")
HEAT_GRID_PATH = os.path.join(PROCESSED_DIR, "dakhla_heat_grid.geojson")
OUTPUT_PATH = os.path.join(PROCESSED_DIR, "dakhla_demographics_grid.geojson")

METRIC_CRS = "EPSG:32628"
GEOGRAPHIC_CRS = "EPSG:4326"

# Dakhla municipality, RGPH 2024 (Recensement General de la Population et
# de l'Habitat). Used only in dasymetric proxy mode.
TOTAL_POPULATION = 161_723

# Overture building classes that clearly do NOT house residents. Buildings
# with an unknown class are kept: in Dakhla most unclassified footprints
# are housing.
NON_RESIDENTIAL_SUBTYPES = {
    "commercial", "industrial", "service", "transportation",
    "education", "medical", "religious", "civic", "military",
    "agricultural", "entertainment",
}

# Map your census extract's raw column codes to the names used downstream.
COLUMN_MAP = {
    "POP": "population_count",
    "POP65": "population_65plus",
}


def load_grid_metric() -> gpd.GeoDataFrame:
    heat_grid = gpd.read_file(HEAT_GRID_PATH)
    grid_metric = heat_grid.to_crs(METRIC_CRS)
    grid_metric["grid_id"] = range(len(grid_metric))
    return grid_metric


def integrate_census(grid_metric: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    print("📖 Census layer found — apportioning by area-weighted overlap...")
    census = gpd.read_file(CENSUS_PATH).rename(columns=COLUMN_MAP)
    keep = ["geometry", "population_count", "population_65plus"]
    census = census[[c for c in keep if c in census.columns]]
    census_metric = census.to_crs(METRIC_CRS)

    census_metric["section_area"] = census_metric.geometry.area
    joined = gpd.overlay(census_metric, grid_metric, how="intersection")
    joined["area_fraction"] = joined.geometry.area / joined["section_area"]

    value_cols = [c for c in ["population_count", "population_65plus"] if c in joined.columns]
    for col in value_cols:
        joined[col] = joined[col] * joined["area_fraction"]

    agg = joined.groupby("grid_id")[value_cols].sum()
    grid_metric = grid_metric.merge(agg, on="grid_id", how="left").fillna(0)

    if {"population_count", "population_65plus"} <= set(grid_metric.columns):
        grid_metric["elderly_share"] = (
            grid_metric["population_65plus"]
            / grid_metric["population_count"].replace(0, pd.NA)
        ).fillna(0)

    grid_metric["population_estimate"] = grid_metric["population_count"]
    return grid_metric


def integrate_building_volume_proxy(grid_metric: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    print("📖 No census layer at data/raw/census_sections.geojson —")
    print(f"   distributing the RGPH 2024 population ({TOTAL_POPULATION:,})")
    print("   by residential building volume (dasymetric proxy).")

    buildings = gpd.read_file(BUILDINGS_PATH).to_crs(METRIC_CRS)
    residential = buildings[
        ~buildings["subtype"].isin(NON_RESIDENTIAL_SUBTYPES)
    ].copy()

    joined = gpd.overlay(residential, grid_metric, how="intersection")
    joined["res_volume"] = joined.geometry.area * joined["calculated_height"]

    volume = joined.groupby("grid_id")["res_volume"].sum()
    grid_metric["res_volume"] = grid_metric["grid_id"].map(volume).fillna(0)

    total_volume = grid_metric["res_volume"].sum()
    grid_metric["population_estimate"] = (
        grid_metric["res_volume"] / total_volume * TOTAL_POPULATION
    ).round(1)

    return grid_metric.drop(columns=["res_volume"])


def main():
    grid_metric = load_grid_metric()

    if os.path.exists(CENSUS_PATH):
        grid_metric = integrate_census(grid_metric)
    else:
        grid_metric = integrate_building_volume_proxy(grid_metric)

    print("💾 Converting back to WGS84 and saving...")
    grid_final = grid_metric.to_crs(GEOGRAPHIC_CRS)
    grid_final.to_file(OUTPUT_PATH, driver="GeoJSON")

    print(f"✅ Success! Created: {OUTPUT_PATH}")
    print(f"   population accounted for: {grid_final['population_estimate'].sum():,.0f}")


if __name__ == "__main__":
    main()
