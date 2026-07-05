"""
01_fetch_overture_geometry.py

Pulls Dakhla's 3D building geometry and walkable street network from the
Overture Maps Foundation open dataset (GeoParquet on AWS S3, anonymous
access), cleans the attributes Kepler.gl needs, and exports two GeoJSONs:

    data/processed/dakhla_buildings_3d.geojson
    data/processed/dakhla_pedestrian_network.geojson

Why Overture instead of OSMnx/Overpass (used by the original Torino
pipeline this project is adapted from): Overture bundles OSM geometry with
Microsoft/Google ML-detected building footprints, which matters in Dakhla
where hand-mapped OSM coverage is thinner than in a European city, and its
GeoParquet distribution supports efficient bbox-filtered reads without an
Overpass server.

Requirements: pyarrow, s3fs, geopandas, shapely, pandas
"""

import json
import os

import geopandas as gpd
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as ds
import s3fs
import shapely

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed")
os.makedirs(OUTPUT_DIR, exist_ok=True)

OVERTURE_RELEASE = "2026-06-17.0"
S3_ROOT = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}"

# Dakhla, Western Sahara — the city sits on the Rio de Oro peninsula.
# (lon_min, lat_min, lon_max, lat_max)
BBOX = (-16.02, 23.62, -15.86, 23.80)

# Everything except limited-access highways counts as walkable, mirroring
# OSMnx's network_type="walk" behaviour in the original Torino pipeline.
NON_WALKABLE_CLASSES = {"motorway", "trunk"}

METERS_PER_FLOOR = 3.2
# Dakhla is a predominantly low-rise city (1-2 storeys); a 15m default like
# Torino's would badly overstate unknown buildings here.
DEFAULT_HEIGHT_M = 4.5


def bbox_filter():
    xmin, ymin, xmax, ymax = BBOX
    return (
        (pc.field("bbox", "xmin") < xmax)
        & (pc.field("bbox", "xmax") > xmin)
        & (pc.field("bbox", "ymin") < ymax)
        & (pc.field("bbox", "ymax") > ymin)
    )


def read_overture(theme: str, type_: str, columns: list) -> pd.DataFrame:
    fs = s3fs.S3FileSystem(anon=True)
    dataset = ds.dataset(
        f"{S3_ROOT}/theme={theme}/type={type_}/", filesystem=fs, format="parquet"
    )
    table = dataset.to_table(filter=bbox_filter(), columns=columns)
    return table.to_pandas()


def to_gdf(df: pd.DataFrame) -> gpd.GeoDataFrame:
    geometry = shapely.from_wkb(df.pop("geometry"))
    return gpd.GeoDataFrame(df, geometry=geometry, crs="EPSG:4326")


def primary_name(names) -> str | None:
    if isinstance(names, dict):
        return names.get("primary")
    return None


def calculate_height(row: pd.Series) -> float:
    """Resolve a usable building height in meters from Overture attributes."""
    if pd.notna(row.get("height")):
        return float(row["height"])
    if pd.notna(row.get("num_floors")):
        return float(row["num_floors"]) * METERS_PER_FLOOR
    return DEFAULT_HEIGHT_M


def fetch_buildings_3d() -> gpd.GeoDataFrame:
    print("↳ Downloading building footprints (Overture buildings theme)...")
    df = read_overture(
        "buildings",
        "building",
        ["geometry", "height", "num_floors", "subtype", "class"],
    )
    buildings = to_gdf(df)

    print("↳ Cleaning building height attributes...")
    buildings["calculated_height"] = buildings.apply(calculate_height, axis=1)
    buildings["building"] = buildings["class"].fillna(
        buildings["subtype"].fillna("yes")
    )

    buildings = buildings[
        buildings.geometry.geom_type.isin(["Polygon", "MultiPolygon"])
    ].copy()

    return buildings[["geometry", "calculated_height", "building", "subtype"]]


def fetch_pedestrian_network() -> gpd.GeoDataFrame:
    print("↳ Downloading street network (Overture transportation theme)...")
    df = read_overture(
        "transportation",
        "segment",
        ["geometry", "subtype", "class", "names"],
    )
    segments = to_gdf(df)

    segments = segments[
        (segments["subtype"] == "road")
        & (~segments["class"].isin(NON_WALKABLE_CLASSES))
    ].copy()

    segments["name"] = segments["names"].apply(primary_name)
    segments = segments.rename(columns={"class": "highway"})

    return segments[["geometry", "name", "highway"]]


def main():
    print(f"🔄 Fetching Overture {OVERTURE_RELEASE} data for Dakhla {BBOX}...")

    buildings_final = fetch_buildings_3d()
    pedestrian_cleaned = fetch_pedestrian_network()

    print("💾 Saving files to disk...")
    buildings_path = os.path.join(OUTPUT_DIR, "dakhla_buildings_3d.geojson")
    pedestrian_path = os.path.join(OUTPUT_DIR, "dakhla_pedestrian_network.geojson")

    buildings_final.to_file(buildings_path, driver="GeoJSON")
    pedestrian_cleaned.to_file(pedestrian_path, driver="GeoJSON")

    print("✅ Success! Your files are ready for Kepler.gl:")
    print(f"   - {buildings_path} ({len(buildings_final)} buildings)")
    print(f"   - {pedestrian_path} ({len(pedestrian_cleaned)} segments)")


if __name__ == "__main__":
    main()
