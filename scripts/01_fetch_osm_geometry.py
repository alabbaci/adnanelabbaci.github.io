"""
01_fetch_osm_geometry.py  (Dakhla edition)

Pulls Dakhla's 3D building geometry and pedestrian-accessible street network
and exports two GeoJSONs:

    data/processed/dakhla_buildings_3d.geojson
    data/processed/dakhla_pedestrian_network.geojson

Data source: Overture Maps (https://overturemaps.org/), which merges
OpenStreetMap geometry with ML-derived building footprints — important for
Dakhla, where raw OSM building coverage is sparse. The data is queried
directly from Overture's public GeoParquet release on S3 via DuckDB, so no
OSM API access (Nominatim/Overpass) is required.

Requirements: duckdb>=1.1, geopandas, pandas, shapely
              plus the DuckDB httpfs + spatial extensions (installed on
              first run, or via the duckdb-extension-httpfs /
              duckdb-extension-spatial PyPI packages in offline setups)
"""

import os

import duckdb
import geopandas as gpd
import pandas as pd
from shapely import wkb

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed")
os.makedirs(OUTPUT_DIR, exist_ok=True)

OVERTURE_RELEASE = "2026-06-17.0"
OVERTURE_S3 = f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}"

# Bounding box for the Dakhla peninsula (Rio de Oro), Western Sahara / Morocco:
# covers the historic city at the southwestern tip, the port, the airport and
# the newer developments stretching northeast along the isthmus.
BBOX = {
    "xmin": -16.00,
    "ymin": 23.62,
    "xmax": -15.72,
    "ymax": 23.90,
}

# Dakhla is overwhelmingly low-rise (1-2 storeys); a Torino-style 15m default
# would badly overstate the skyline, so fall back to a modest 4.5m.
METERS_PER_LEVEL = 3.2
DEFAULT_HEIGHT_M = 4.5

# Overture road classes a pedestrian can use. Everything in the bbox except
# limited-access roads — mirrors OSMnx's network_type="walk" behaviour.
NON_WALKABLE_CLASSES = ("motorway", "trunk")


def connect_duckdb() -> duckdb.DuckDBPyConnection:
    # Managed environments may inject placeholder AWS credentials that break
    # anonymous S3 reads — drop them before DuckDB picks them up.
    for var in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        os.environ.pop(var, None)

    con = duckdb.connect()
    for ext in ("httpfs", "spatial"):
        try:
            con.load_extension(ext)
        except duckdb.IOException:
            con.install_extension(ext)
            con.load_extension(ext)

    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        con.execute("SET http_proxy = ?", [proxy.replace("http://", "")])

    con.execute("CREATE SECRET overture (TYPE S3, PROVIDER config, REGION 'us-west-2')")
    return con


def bbox_filter() -> str:
    return (
        f"bbox.xmin > {BBOX['xmin']} AND bbox.xmax < {BBOX['xmax']} "
        f"AND bbox.ymin > {BBOX['ymin']} AND bbox.ymax < {BBOX['ymax']}"
    )


def to_gdf(df: pd.DataFrame) -> gpd.GeoDataFrame:
    geometry = df.pop("geometry_wkb").apply(lambda b: wkb.loads(bytes(b)))
    return gpd.GeoDataFrame(df, geometry=geometry, crs="EPSG:4326")


def fetch_buildings_3d(con: duckdb.DuckDBPyConnection) -> gpd.GeoDataFrame:
    print("↳ Downloading building footprints (Overture buildings theme)...")
    df = con.execute(
        f"""
        SELECT
            height,
            num_floors,
            COALESCE(subtype, 'unknown') AS building,
            ST_AsWKB(geometry) AS geometry_wkb
        FROM read_parquet('{OVERTURE_S3}/theme=buildings/type=building/*')
        WHERE {bbox_filter()}
          AND NOT COALESCE(is_underground, false)
        """
    ).fetchdf()

    print("↳ Cleaning building height attributes...")
    gdf = to_gdf(df)
    gdf["calculated_height"] = (
        gdf["height"]
        .fillna(gdf["num_floors"] * METERS_PER_LEVEL)
        .fillna(DEFAULT_HEIGHT_M)
        .astype(float)
    )

    gdf = gdf[gdf.geometry.type.isin(["Polygon", "MultiPolygon"])].copy()
    return gdf[["geometry", "calculated_height", "building"]]


def fetch_pedestrian_network(con: duckdb.DuckDBPyConnection) -> gpd.GeoDataFrame:
    print("↳ Downloading walkable street network (Overture transportation theme)...")
    placeholders = ", ".join(f"'{c}'" for c in NON_WALKABLE_CLASSES)
    df = con.execute(
        f"""
        SELECT
            names.primary AS name,
            class AS highway,
            ST_AsWKB(geometry) AS geometry_wkb
        FROM read_parquet('{OVERTURE_S3}/theme=transportation/type=segment/*')
        WHERE {bbox_filter()}
          AND subtype = 'road'
          AND class NOT IN ({placeholders})
        """
    ).fetchdf()

    gdf = to_gdf(df)
    return gdf[["geometry", "name", "highway"]]


def main():
    print(f"🔄 Fetching data for Dakhla (Overture release {OVERTURE_RELEASE})...")
    con = connect_duckdb()

    buildings_final = fetch_buildings_3d(con)
    pedestrian_cleaned = fetch_pedestrian_network(con)

    print("💾 Saving files to disk...")
    buildings_path = os.path.join(OUTPUT_DIR, "dakhla_buildings_3d.geojson")
    pedestrian_path = os.path.join(OUTPUT_DIR, "dakhla_pedestrian_network.geojson")

    buildings_final.to_file(buildings_path, driver="GeoJSON")
    pedestrian_cleaned.to_file(pedestrian_path, driver="GeoJSON")

    print(f"✅ Success! {len(buildings_final)} buildings, {len(pedestrian_cleaned)} street segments:")
    print(f"   - {buildings_path}")
    print(f"   - {pedestrian_path}")


if __name__ == "__main__":
    main()
