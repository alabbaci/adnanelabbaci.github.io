"""
fetch_casablanca.py

Pulls central Casablanca's building footprints and street network from the
Overture Maps Foundation open dataset (GeoParquet on AWS S3, anonymous
access) and exports two GeoJSONs for the packer:

    casablanca-night-grid/datasets/casablanca_buildings.geojson
    casablanca-night-grid/datasets/casablanca_roads.geojson

Why Overture instead of OSMnx/Overpass (used by the Auckland original this
project is adapted from): Overture bundles OSM geometry with Microsoft- and
Google-ML-detected footprints, which matters in Casablanca where hand-mapped
OSM coverage is patchier than in Auckland, and many of those ML footprints
carry measured heights (Google Open Buildings 2.5D) that OSM lacks here.

Requirements: pyarrow, s3fs, geopandas, shapely, pandas
"""

import os

import geopandas as gpd
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as ds
import s3fs
import shapely

DATASETS = os.path.join(os.path.dirname(__file__), "..", "datasets")
os.makedirs(DATASETS, exist_ok=True)

OVERTURE_RELEASE = "2026-06-17.0"
S3_ROOT = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}"

# Central Casablanca: the old medina, the Art-Deco downtown around
# Boulevard Mohammed V / Place des Nations Unies, Casa-Port, and the
# Hassan II Mosque on the corniche.  (lon_min, lat_min, lon_max, lat_max)
BBOX = (-7.645, 33.582, -7.595, 33.618)

# Overture transportation classes to keep for the neon road grid — the
# drivable + main pedestrian fabric; footways/service alleys would read as
# noise at city scale.
ROAD_CLASSES = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "residential", "unclassified", "living_street", "pedestrian",
}


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


def fetch_buildings() -> gpd.GeoDataFrame:
    print("fetching buildings (Overture buildings theme) ...")
    df = read_overture(
        "buildings",
        "building",
        ["geometry", "height", "num_floors", "subtype", "class", "names"],
    )
    b = to_gdf(df)
    b = b[b.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    # clip to the bbox proper (the parquet filter only tests bbox overlap)
    b = b[b.geometry.intersects(shapely.box(*BBOX))]
    b["name"] = b["names"].apply(
        lambda n: n.get("primary") if isinstance(n, dict) else None
    )
    n_h = int(b["height"].notna().sum())
    n_f = int((b["height"].isna() & b["num_floors"].notna()).sum())
    print(f"  {len(b)} footprints — {n_h} with measured height, "
          f"{n_f} more with floor counts")
    return b[["geometry", "height", "num_floors", "subtype", "class", "name"]]


def fetch_roads() -> gpd.GeoDataFrame:
    print("fetching roads (Overture transportation theme) ...")
    df = read_overture(
        "transportation",
        "segment",
        ["geometry", "subtype", "class"],
    )
    r = to_gdf(df)
    r = r[(r["subtype"] == "road") & (r["class"].isin(ROAD_CLASSES))].copy()
    r = r[r.geometry.intersects(shapely.box(*BBOX))]
    r = gpd.GeoDataFrame(
        r[["class"]], geometry=r.geometry.clip_by_rect(*BBOX), crs="EPSG:4326"
    )
    r = r[~r.geometry.is_empty]
    print(f"  {len(r)} road segments kept ({', '.join(sorted(ROAD_CLASSES))})")
    return r


def main():
    print(f"Overture {OVERTURE_RELEASE}, bbox {BBOX}")
    buildings = fetch_buildings()
    roads = fetch_roads()
    bp = os.path.join(DATASETS, "casablanca_buildings.geojson")
    rp = os.path.join(DATASETS, "casablanca_roads.geojson")
    buildings.to_file(bp, driver="GeoJSON")
    roads.to_file(rp, driver="GeoJSON")
    print(f"wrote {bp} ({len(buildings)} buildings)")
    print(f"wrote {rp} ({len(roads)} segments)")


if __name__ == "__main__":
    main()
