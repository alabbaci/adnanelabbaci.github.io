"""
01_fetch_overture.py

Downloads the map data for the play area from the Overture Maps Foundation
release on AWS S3 (GeoParquet, anonymous access) and writes it as plain JSON
for 02_build_city.mjs:

    rabat/pipeline/.cache/raw/buildings.json   footprints, heights, names
    rabat/pipeline/.cache/raw/roads.json       streets, paths, bridges
    rabat/pipeline/.cache/raw/nature.json      water, parks, beaches, piers, trees
    rabat/pipeline/.cache/raw/extras.json      ramparts, tram and rail lines, named spots
    rabat/pipeline/.cache/raw/outer.json       the city beyond the play area, much simplified

The JSON has the shape of an Overpass API answer (elements with OSM-style
tags and lat/lon geometry) because the city builder this project is adapted
from reads that. Overture is used instead of Overpass for the same reason as
the other pipelines in this repository: it bundles the OpenStreetMap geometry
with machine-detected footprints, which nearly doubles the building count in
the medinas of Rabat and Salé.

Heights. Only about one building in six carries a height or a floor count.
The rest get an estimate: the median of the known heights around them, pulled
towards a default for the kind of building. Those are marked est=1 and are
plausible, not measured.

Usage:  python rabat/pipeline/01_fetch_overture.py [--force]
Needs:  pyarrow, s3fs, shapely, numpy   (see requirements.txt)
"""

import json
import math
import os
import re
import sys

import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.parquet as pq
import s3fs
import shapely
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon
from shapely.ops import substring, unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
RAW = os.path.join(CACHE, "raw")
os.makedirs(RAW, exist_ok=True)

OVERTURE_RELEASE = "2026-11-18.0"
S3_ROOT = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}"

AREA = json.load(open(os.path.join(HERE, "area.json"), encoding="utf-8"))
B = AREA["bbox"]
# Buildings and roads are fetched a little beyond the play area; water, sand and
# woods much further, so that the river and the ocean carry on past the map's edge.
NEAR = (B["west"] - 0.004, B["south"] - 0.004, B["east"] + 0.004, B["north"] + 0.004)
FAR = (B["west"] - 0.045, B["south"] - 0.04, B["east"] + 0.045, B["north"] + 0.04)

LAT0 = (B["south"] + B["north"]) / 2
LON0 = (B["west"] + B["east"]) / 2
MX = 111320 * math.cos(math.radians(LAT0))
MZ = 110574
METERS_PER_FLOOR = 3.2


def read(theme, type_, bbox, columns=None, name=None):
    """One Overture layer, cut to bbox, cached on disk as parquet."""
    path = os.path.join(CACHE, f"{name or type_}.parquet")
    if os.path.exists(path) and "--force" not in sys.argv:
        return pq.read_table(path).to_pandas()
    x0, y0, x1, y1 = bbox
    flt = (
        (pc.field("bbox", "xmin") < x1)
        & (pc.field("bbox", "xmax") > x0)
        & (pc.field("bbox", "ymin") < y1)
        & (pc.field("bbox", "ymax") > y0)
    )
    fs = s3fs.S3FileSystem(anon=True)
    data = ds.dataset(f"{S3_ROOT}/theme={theme}/type={type_}/", filesystem=fs, format="parquet")
    table = data.to_table(filter=flt, columns=columns)
    pq.write_table(table, path)
    print(f"{theme}/{type_}: {table.num_rows} rows")
    return table.to_pandas()


def num_id(uuid):
    """A stable number for an Overture id (the builder seeds colours from it)."""
    return int(re.sub(r"[^0-9a-f]", "", str(uuid))[:12] or "0", 16)


ARABIC = re.compile(r"[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]")
TIFINAGH = re.compile(r"[ⴰ-⵿]+")


def names_of(names):
    """(latin, arabic) from an Overture names struct. Rabat's map names are often both at once."""
    if names is None or not isinstance(names, dict):
        return None, None
    primary = names.get("primary")
    common = names.get("common")
    common = dict(common) if common is not None and not isinstance(common, dict) else (common or {})
    fr = common.get("fr") or common.get("en")
    ar = common.get("ar")
    if not primary and not fr:
        return None, ar
    text = TIFINAGH.sub(" ", primary or fr)
    latin = " ".join(w for w in text.split() if not ARABIC.search(w)).strip(" -–/")
    arabic = " ".join(w for w in text.split() if ARABIC.search(w)).strip()
    return (fr or latin or None), (ar or arabic or None)


def ring(coords):
    return [{"lat": round(y, 7), "lon": round(x, 7)} for x, y, *_ in coords]


def polygons(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in polygons(g)]
    return []


def lines(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    return []


def area_element(poly, tags, eid):
    """A polygon as an Overpass way, or as a multipolygon relation if it has holes."""
    if not poly.interiors:
        return {"type": "way", "id": eid, "tags": tags, "geometry": ring(poly.exterior.coords)}
    members = [{"type": "way", "role": "outer", "geometry": ring(poly.exterior.coords)}]
    members += [{"type": "way", "role": "inner", "geometry": ring(i.coords)} for i in poly.interiors]
    return {"type": "relation", "id": eid, "tags": {**tags, "type": "multipolygon"}, "members": members}


def metres(geom):
    """lon/lat geometry in local metres (+x east, +y north), for buffers and distances."""
    return shapely.transform(geom, lambda c: np.column_stack([(c[:, 0] - LON0) * MX, (c[:, 1] - LAT0) * MZ]))


def degrees(geom):
    return shapely.transform(geom, lambda c: np.column_stack([c[:, 0] / MX + LON0, c[:, 1] / MZ + LAT0]))


def present(v):
    return v is not None and not (isinstance(v, float) and math.isnan(v))


def write(name, elements):
    path = os.path.join(RAW, f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"elements": elements}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{name}.json: {len(elements)} elements, {os.path.getsize(path) / 1e6:.1f} MB")


# ---------------------------------------------------------------- buildings
LOW = {"house", "detached", "semidetached_house", "terrace", "bungalow", "hut", "cabin", "shed", "garage", "garages",
       "roof", "kiosk", "service", "carport", "greenhouse", "static_caravan", "farm_auxiliary", "toilets"}
DEFAULT_BY_CLASS = {
    "apartments": 16, "residential": 12, "commercial": 14, "office": 18, "hotel": 20, "retail": 8, "school": 9,
    "university": 12, "college": 10, "hospital": 14, "public": 12, "government": 14, "civic": 12, "mosque": 9,
    "church": 14, "cathedral": 18, "train_station": 12, "industrial": 8, "warehouse": 8, "stadium": 16,
}


def buildings():
    df = read("buildings", "building", NEAR)
    geoms = shapely.from_wkb(df.geometry.values)
    cent = shapely.centroid(geoms)
    cx = (shapely.get_x(cent) - LON0) * MX
    cy = (shapely.get_y(cent) - LAT0) * MZ

    known = np.full(len(df), np.nan)
    for i, (h, f) in enumerate(zip(df.height.values, df.num_floors.values)):
        if present(h) and 2 < h < 400:
            known[i] = float(h)
        elif present(f) and 0 < f < 80:
            known[i] = float(f) * METERS_PER_FLOOR + 1.0
    # the medinas are two and three storey houses, whatever stands around them
    medinas = [(m["lon"], m["lat"], m["radius"], m["height"]) for m in AREA.get("low_districts", [])]

    # the height of a building nobody measured: what its neighbours are, pulled towards its kind
    have = np.where(~np.isnan(known) & (known < 60))[0]
    cell = 200.0
    grid = {}
    for i in have:
        grid.setdefault((int(cx[i] // cell), int(cy[i] // cell)), []).append(i)
    est = np.zeros(len(df), dtype=bool)
    height = known.copy()
    for i in range(len(df)):
        if not np.isnan(known[i]):
            continue
        est[i] = True
        cls = df["class"].values[i]
        gx, gy = int(cx[i] // cell), int(cy[i] // cell)
        near = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for j in grid.get((gx + dx, gy + dy), [])
                if (cx[j] - cx[i]) ** 2 + (cy[j] - cy[i]) ** 2 < 260 ** 2]
        around = float(np.median(known[near])) if len(near) >= 4 else 10.5
        a = shapely.area(metres(geoms[i]))
        if cls in LOW:
            h = min(around, 7.5)
        elif cls in DEFAULT_BY_CLASS:
            h = 0.5 * around + 0.5 * DEFAULT_BY_CLASS[cls]
        else:
            h = around
        if a < 45:
            h = min(h, 6.5)  # a small footprint is a small house or a shed
        lon, lat = shapely.get_x(cent[i]), shapely.get_y(cent[i])
        for mlon, mlat, radius, mh in medinas:
            if ((lon - mlon) * MX) ** 2 + ((lat - mlat) * MZ) ** 2 < radius ** 2:
                h = min(h, mh)
        # a storey up or down, by a number that stays the same from run to run
        jitter = ((num_id(df.id.values[i]) * 2654435761) % 1000) / 1000.0
        h += (jitter - 0.5) * 2 * METERS_PER_FLOOR
        height[i] = max(3.2, round(h / METERS_PER_FLOOR) * METERS_PER_FLOOR + 0.6)

    out = []
    for i, g in enumerate(geoms):
        row = df.iloc[i]
        if row.get("is_underground") is True:
            continue
        latin, arabic = names_of(row["names"])
        src = row["sources"][0]["dataset"] if row["sources"] is not None and len(row["sources"]) else ""
        tags = {"building": row["class"] if present(row["class"]) else "yes", "height": round(float(height[i]), 1)}
        if est[i]:
            tags["est"] = 1
        if "OpenStreetMap" not in src:
            tags["ml"] = 1
        if present(row["subtype"]):
            tags["subtype"] = row["subtype"]
        if latin:
            tags["name"] = latin
        if arabic:
            tags["name:ar"] = arabic
        for key, tag in (("min_height", "min_height"), ("facade_color", "building:colour"), ("facade_material", "building:material"),
                         ("roof_shape", "roof:shape"), ("roof_color", "roof:colour"), ("roof_height", "roof:height")):
            if present(row[key]):
                tags[tag] = row[key] if isinstance(row[key], str) else round(float(row[key]), 1)
        for poly in polygons(g):
            out.append(area_element(poly, tags, num_id(row["id"])))

    parts = read("buildings", "building_part", NEAR)
    pg = shapely.from_wkb(parts.geometry.values)
    for i, g in enumerate(pg):
        row = parts.iloc[i]
        tags = {"building:part": "yes"}
        if present(row["height"]):
            tags["height"] = round(float(row["height"]), 1)
        elif present(row["num_floors"]):
            tags["building:levels"] = int(row["num_floors"])
        for key, tag in (("min_height", "min_height"), ("facade_color", "building:colour"), ("facade_material", "building:material"),
                         ("roof_shape", "roof:shape"), ("roof_color", "roof:colour"), ("roof_height", "roof:height")):
            if present(row[key]):
                tags[tag] = row[key] if isinstance(row[key], str) else round(float(row[key]), 1)
        for poly in polygons(g):
            out.append(area_element(poly, tags, num_id(row["id"])))
    write("buildings", out)
    print(f"  heights: {int((~est).sum())} mapped, {int(est.sum())} estimated")


# ---------------------------------------------------------------- roads and rails
def flag_ranges(rules, wanted):
    """[(from, to)] along the segment (0..1) where a flag such as is_bridge applies."""
    out = []
    if rules is None:
        return out
    for rule in rules:
        values = rule.get("values")
        if values is None or wanted not in list(values):
            continue
        between = rule.get("between")
        out.append((0.0, 1.0) if between is None else (float(between[0]), float(between[1])))
    return out


def level_ranges(rules):
    out = []
    if rules is None:
        return out
    for rule in rules:
        between = rule.get("between")
        a, b = (0.0, 1.0) if between is None else (float(between[0]), float(between[1]))
        out.append((a, b, int(rule.get("value") or 0)))
    return out


def one_way(restrictions):
    """'yes' if traffic may not run against the line's direction, '-1' if it may only run against it."""
    if restrictions is None:
        return None
    for r in restrictions:
        when = r.get("when") or {}
        if r.get("access_type") != "denied" or r.get("between") is not None:
            continue
        if any(when.get(k) is not None for k in ("mode", "using", "vehicle", "during", "recognized")):
            continue
        if when.get("heading") == "backward":
            return "yes"
        if when.get("heading") == "forward":
            return "-1"
    return None


def no_cars(restrictions):
    if restrictions is None:
        return False
    for r in restrictions:
        when = r.get("when") or {}
        if r.get("access_type") == "denied" and when.get("heading") is None and when.get("mode") is None and r.get("between") is None:
            return True
    return False


def roads():
    df = read("transportation", "segment", NEAR)
    geoms = shapely.from_wkb(df.geometry.values)
    out, rails = [], []
    for i, g in enumerate(geoms):
        row = df.iloc[i]
        latin, arabic = names_of(row["names"])
        if row["subtype"] == "rail":
            kind = "tram" if row["class"] == "tram" else "rail" if row["class"] in ("standard_gauge", "narrow_gauge") else None
            tunnel = flag_ranges(row["rail_flags"], "is_tunnel")
            if kind and not tunnel:
                rails.append({"type": "way", "id": num_id(row["id"]), "tags": {"railway": kind, **({"bridge": "yes"} if flag_ranges(row["rail_flags"], "is_bridge") else {})},
                              "geometry": ring(g.coords)})
            continue
        if row["subtype"] != "road":
            continue
        cls = row["class"]
        if cls in ("unknown", "track", "bridleway"):
            cls = "service" if cls == "unknown" else "path"
        sub = row["subclass"] if present(row["subclass"]) else None
        tags = {"highway": cls}
        if sub == "link" and cls in ("motorway", "trunk", "primary", "secondary", "tertiary"):
            tags["highway"] = cls + "_link"
        if sub == "crosswalk":
            tags["footway"] = "crossing"
        if sub == "sidewalk":
            tags["footway"] = "sidewalk"
        if latin:
            tags["name"] = latin
        if arabic:
            tags["name:ar"] = arabic
        ow = one_way(row["access_restrictions"])
        if ow:
            tags["oneway"] = ow
        if no_cars(row["access_restrictions"]) and cls == "service":
            tags["access"] = "no"
        if row["width_rules"] is not None and len(row["width_rules"]):
            tags["width"] = float(row["width_rules"][0]["value"])

        # cut the line wherever it becomes a bridge or a tunnel or changes level
        bridge, tunnel, level = flag_ranges(row["road_flags"], "is_bridge"), flag_ranges(row["road_flags"], "is_tunnel"), level_ranges(row["level_rules"])
        cuts = sorted({0.0, 1.0, *[v for a, b in bridge + tunnel for v in (a, b)], *[v for a, b, _ in level for v in (a, b)]})
        cuts = [c for k, c in enumerate(cuts) if k == 0 or c - cuts[k - 1] > 1e-4]
        for k in range(len(cuts) - 1):
            a, b = cuts[k], cuts[k + 1]
            mid = (a + b) / 2
            piece = g if len(cuts) == 2 else substring(g, a, b, normalized=True)
            if piece.is_empty or piece.geom_type != "LineString" or len(piece.coords) < 2:
                continue
            t = dict(tags)
            if any(p <= mid <= q for p, q in bridge):
                t["bridge"] = "yes"
            if any(p <= mid <= q for p, q in tunnel):
                t["tunnel"] = "yes"
            lv = [v for p, q, v in level if p <= mid <= q]
            if lv:
                t["layer"] = lv[0]
            out.append({"type": "way", "id": num_id(row["id"]) + k, "tags": t, "geometry": ring(piece.coords)})
    write("roads", out)
    return df, geoms, rails


# ---------------------------------------------------------------- water, green, sand, piers, trees
LAND_USE = {
    "park": {"leisure": "park"}, "garden": {"leisure": "garden"}, "flowerbed": {"leisure": "garden"}, "grass": {"landuse": "grass"},
    "village_green": {"landuse": "grass"}, "pitch": {"leisure": "pitch"}, "playground": {"leisure": "playground"},
    "golf_course": {"leisure": "park"}, "cemetery": {"landuse": "cemetery"}, "plaza": {"place": "square"},
    "pedestrian": {"place": "square"}, "farmland": {"landuse": "grass"}, "greenfield": {"landuse": "grass"},
}
LAND = {
    "forest": {"natural": "wood"}, "wood": {"natural": "wood"}, "scrub": {"natural": "scrub"}, "grassland": {"landuse": "grass"},
    "wetland": {"natural": "wetland"}, "beach": {"natural": "beach"}, "sand": {"natural": "beach"},
}


def nature():
    out = []
    eid = 1
    far_box = shapely.box(*FAR)

    water = read("base", "water", FAR)
    for g, cls in zip(shapely.from_wkb(water.geometry.values), water["class"].values):
        if cls in ("swimming_pool",):
            continue
        tags = {"natural": "water", "water": cls}
        for poly in polygons(shapely.intersection(g, far_box)):
            out.append(area_element(poly, tags, eid))
            eid += 1

    land = read("base", "land", FAR)
    lg = shapely.from_wkb(land.geometry.values)
    for g, cls, names in zip(lg, land["class"].values, land["names"].values):
        if cls == "tree" and g.geom_type == "Point":
            out.append({"type": "node", "id": eid, "lat": round(g.y, 7), "lon": round(g.x, 7), "tags": {"natural": "tree"}})
            eid += 1
            continue
        if cls == "tree_row":
            # a row of trees: one every nine metres along the line
            for line in lines(metres(g)):
                n = max(2, int(line.length / 9) + 1)
                for k in range(n):
                    p = degrees(line.interpolate(k / (n - 1), normalized=True))
                    out.append({"type": "node", "id": eid, "lat": round(p.y, 7), "lon": round(p.x, 7), "tags": {"natural": "tree"}})
                    eid += 1
            continue
        tags = LAND.get(cls)
        if not tags:
            continue
        latin, arabic = names_of(names)
        tags = {**tags, **({"name": latin} if latin else {}), **({"name:ar": arabic} if arabic else {})}
        for poly in polygons(shapely.intersection(g, far_box)):
            out.append(area_element(poly, tags, eid))
            eid += 1

    use = read("base", "land_use", NEAR)
    for g, cls, names in zip(shapely.from_wkb(use.geometry.values), use["class"].values, use["names"].values):
        tags = LAND_USE.get(cls)
        latin, arabic = names_of(names)
        if not tags:
            # schools, hospitals and the like: no ground of their own, but a name worth finding
            if latin and cls in ("school", "university", "college", "hospital", "stadium", "marina", "retail", "military", "religious"):
                p = g.representative_point()
                out.append({"type": "node", "id": eid, "lat": round(p.y, 7), "lon": round(p.x, 7),
                            "tags": {"place": "named", "name": latin, **({"name:ar": arabic} if arabic else {})}})
                eid += 1
            continue
        tags = {**tags, **({"name": latin} if latin else {}), **({"name:ar": arabic} if arabic else {})}
        for poly in polygons(g):
            out.append(area_element(poly, tags, eid))
            eid += 1

    infra = read("base", "infrastructure", NEAR)
    ig = shapely.from_wkb(infra.geometry.values)
    for g, cls in zip(ig, infra["class"].values):
        if cls not in ("pier", "breakwater", "groyne", "quay"):
            continue
        if g.geom_type in ("LineString", "MultiLineString"):
            g = degrees(metres(g).buffer(4.0 if cls != "pier" else 2.0, cap_style="flat"))
        for poly in polygons(g):
            out.append(area_element(poly, {"man_made": "pier"}, eid))
            eid += 1
    write("nature", out)
    return infra, ig


# ---------------------------------------------------------------- ramparts, rails, named spots
WALL_CLASSES = {"city_wall": 9.0, "defensive": 9.0}


def extras(road_df, road_geoms, rails, infra, ig):
    out = list(rails)
    eid = 1

    # Ramparts are lines in the map. Give them their thickness here, and open them wherever a street
    # or a path passes through (the gates), so that they can be built and walked around like buildings.
    passages = []
    for g, cls, sub in zip(road_geoms, road_df["class"].values, road_df["subtype"].values):
        if sub != "road":
            continue
        half = {"trunk": 9, "primary": 8, "secondary": 7, "tertiary": 6, "residential": 4.5, "living_street": 3.5, "unclassified": 4.5,
                "service": 3.2, "pedestrian": 3.2, "footway": 2.2, "path": 2.0, "steps": 2.0, "cycleway": 2.0}.get(cls, 2.5)
        passages.append(metres(g).buffer(half, cap_style="flat"))
    passages = unary_union(passages)
    walls = 0
    for g, cls, names, h in zip(ig, infra["class"].values, infra["names"].values, infra["height"].values):
        latin, _ = names_of(names)
        royal = cls == "wall" and latin and "Palais Royal" in latin
        if cls not in WALL_CLASSES and not royal:
            continue
        height = float(h) if present(h) and 2 < h < 30 else (6.0 if royal else WALL_CLASSES[cls])
        m = metres(g)
        body = m.buffer(1.1, cap_style="flat", join_style="mitre") if m.geom_type in ("LineString", "MultiLineString") else m.boundary.buffer(1.1, join_style="mitre")
        body = body.difference(passages)
        for poly in polygons(degrees(body)):
            if shapely.area(metres(poly)) < 6:
                continue
            out.append(area_element(poly, {"barrier": "city_wall", "height": height}, eid))
            eid += 1
            walls += 1

    # things worth finding that are not buildings: gates, the minaret of the Hassan Tower, bridges, squares
    seen = set()
    for g, cls, names in zip(ig, infra["class"].values, infra["names"].values):
        latin, arabic = names_of(names)
        if not latin or cls not in ("gate", "minaret", "bridge", "city_wall", "fountain", "viewpoint", "ferry_terminal", "lighthouse", "watchtower", "artwork", "viaduct"):
            continue
        if latin in seen or re.match(r"^(Entrée|L\d)\b", latin):
            continue
        seen.add(latin)
        p = g.representative_point()
        out.append({"type": "node", "id": eid, "lat": round(p.y, 7), "lon": round(p.x, 7),
                    "tags": {"place": "named", "kind": cls, "name": latin, **({"name:ar": arabic} if arabic else {})}})
        eid += 1
    write("extras", out)
    print(f"  ramparts: {walls} pieces")


# ---------------------------------------------------------------- the city beyond the play area
RING = 2800  # metres of city kept around the play area
CELL = 56.0


def outer():
    """Rabat, Sale and Temara carry on past the edge of the play area. Drawing every building there would
    double the download, so the ring is thinned: in each 56 m square, the largest building stands in for all
    of them, as its own tight rectangle grown to cover what the square's buildings cover together. Main
    roads are kept as lines."""
    ring = (B["west"] - RING / MX, B["south"] - RING / MZ, B["east"] + RING / MX, B["north"] + RING / MZ)
    df = read("buildings", "building", ring, columns=["id", "geometry", "height", "num_floors", "bbox"], name="building_ring")
    geoms = metres(shapely.from_wkb(df.geometry.values))
    cent = shapely.centroid(geoms)
    xs, ys, areas = shapely.get_x(cent), shapely.get_y(cent), shapely.area(geoms)
    x0, x1 = (B["west"] - LON0) * MX, (B["east"] - LON0) * MX
    y0, y1 = (B["south"] - LAT0) * MZ, (B["north"] - LAT0) * MZ
    cells, beyond = {}, 0
    for i in range(len(df)):
        x, y = xs[i], ys[i]
        if x0 - 30 < x < x1 + 30 and y0 - 30 < y < y1 + 30:
            continue  # inside the play area: drawn in full
        beyond += 1
        if areas[i] < 25:
            continue
        h, f = df.height.values[i], df.num_floors.values[i]
        height = float(h) if present(h) and 2 < h < 120 else float(f) * METERS_PER_FLOOR + 1 if present(f) and 0 < f < 40 else None
        key = (int(x // CELL), int(y // CELL))
        c = cells.setdefault(key, {"area": 0.0, "best": -1, "best_area": 0.0, "heights": []})
        c["area"] += areas[i]
        if height:
            c["heights"].append(height)
        if areas[i] > c["best_area"]:
            c["best"], c["best_area"] = i, areas[i]
    boxes = []
    for (cx, cy), c in cells.items():
        rect = shapely.oriented_envelope(geoms[c["best"]])
        if rect.geom_type != "Polygon":
            continue
        pts = list(rect.exterior.coords)[:4]
        ex, ey = pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]
        fx, fy = pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]
        L, W = math.hypot(ex, ey), math.hypot(fx, fy)
        angle = math.atan2(ey, ex)
        if W > L:
            L, W, angle = W, L, math.atan2(fy, fx)
        grow = min(2.2, math.sqrt(min(c["area"], 0.7 * CELL * CELL) / max(L * W, 1.0)))
        L, W = min(L * max(grow, 1.0), CELL * 0.96), min(W * max(grow, 1.0), CELL * 0.96)
        mx, my = rect.centroid.x, rect.centroid.y
        height = float(np.median(c["heights"])) if c["heights"] else 8.0
        # x east, z south (the game's frame); the angle is of the long side in that frame
        boxes.append([round(mx), round(-my), round(L), round(W), round(-angle, 2), round(height)])
    seg = read("transportation", "segment", ring, columns=["subtype", "class", "geometry", "bbox"], name="segment_ring")
    box = shapely.box(x0, y0, x1, y1)
    lines_out = []
    for g, sub, cls in zip(metres(shapely.from_wkb(seg.geometry.values)), seg["subtype"].values, seg["class"].values):
        if sub != "road" or cls not in ("motorway", "trunk", "primary", "secondary"):
            continue
        for line in lines(g.difference(box)):
            line = line.simplify(4)
            if line.length < 40:
                continue
            lines_out.append({"w": 13 if cls in ("motorway", "trunk") else 10, "p": [round(v) for x, y in line.coords for v in (x, -y)]})
    path = os.path.join(RAW, "outer.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"boxes": boxes, "roads": lines_out}, f, separators=(",", ":"))
    print(f"outer.json: {len(boxes)} blocks standing in for {beyond} buildings, {len(lines_out)} road lines, {os.path.getsize(path) / 1e6:.2f} MB")


if __name__ == "__main__":
    buildings()
    road_df, road_geoms, rails = roads()
    infra, ig = nature()
    extras(road_df, road_geoms, rails, infra, ig)
    outer()
