"""
02_fetch_overture_context.py

Pulls the human geography of the Ourika watershed from Overture Maps
(GeoParquet on AWS S3, anonymous access) and exports:

    ourika/data/places.geojson     villages / localities (Overture divisions)
    ourika/data/pois.geojson       points of interest inside the basin
    ourika/data/roads.geojson      motorable roads crossing the basin
    ourika/data/exposure.geojson   buildings within FLOOD_BUFFER_M of a main channel
    ourika/data/context.json       counts per sub-basin (buildings, exposed, villages)

Run 01_delineate_watershed.py first: the basin, sub-basin and river layers
it writes are used here to clip and to measure flood exposure.

Requirements: pyarrow, s3fs, geopandas, shapely, pandas
"""

import json
import os
import re

import geopandas as gpd
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as ds
import s3fs
import shapely

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
OVERTURE_RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-10-21.0")
S3_ROOT = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
UTM = "EPSG:32629"            # UTM 29N covers the High Atlas of Marrakech
CONTEXT_BUFFER_M = 6000       # keep villages / roads this far outside the divide
FLOOD_BUFFER_M = 60           # "exposed" = this close to a channel ...
FLOOD_CHANNEL_KM2 = 20.0      # ... draining at least this much
ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified"}


def s3():
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    cfg = {"proxies": {"https": proxy, "http": proxy}} if proxy else {}
    return s3fs.S3FileSystem(anon=True, config_kwargs=cfg,
                             client_kwargs={"region_name": "us-west-2"})


def read_overture(theme, type_, columns, bbox):
    xmin, ymin, xmax, ymax = bbox
    flt = ((pc.field("bbox", "xmin") < xmax) & (pc.field("bbox", "xmax") > xmin)
           & (pc.field("bbox", "ymin") < ymax) & (pc.field("bbox", "ymax") > ymin))
    dataset = ds.dataset(f"{S3_ROOT}/theme={theme}/type={type_}/", filesystem=s3(),
                         format="parquet")
    df = dataset.to_table(filter=flt, columns=columns).to_pandas()
    geom = shapely.from_wkb(df.pop("geometry"))
    print(f"  {theme}/{type_}: {len(df)} rows")
    return gpd.GeoDataFrame(df, geometry=geom, crs="EPSG:4326")


LATIN = re.compile(r"[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’\- ]*")


def primary(names):
    """Primary name in Latin script (OSM names here often append Arabic / Tifinagh)."""
    if not isinstance(names, dict):
        return None
    common = dict(names.get("common") or [])
    for cand in (names.get("primary"), common.get("fr"), common.get("en")):
        parts = [m.strip(" -") for m in LATIN.findall(cand or "")]
        parts = [x for x in parts if len(x) > 1]
        if parts:
            return " ".join(parts)
    return names.get("primary")


def write(name, gdf):
    path = os.path.join(OUT, name)
    gdf.to_file(path, driver="GeoJSON", COORDINATE_PRECISION=5)
    print(f"  wrote {name} ({len(gdf)} features)")


def main():
    basin = gpd.read_file(os.path.join(OUT, "watershed.geojson"))
    subs = gpd.read_file(os.path.join(OUT, "subbasins.geojson"))
    rivers = gpd.read_file(os.path.join(OUT, "rivers.geojson"))
    basin_utm = basin.to_crs(UTM)
    context = basin_utm.buffer(CONTEXT_BUFFER_M).to_crs(4326).iloc[0]
    bbox = context.bounds
    basin_geom = basin.geometry.iloc[0]

    # --- villages -----------------------------------------------------------
    div = read_overture("divisions", "division",
                        ["id", "names", "subtype", "class", "population", "geometry"], bbox)
    div["name"] = div["names"].apply(primary)
    div = div[div.geometry.within(context) & div["name"].notna()
              & div["subtype"].isin(["locality", "neighborhood", "localadmin", "county"])]
    div["in_basin"] = div.geometry.within(basin_geom)
    places = div[["name", "subtype", "class", "population", "in_basin", "geometry"]]
    write("places.geojson", places)

    # --- points of interest -------------------------------------------------
    poi = read_overture("places", "place", ["id", "names", "basic_category", "confidence", "geometry"],
                        basin_geom.bounds)
    poi["name"] = poi["names"].apply(primary)
    poi["category"] = poi["basic_category"]
    poi = poi[poi.geometry.within(basin_geom) & poi["name"].notna() & (poi["confidence"] >= 0.5)]
    write("pois.geojson", poi[["name", "category", "geometry"]])

    # --- roads ----------------------------------------------------------------
    seg = read_overture("transportation", "segment",
                        ["id", "names", "subtype", "class", "geometry"], bbox)
    seg = seg[(seg["subtype"] == "road") & seg["class"].isin(ROAD_CLASSES)
              & seg.geometry.intersects(context)]
    seg["name"] = seg["names"].apply(primary)
    seg["geometry"] = seg.geometry.simplify(0.0002)
    write("roads.geojson", seg[["name", "class", "geometry"]])

    # --- buildings + flood exposure -----------------------------------------
    bld = read_overture("buildings", "building", ["id", "geometry"], basin_geom.bounds)
    bld["geometry"] = bld.geometry.centroid
    bld = bld[bld.geometry.within(basin_geom)]
    channels = rivers[rivers["upstream_km2"] >= FLOOD_CHANNEL_KM2].to_crs(UTM)
    corridor = channels.buffer(FLOOD_BUFFER_M).union_all()
    bld_utm = bld.to_crs(UTM)
    bld["exposed"] = bld_utm.geometry.within(corridor).values
    joined = gpd.sjoin(bld, subs[["id", "geometry"]], predicate="within", how="left")
    counts = joined.groupby("id_right").agg(buildings=("exposed", "size"),
                                            exposed=("exposed", "sum"))
    rank = {"town": 0, "village": 1, "hamlet": 2}
    inside = places[places["in_basin"]].copy()
    inside["rank"] = inside["class"].map(rank).fillna(3)
    inside = inside.sort_values(["rank", "population"], ascending=[True, False])
    vill = gpd.sjoin(inside, subs[["id", "geometry"]], predicate="within", how="left") \
        .groupby("id")["name"].apply(lambda s: list(dict.fromkeys(n.strip() for n in s)))
    ctx = {
        "overture_release": OVERTURE_RELEASE,
        "flood_buffer_m": FLOOD_BUFFER_M, "flood_channel_km2": FLOOD_CHANNEL_KM2,
        "buildings": int(len(bld)), "exposed_buildings": int(bld["exposed"].sum()),
        "villages_in_basin": int(places["in_basin"].sum()), "pois": int(len(poi)),
        "subbasins": {sid: {"buildings": int(r.buildings), "exposed": int(r.exposed),
                            "villages": vill.get(sid, [])}
                      for sid, r in counts.iterrows()},
    }
    write("exposure.geojson", bld[bld["exposed"]][["geometry"]])
    json.dump(ctx, open(os.path.join(OUT, "context.json"), "w"), ensure_ascii=False,
              separators=(",", ":"))
    print(json.dumps({k: v for k, v in ctx.items() if k != "subbasins"}))


if __name__ == "__main__":
    main()
