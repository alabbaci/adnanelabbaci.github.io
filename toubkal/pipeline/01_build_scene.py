"""
01_build_scene.py

Builds every static layer of the Toubkal National Park dashboard:

    toubkal/data/dem.png      elevation grid, 16 bit packed into the R and G channels
    toubkal/data/albedo.jpg   relief texture (tinted hillshade, park brighter than its surroundings)
    toubkal/data/scene.json   park boundary, roads, trails, walking routes, rivers, lakes,
                              ski lifts, peaks, villages and the named points the page reports on

Sources: Copernicus GLO-30 DEM and Overture Maps GeoParquet, both read
anonymously from public AWS S3 buckets. Nothing here needs an API key.

Scene coordinates are kilometres from the centre of the window, x east and
y north, on a local equirectangular projection; elevations are metres.

Requirements: see requirements.txt
"""

import json
import math
import os
import re
import urllib.request

import geopandas as gpd
import networkx as nx
import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as ds
import rasterio
import s3fs
import shapely
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.merge import merge
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from scipy.ndimage import gaussian_filter, map_coordinates
from shapely.geometry import LineString, Point, box
from shapely.ops import linemerge, unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
CACHE = os.environ.get("TOUBKAL_CACHE", os.path.join(HERE, ".cache"))
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

OVERTURE_RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-10-21.0")
S3_ROOT = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
DEM_S3 = "https://copernicus-dem-30m.s3.amazonaws.com"
DEM_TILES = ["N30_00_W009_00", "N30_00_W008_00", "N31_00_W009_00", "N31_00_W008_00"]
UTM = "EPSG:32629"

# Scene window (lon_min, lat_min, lon_max, lat_max): the park plus the valleys
# people enter it from (Imlil, Oukaimeden, Setti Fatma, Ijoukak, Amsouzart).
WINDOW = (-8.22, 30.90, -7.60, 31.34)
LON0, LAT0 = (WINDOW[0] + WINDOW[2]) / 2, (WINDOW[1] + WINDOW[3]) / 2
KX = 111.320 * math.cos(math.radians(LAT0))   # km per degree of longitude
KY = 110.574                                  # km per degree of latitude
W_KM, H_KM = (WINDOW[2] - WINDOW[0]) * KX, (WINDOW[3] - WINDOW[1]) * KY
GRID_M = 100                                  # mesh spacing
TEX_W = 2048                                  # relief texture width

# Named points. `elev` is the published elevation where one exists (summits,
# passes, refuges); it labels the point and is the height the weather model is
# asked to correct to. `wind` picks the model level used for wind: the 10 m
# wind in valleys, the 700 hPa or 600 hPa wind on exposed ground near those
# heights (about 3,100 m and 4,300 m).
POINTS = [
    # id, name, lon, lat, published elevation, kind, wind level, walking score, callout
    ("toubkal", "Jbel Toubkal", -7.9149, 31.0598, 4167, "summit", "600hPa", True, True),
    ("ouanoukrim", "Ras Ouanoukrim", -7.9458, 31.0415, 4083, "summit", "600hPa", True, False),
    ("ouanoums", "Tizi n'Ouanoums", -7.9319, 31.0504, 3680, "pass", "600hPa", True, False),
    ("refuge", "Refuge du Toubkal", -7.9376, 31.0635, 3207, "refuge", "10m", True, False),
    ("chamharouch", "Sidi Chamharouch", -7.9124, 31.0979, 2350, "village", "10m", True, False),
    ("imlil", "Imlil", -7.9208, 31.1368, 1740, "village", "10m", True, True),
    ("tacheddirt", "Tacheddirt", -7.8438, 31.1559, 2314, "village", "10m", True, False),
    ("tizitacheddirt", "Tizi n'Tacheddirt", -7.8069, 31.1643, 3230, "pass", "700hPa", True, False),
    ("oukaimeden", "Oukaïmeden", -7.8613, 31.2053, 2620, "village", "10m", True, True),
    ("ifni", "Lac d'Ifni", -7.8842, 31.0307, 2295, "lake", "10m", True, True),
    ("amsouzart", "Amsouzart", -7.8325, 31.0156, 1740, "village", "10m", True, False),
    ("setti", "Setti Fatma", -7.6740, 31.2240, 1500, "village", "10m", True, True),
    ("asni", "Asni", -7.9800, 31.2496, 1150, "village", "10m", False, False),
    ("ijoukak", "Ijoukak", -8.1535, 30.9932, 1200, "village", "10m", False, False),
]

# Walking routes drawn with (illustrative) hikers: shortest way along mapped
# paths between the listed points.
ROUTES = [
    ("imlil-refuge", "Imlil to the Toubkal refuge", ["imlil", "chamharouch", "refuge"]),
    ("refuge-toubkal", "Refuge to the summit of Toubkal", ["refuge", "toubkal"]),
    ("refuge-ifni", "Refuge to Lac d'Ifni and Amsouzart", ["refuge", "ouanoums", "ifni", "amsouzart"]),
    ("refuge-ouanoukrim", "Refuge to Ras Ouanoukrim", ["refuge", "ouanoukrim"]),
    ("imlil-tacheddirt", "Imlil to Tizi n'Tacheddirt", ["imlil", "tacheddirt", "tizitacheddirt"]),
    ("oukaimeden-tacheddirt", "Oukaïmeden to Tacheddirt", ["oukaimeden", "tacheddirt"]),
]

# River model points: where the marker stands on the mapped river, and the
# GloFAS 0.05 degree cell the discharge is read from. The cells were picked by
# querying the 3 x 3 neighbourhood of each site and keeping the cell that
# carries the river (highest mean flow, 1 Sep to 14 Nov 2026).
GAUGES = [
    ("ourika", "Ourika", "Aghbalou", -7.7437, 31.3112, 31.325, -7.775),
    ("rheraya", "Rheraya", "Asni", -7.9790, 31.2530, 31.275, -8.025),
    ("nfis", "N'Fis", "Ijoukak", -8.1500, 30.9960, 31.025, -8.175),
    ("tifnoute", "Assif Tifnoute", "Amsouzart", -7.8400, 30.9900, 30.975, -7.875),
]

ROAD_MAIN = {"motorway", "trunk", "primary", "secondary", "tertiary"}
ROAD_MINOR = {"unclassified"}
TRAIL = {"path", "footway", "steps", "track"}
LATIN = re.compile(r"[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’\-. ]*")


def to_xy(lon, lat):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def s3():
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    cfg = {"proxies": {"https": proxy, "http": proxy}} if proxy else {}
    return s3fs.S3FileSystem(anon=True, config_kwargs=cfg, client_kwargs={"region_name": "us-west-2"})


def read_overture(theme, type_, columns):
    """One Overture layer, bbox-filtered on S3 and cached locally."""
    cache = os.path.join(CACHE, f"{OVERTURE_RELEASE}_{theme}_{type_}.parquet")
    if os.path.exists(cache):
        return gpd.read_parquet(cache)
    xmin, ymin, xmax, ymax = WINDOW
    flt = ((pc.field("bbox", "xmin") < xmax) & (pc.field("bbox", "xmax") > xmin)
           & (pc.field("bbox", "ymin") < ymax) & (pc.field("bbox", "ymax") > ymin))
    dataset = ds.dataset(f"{S3_ROOT}/theme={theme}/type={type_}/", filesystem=s3(), format="parquet")
    df = dataset.to_table(filter=flt, columns=columns).to_pandas()
    gdf = gpd.GeoDataFrame(df, geometry=shapely.from_wkb(df.pop("geometry")), crs="EPSG:4326")
    gdf.to_parquet(cache)
    print(f"  {theme}/{type_}: {len(gdf)} rows")
    return gdf


def latin(names):
    """Name in Latin script (OSM names here often append Arabic and Tifinagh)."""
    if not isinstance(names, dict):
        return None
    common = names.get("common")
    common = dict(common) if common is not None and len(common) else {}
    for cand in (common.get("fr"), names.get("primary"), common.get("en")):
        parts = [m.strip(" -.") for m in LATIN.findall(cand or "")]
        parts = [p for p in parts if len(p) > 1]
        if parts:
            return " ".join(parts)
    return None


# ---------------------------------------------------------------- elevation

def fetch_dem():
    paths = []
    for t in DEM_TILES:
        name = f"Copernicus_DSM_COG_10_{t}_DEM"
        p = os.path.join(CACHE, name + ".tif")
        if not os.path.exists(p):
            print(f"  downloading {name}")
            urllib.request.urlretrieve(f"{DEM_S3}/{name}/{name}.tif", p)
        paths.append(p)
    srcs = [rasterio.open(p) for p in paths]
    mosaic, transform = merge(srcs, bounds=(WINDOW[0] - 0.01, WINDOW[1] - 0.01, WINDOW[2] + 0.01, WINDOW[3] + 0.01))
    return mosaic[0].astype("float32"), transform


def resample(dem, transform, width, height, how):
    out = np.zeros((height, width), "float32")
    reproject(dem, out, src_transform=transform, src_crs="EPSG:4326",
              dst_transform=from_bounds(*WINDOW, width, height), dst_crs="EPSG:4326", resampling=how)
    return out


class Sampler:
    """Bilinear elevation lookup on the fine grid, in scene kilometres."""

    def __init__(self, grid):
        self.g = grid
        self.h, self.w = grid.shape

    def z(self, xs, ys):
        c = (np.asarray(xs) / W_KM + 0.5) * self.w - 0.5
        r = (0.5 - np.asarray(ys) / H_KM) * self.h - 0.5
        return map_coordinates(self.g, [r, c], order=1, mode="nearest")


def hillshade(z, cell_m, az_deg, alt_deg):
    gy, gx = np.gradient(z, cell_m)
    az, alt = math.radians(az_deg), math.radians(alt_deg)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(gy, -gx)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - math.pi / 2 - aspect)
    return np.clip(hs, 0, 1), slope


def build_albedo(fine, park_mask):
    """Night-blue relief: elevation tint, soft baked shading, park lifted from its surroundings."""
    h, w = fine.shape
    cell = W_KM * 1000 / w
    hs, slope = hillshade(fine, cell, 315, 50)
    soft, _ = hillshade(gaussian_filter(fine, 6), cell, 315, 50)
    stops = [(900, (21, 38, 44)), (1500, (30, 50, 52)), (2100, (44, 62, 66)), (2700, (60, 74, 84)),
             (3200, (82, 92, 106)), (3700, (112, 122, 138)), (4200, (156, 166, 182))]
    ez = [s[0] for s in stops]
    rgb = np.stack([np.interp(fine, ez, [s[1][i] for s in stops]) for i in range(3)], -1)
    shade = 0.62 + 0.50 * hs + 0.22 * (soft - 0.5)
    shade *= 1 - 0.28 * np.clip(np.degrees(slope) / 55, 0, 1)     # steep faces read darker
    rgb = rgb * shade[..., None]
    m = gaussian_filter(park_mask.astype("float32"), 1.2)[..., None]
    grey = rgb.mean(-1, keepdims=True)
    outside = (0.55 * rgb + 0.45 * grey) * 0.66
    rgb = rgb * 1.08 * m + outside * (1 - m)
    return Image.fromarray(np.clip(rgb, 0, 255).astype("uint8"), "RGB")


# ------------------------------------------------------------------ vectors

def lines_of(geom):
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type in ("MultiLineString", "GeometryCollection"):
        return [g for g in geom.geoms if g.geom_type == "LineString"]
    return []


def drape(line_utm, sampler, simplify_m, step_m, to_scene):
    """UTM line -> [[x, y, z], ...] in scene km / metres, resampled to follow the ground."""
    line = line_utm.simplify(simplify_m)
    if line.length < 1:
        return None
    line = shapely.segmentize(line, step_m)
    lon, lat = to_scene.transform(*np.array(line.coords).T[:2])
    xs, ys = to_xy(np.asarray(lon), np.asarray(lat))
    zs = sampler.z(xs, ys)
    return [[round(float(x), 3), round(float(y), 3), int(round(float(z)))] for x, y, z in zip(xs, ys, zs)]


def merged(gdf_utm, clip):
    geom = unary_union([g for g in gdf_utm.geometry if g is not None])
    geom = geom.intersection(clip)
    if geom.geom_type == "LineString":
        return [geom]
    return lines_of(linemerge(geom)) if not geom.is_empty else []


def shortest_routes(trail_utm, pts_utm):
    """Shortest path along the mapped path network between consecutive route points."""
    g = nx.Graph()
    noded = unary_union(list(trail_utm.geometry))
    for ln in lines_of(noded):
        cs = list(ln.coords)
        for a, b in zip(cs[:-1], cs[1:]):
            a, b = (round(a[0], 1), round(a[1], 1)), (round(b[0], 1), round(b[1], 1))
            if a != b:
                g.add_edge(a, b, w=math.dist(a, b))
    nodes = np.array(g.nodes)
    big = max(nx.connected_components(g), key=len)

    def nearest(p, comp):
        cand = np.array(list(comp))
        d = np.hypot(cand[:, 0] - p.x, cand[:, 1] - p.y)
        i = int(d.argmin())
        return tuple(cand[i]), float(d[i])

    out = []
    for rid, label, via in ROUTES:
        coords, ok = [], True
        for a, b in zip(via[:-1], via[1:]):
            na, da = nearest(pts_utm[a], big)
            nb, db = nearest(pts_utm[b], big)
            if max(da, db) > 900:
                print(f"  ! route {rid}: {a}->{b} is {max(da, db):.0f} m off the path network, skipped")
                ok = False
                break
            path = nx.shortest_path(g, na, nb, weight="w")
            coords += path if not coords else path[1:]
        if ok and len(coords) > 1:
            ln = LineString(coords)
            print(f"  route {rid}: {ln.length / 1000:.1f} km")
            out.append((rid, label, via, ln))
    return out


def main():
    print("elevation")
    dem, transform = fetch_dem()
    gw, gh = round(W_KM * 1000 / GRID_M), round(H_KM * 1000 / GRID_M)
    tex_h = round(TEX_W * H_KM / W_KM)
    mesh = resample(dem, transform, gw, gh, Resampling.average)
    fine = resample(dem, transform, TEX_W, tex_h, Resampling.bilinear)
    sampler = Sampler(fine)
    packed = np.clip(np.round(mesh), 0, 65535).astype("uint16")
    rgb = np.zeros((gh, gw, 3), "uint8")
    rgb[..., 0], rgb[..., 1] = packed >> 8, packed & 255
    Image.fromarray(rgb, "RGB").save(os.path.join(OUT, "dem.png"), optimize=True)
    print(f"  mesh {gw} x {gh}, {mesh.min():.0f} to {mesh.max():.0f} m; texture {TEX_W} x {tex_h}")

    print("overture")
    window = box(*WINDOW)
    wutm = gpd.GeoSeries([window], crs=4326).to_crs(UTM).iloc[0]
    to_scene = __import__("pyproj").Transformer.from_crs(UTM, "EPSG:4326", always_xy=True)

    land_use = read_overture("base", "land_use", ["id", "names", "subtype", "class", "geometry"])
    park = land_use[(land_use["class"] == "national_park")
                    & land_use["names"].apply(lambda n: "Toubkal" in str((n or {}).get("primary")))]
    park_geom = park.geometry.iloc[0]
    park_utm = gpd.GeoSeries([park_geom], crs=4326).to_crs(UTM).iloc[0]
    area = park_utm.area / 1e6
    mask = rasterize([(park_geom, 1)], out_shape=(tex_h, TEX_W), transform=from_bounds(*WINDOW, TEX_W, tex_h))
    build_albedo(fine, mask).save(os.path.join(OUT, "albedo.jpg"), quality=86, optimize=True)
    boundary = [drape(LineString(r.coords), sampler, 25, 120, to_scene)
                for r in [park_utm.exterior, *park_utm.interiors]]
    inside = fine[mask == 1]
    print(f"  park {area:.0f} km2, {inside.min():.0f} to {inside.max():.0f} m")

    seg = read_overture("transportation", "segment", ["id", "names", "subtype", "class", "geometry"])
    seg = seg[(seg["subtype"] == "road") & seg.intersects(window)].to_crs(UTM)
    roads = [{"k": "main", "p": p} for ln in merged(seg[seg["class"].isin(ROAD_MAIN)], wutm)
             if (p := drape(ln, sampler, 12, 150, to_scene))]
    roads += [{"k": "minor", "p": p} for ln in merged(seg[seg["class"].isin(ROAD_MINOR)], wutm)
              if ln.length > 1500 and (p := drape(ln, sampler, 25, 200, to_scene))]
    near_park = park_utm.buffer(3500)
    trail_all = seg[seg["class"].isin(TRAIL)]
    foot = trail_all[trail_all["class"] != "track"]
    trails = [p for ln in merged(foot[foot.intersects(near_park)], wutm)
              if ln.length > 400 and (p := drape(ln, sampler, 15, 160, to_scene))]

    pts_utm = dict(zip([p[0] for p in POINTS],
                       gpd.GeoSeries([Point(p[2], p[3]) for p in POINTS], crs=4326).to_crs(UTM)))
    walkable = seg[seg["class"].isin(TRAIL | ROAD_MINOR | {"tertiary", "residential", "service", "living_street"})]
    routes = [{"id": rid, "name": label, "via": via, "km": round(ln.length / 1000, 1),
               "p": drape(ln, sampler, 8, 110, to_scene)}
              for rid, label, via, ln in shortest_routes(walkable, pts_utm)]

    water = read_overture("base", "water", ["id", "names", "subtype", "class", "geometry"])
    water = water[water.intersects(window)].to_crs(UTM)
    water["name"] = water["names"].apply(latin)
    is_line = water.geom_type.isin(["LineString", "MultiLineString"])
    rivers = [{"k": "river", "p": p} for ln in merged(water[is_line & (water["subtype"] == "river")], wutm)
              if (p := drape(ln, sampler, 15, 160, to_scene))]
    rivers += [{"k": "stream", "p": p} for ln in merged(water[is_line & (water["subtype"] == "stream")], wutm)
               if ln.length > 2500 and (p := drape(ln, sampler, 25, 220, to_scene))]
    for r in rivers:                      # stored running downhill, so flow marks know their way
        if r["p"][0][2] < r["p"][-1][2]:
            r["p"].reverse()
    lakes = []
    for _, row in water[(water["subtype"].isin(["lake", "reservoir"])) & (water.geom_type == "Polygon")].iterrows():
        shape_ = row.geometry.intersection(wutm)          # reservoirs on the edge are cut at the window
        if shape_.geom_type == "Polygon" and shape_.area > 20000:
            ring = drape(LineString(shape_.exterior.coords), sampler, 8, 80, to_scene)
            lakes.append({"name": row["name"] if isinstance(row["name"], str) else None,
                          "ha": round(shape_.area / 1e4, 1), "p": ring})
    river_lines = unary_union([g for g in water[is_line & (water["subtype"] == "river")].geometry])

    infra = read_overture("base", "infrastructure", ["id", "names", "subtype", "class", "geometry"])
    lifts = infra[(infra["subtype"] == "aerialway") & infra.geom_type.isin(["LineString"])].to_crs(UTM)
    lifts = [{"k": row["class"], "p": drape(row.geometry, sampler, 2, 120, to_scene)} for _, row in lifts.iterrows()]

    land = read_overture("base", "land", ["id", "names", "subtype", "class", "elevation", "geometry"])
    land["name"] = land["names"].apply(latin)
    pk = land[(land["class"] == "peak") & land["name"].notna() & (land["elevation"] >= 3600) & land.within(window)]
    used = {p[1] for p in POINTS}
    peaks = []
    for _, row in pk.sort_values("elevation", ascending=False).iterrows():
        x, y = to_xy(row.geometry.x, row.geometry.y)
        if row["name"] in used or any(math.hypot(x - q["x"], y - q["y"]) < 2.2 for q in peaks):
            continue
        if any(math.hypot(x - to_xy(p[2], p[3])[0], y - to_xy(p[2], p[3])[1]) < 1.6 for p in POINTS):
            continue
        peaks.append({"name": row["name"], "elev": int(row["elevation"]), "x": round(x, 3), "y": round(y, 3),
                      "z": int(sampler.z([x], [y])[0])})
    peaks = peaks[:9]

    div = read_overture("divisions", "division", ["id", "names", "subtype", "class", "population", "geometry"])
    div["name"] = div["names"].apply(latin)
    div = div[div.within(window) & div["name"].notna() & (div["subtype"] == "locality")]
    wanted = ["Tahannaout", "Moulay Brahim", "Ouirgane", "Aghbalou", "Tizi Oussem", "Amizmiz"]
    villages = []
    for name in wanted:
        hit = div[div["name"].str.contains(name, case=False)].sort_values("population", ascending=False)
        if len(hit):
            g = hit.geometry.iloc[0]
            x, y = to_xy(g.x, g.y)
            villages.append({"name": name, "x": round(x, 3), "y": round(y, 3), "z": int(sampler.z([x], [y])[0])})

    points = []
    for pid, name, lon, lat, elev, kind, wind, score, callout in POINTS:
        x, y = to_xy(lon, lat)
        points.append({"id": pid, "name": name, "lon": lon, "lat": lat, "elev": elev, "kind": kind, "wind": wind,
                       "score": score, "callout": callout, "x": round(x, 3), "y": round(y, 3),
                       "z": int(sampler.z([x], [y])[0])})
    gauges = []
    for gid, river, place, lon, lat, clat, clon in GAUGES:
        p = gpd.GeoSeries([Point(lon, lat)], crs=4326).to_crs(UTM).iloc[0]
        snap = river_lines.interpolate(river_lines.project(p))
        off = snap.distance(p)
        if off > 2500:
            snap = p
        slon, slat = to_scene.transform(snap.x, snap.y)
        x, y = to_xy(slon, slat)
        gauges.append({"id": gid, "river": river, "place": place, "cell": [clat, clon], "x": round(x, 3),
                       "y": round(y, 3), "z": int(sampler.z([x], [y])[0])})
        print(f"  gauge {gid}: snapped {off:.0f} m")

    scene = {
        "window": WINDOW, "center": [LON0, LAT0], "km": [round(W_KM, 3), round(H_KM, 3)],
        "grid": [gw, gh], "zrange": [int(mesh.min()), int(mesh.max())],
        "park": {"name": "Parc National de Toubkal", "km2": round(area, 1),
                 "zmin": int(inside.min()), "zmax": int(inside.max())},
        "overture_release": OVERTURE_RELEASE,
        "boundary": boundary, "roads": roads, "trails": trails, "routes": routes, "rivers": rivers,
        "lakes": lakes, "lifts": lifts, "peaks": peaks, "villages": villages, "points": points, "gauges": gauges,
    }
    path = os.path.join(OUT, "scene.json")
    json.dump(scene, open(path, "w"), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    count = lambda k: sum(len(o["p"]) if isinstance(o, dict) else len(o) for o in scene[k])
    print("  " + ", ".join(f"{k} {len(scene[k])} ({count(k)} pts)" for k in
                           ["boundary", "roads", "trails", "routes", "rivers", "lakes", "lifts"]))
    print(f"  peaks {[p['name'] for p in peaks]}")
    print(f"  wrote scene.json ({os.path.getsize(path) / 1024:.0f} kB)")


if __name__ == "__main__":
    main()
