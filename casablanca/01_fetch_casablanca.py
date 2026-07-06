"""Step 1 — Casablanca data (Overture Maps GeoParquet, anonymous S3).

The original recipe used OSMnx (Nominatim + Overpass); both hosts are
blocked by this session's egress policy, so we read the same OSM-derived
geometry from Overture Maps instead (plus its ML-detected footprints).

Outputs (EPSG:32629 — UTM 29N, meters):
    casablanca_buildings.geojson  (Polygon/MultiPolygon, height_m property)
    casablanca_roads.geojson      (LineString, drivable classes only)
"""
import geopandas as gpd
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as ds
import s3fs
import shapely

S3_ROOT = "overturemaps-us-west-2/release/2026-06-17.0"

# Central Casablanca: old medina, port, Hassan II Mosque, CFC/Maarif
# towers, Ain Diab corniche. (lon_min, lat_min, lon_max, lat_max)
BBOX = (-7.68, 33.55, -7.56, 33.62)
CRS = "EPSG:32629"  # UTM 29N

METERS_PER_FLOOR = 3.2

# Mirror OSMnx network_type="drive": drivable public roads, no service ways
DRIVABLE = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street",
}


def bbox_filter():
    xmin, ymin, xmax, ymax = BBOX
    return (
        (pc.field("bbox", "xmin") < xmax)
        & (pc.field("bbox", "xmax") > xmin)
        & (pc.field("bbox", "ymin") < ymax)
        & (pc.field("bbox", "ymax") > ymin)
    )


def read_overture(theme: str, type_: str, columns: list) -> gpd.GeoDataFrame:
    fs = s3fs.S3FileSystem(anon=True)
    dataset = ds.dataset(
        f"{S3_ROOT}/theme={theme}/type={type_}/", filesystem=fs, format="parquet"
    )
    df = dataset.to_table(filter=bbox_filter(), columns=columns).to_pandas()
    geometry = shapely.from_wkb(df.pop("geometry"))
    return gpd.GeoDataFrame(df, geometry=geometry, crs="EPSG:4326")


def main():
    print(f"Fetching Overture buildings for Casablanca {BBOX} ...")
    buildings = read_overture(
        "buildings", "building", ["geometry", "height", "num_floors"]
    )
    buildings = buildings[
        buildings.geometry.geom_type.isin(["Polygon", "MultiPolygon"])
    ].copy()

    # height in meters; 0 = unknown (renderer substitutes its default)
    height = pd.to_numeric(buildings["height"], errors="coerce")
    floors = pd.to_numeric(buildings["num_floors"], errors="coerce")
    buildings["height_m"] = height.fillna(floors * METERS_PER_FLOOR).fillna(0.0)

    buildings = buildings[["height_m", "geometry"]].to_crs(CRS)
    buildings.to_file("casablanca_buildings.geojson", driver="GeoJSON")
    print(f"✓ Saved {len(buildings)} building footprints")
    known = (buildings["height_m"] > 0).sum()
    print(f"  height coverage: {known}/{len(buildings)} "
          f"({100 * known / len(buildings):.1f}%), "
          f"max {buildings['height_m'].max():.1f} m")

    print("Fetching Overture road segments ...")
    roads = read_overture(
        "transportation", "segment", ["geometry", "subtype", "class"]
    )
    roads = roads[
        (roads["subtype"] == "road") & (roads["class"].isin(DRIVABLE))
    ].copy()
    roads = roads[["geometry"]].explode(index_parts=False).reset_index(drop=True)
    roads = roads[roads.geometry.geom_type == "LineString"].to_crs(CRS)
    roads.to_file("casablanca_roads.geojson", driver="GeoJSON")
    print(f"✓ Saved {len(roads)} road segments")


if __name__ == "__main__":
    main()
