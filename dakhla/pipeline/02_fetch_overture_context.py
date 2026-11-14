"""
02_fetch_overture_context.py

Pulls the human geography of the Dakhla watch area from Overture Maps
(GeoParquet on AWS S3, anonymous access) and exports:

    dakhla/data/places.geojson     localities and named landmarks (beaches, capes, bays)
    dakhla/data/pois.geojson       points of interest inside the watch area
    dakhla/data/roads.geojson      motorable roads
    dakhla/data/exposure.geojson   buildings within SHORE_BUFFER_M of a shoreline
    dakhla/data/context.json       counts per sector (buildings, near shore, localities)

Run 01_build_study_area.py first: the area, sector and shoreline layers it
writes are used here to clip and to measure shoreline exposure.

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
UTM = "EPSG:32628"            # UTM 28N covers Dakhla
CONTEXT_BUFFER_M = 3000       # keep localities / roads this far outside the watch area
SHORE_BUFFER_M = 150          # "near shore" = a building this close to a shoreline
ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential"}
LANDMARKS = {"beach", "bay", "cape", "islet", "wetland", "peak"}


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


LATIN = re.compile(r"[A-Za-zÀ-ɏ][A-Za-z0-9À-ɏ'’\- ]*")


def primary(names):
    """Primary name in Latin script (OSM names here often append Arabic / Tifinagh)."""
    if not isinstance(names, dict):
        return None
    common = dict(names.get("common") or [])
    for cand in (names.get("primary"), common.get("fr"), common.get("en"), common.get("es")):
        parts = [m.strip(" -") for m in LATIN.findall(cand or "")]
        parts = [x for x in parts if len(x) > 1]
        if parts:
            return " ".join(parts)
    return None


def write(name, gdf):
    path = os.path.join(OUT, name)
    gdf.to_file(path, driver="GeoJSON", COORDINATE_PRECISION=5)
    print(f"  wrote {name} ({len(gdf)} features)")


def main():
    area = gpd.read_file(os.path.join(OUT, "area.geojson"))
    sectors = gpd.read_file(os.path.join(OUT, "sectors.geojson"))
    shoreline = gpd.read_file(os.path.join(OUT, "shoreline.geojson"))
    context = area.to_crs(UTM).buffer(CONTEXT_BUFFER_M).to_crs(4326).iloc[0]
    bbox = context.bounds
    area_geom = area.geometry.iloc[0]
    land_geom = sectors[sectors["kind"] != "lagoon"].union_all()

    # --- localities and named landmarks ------------------------------------
    div = read_overture("divisions", "division",
                        ["id", "names", "subtype", "class", "population", "geometry"], bbox)
    div["name"] = div["names"].apply(primary)
    div = div[div.geometry.within(context) & div["name"].notna() & (div["subtype"] == "locality")]
    div["class"] = div["class"].fillna("town")
    frames = [div[["name", "class", "population", "geometry"]]]
    for type_ in ("land", "water"):
        g = read_overture("base", type_, ["id", "names", "class", "geometry"], bbox)
        g["name"] = g["names"].apply(primary)
        g = g[g["name"].notna() & g["class"].isin(LANDMARKS)].copy()
        g["geometry"] = g.geometry.representative_point()
        g["population"] = None
        frames.append(g[g.geometry.within(context)][["name", "class", "population", "geometry"]])
    places = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=4326)
    places = places.drop_duplicates(subset=["name", "class"])
    places["in_area"] = places.geometry.within(area_geom.buffer(0.003))
    write("places.geojson", places)

    # --- points of interest -------------------------------------------------
    poi = read_overture("places", "place", ["id", "names", "basic_category", "confidence", "geometry"],
                        area_geom.bounds)
    poi["name"] = poi["names"].apply(primary)
    poi["category"] = poi["basic_category"]
    poi = poi[poi.geometry.within(area_geom.buffer(0.002)) & poi["name"].notna() & (poi["confidence"] >= 0.5)]
    write("pois.geojson", poi[["name", "category", "geometry"]])

    # --- roads ----------------------------------------------------------------
    seg = read_overture("transportation", "segment",
                        ["id", "names", "subtype", "class", "geometry"], bbox)
    seg = seg[(seg["subtype"] == "road") & seg["class"].isin(ROAD_CLASSES)
              & seg.geometry.intersects(context)]
    seg["name"] = seg["names"].apply(primary)
    seg["geometry"] = seg.geometry.simplify(0.00005)
    road_km = float(seg.to_crs(UTM).length.sum() / 1000)
    write("roads.geojson", seg[["name", "class", "geometry"]])

    # --- buildings + shoreline exposure --------------------------------------
    bld = read_overture("buildings", "building", ["id", "geometry"], area_geom.bounds)
    bld["geometry"] = bld.to_crs(UTM).geometry.centroid.to_crs(4326)
    bld = bld[bld.geometry.within(land_geom.buffer(0.001))]
    corridor = shoreline.to_crs(UTM).buffer(SHORE_BUFFER_M).union_all()
    bld["exposed"] = bld.to_crs(UTM).geometry.within(corridor).values
    land = sectors[sectors["kind"] != "lagoon"][["id", "geometry"]]
    joined = gpd.sjoin_nearest(bld.to_crs(UTM), land.to_crs(UTM), how="left", max_distance=200)
    joined = joined[~joined.index.duplicated()]
    counts = joined.groupby("id_right").agg(buildings=("exposed", "size"), exposed=("exposed", "sum"))
    rank = {"town": 0, "village": 1, "hamlet": 2}
    inside = places[places["in_area"]].copy()
    inside["rank"] = inside["class"].map(rank).fillna(3)
    inside = inside.sort_values(["rank", "population"], ascending=[True, False])
    near = gpd.sjoin_nearest(inside.to_crs(UTM), sectors[["id", "geometry"]].to_crs(UTM), how="left", max_distance=400)
    near = near[~near.index.duplicated()]
    names = near.groupby("id")["name"].apply(lambda s: list(dict.fromkeys(n.strip() for n in s)))
    pois_by = gpd.sjoin_nearest(poi.to_crs(UTM), sectors[["id", "geometry"]].to_crs(UTM), how="left", max_distance=300)
    pois_by = pois_by[~pois_by.index.duplicated()].groupby("id_right").size()
    ctx = {
        "overture_release": OVERTURE_RELEASE,
        "shore_buffer_m": SHORE_BUFFER_M,
        "buildings": int(len(bld)), "exposed_buildings": int(bld["exposed"].sum()),
        "localities": int((places["in_area"] & places["class"].isin(rank)).sum()),
        "landmarks": int((places["in_area"] & ~places["class"].isin(rank)).sum()),
        "pois": int(len(poi)), "road_km": round(road_km, 1),
        "population_rgph_2024": 161723,
        "sectors": {sid: {"buildings": int(counts.buildings.get(sid, 0)), "exposed": int(counts.exposed.get(sid, 0)),
                          "pois": int(pois_by.get(sid, 0)), "places": names.get(sid, [])}
                    for sid in sectors["id"]},
    }
    write("exposure.geojson", bld[bld["exposed"]][["geometry"]])
    json.dump(ctx, open(os.path.join(OUT, "context.json"), "w"), ensure_ascii=False,
              separators=(",", ":"))
    print(json.dumps(ctx, ensure_ascii=False, indent=1))
    print(places.drop(columns="geometry").to_string())


if __name__ == "__main__":
    main()
