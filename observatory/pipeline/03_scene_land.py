"""
03_scene_land.py

Exports the land polygon the 3D scene is drawn on (observatory/data/land.geojson)
from the Overture Maps coastline (GeoParquet on AWS S3, anonymous access).
The scene needs more room than the city, so the horizon is not an edge.

Requirements: pyarrow, s3fs, geopandas, shapely
"""

import os

import geopandas as gpd
import pyarrow.compute as pc
import pyarrow.dataset as ds
import s3fs
import shapely

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
OVERTURE_RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-10-21.0")
S3_ROOT = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
WINDOW = (-17.2, 22.3, -14.3, 25.4)
SIMPLIFY_DEG = 0.00015


def main():
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    cfg = {"proxies": {"https": proxy, "http": proxy}} if proxy else {}
    fs = s3fs.S3FileSystem(anon=True, config_kwargs=cfg, client_kwargs={"region_name": "us-west-2"})
    xmin, ymin, xmax, ymax = WINDOW
    flt = ((pc.field("bbox", "xmin") < xmax) & (pc.field("bbox", "xmax") > xmin)
           & (pc.field("bbox", "ymin") < ymax) & (pc.field("bbox", "ymax") > ymin)
           & (pc.field("class") == "land"))
    df = ds.dataset(f"{S3_ROOT}/theme=base/type=land/", filesystem=fs, format="parquet") \
        .to_table(filter=flt, columns=["id", "geometry"]).to_pandas()
    geoms = [g for g in shapely.from_wkb(df["geometry"]) if g.geom_type in ("Polygon", "MultiPolygon")]
    land = shapely.union_all(geoms).intersection(shapely.box(*WINDOW)).simplify(SIMPLIFY_DEG)
    gpd.GeoDataFrame({"kind": ["land"]}, geometry=[land], crs=4326) \
        .to_file(os.path.join(OUT, "land.geojson"), driver="GeoJSON", COORDINATE_PRECISION=5)
    print("land parts:", len(getattr(land, "geoms", [land])), "bytes:", os.path.getsize(os.path.join(OUT, "land.geojson")))


if __name__ == "__main__":
    main()
