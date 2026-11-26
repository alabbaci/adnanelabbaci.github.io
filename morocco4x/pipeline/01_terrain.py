"""Build the hex terrain grid: data/world.json.

Inputs (all public, downloaded into pipeline/.cache on first run):
  * Elevation: Mapzen/Tilezen "terrarium" tiles on AWS Open Data (zoom 8, ~0.5 km
    pixels; SRTM/GMTED on land, GEBCO bathymetry at sea).
  * Land cover: ESA WorldCover 2021 v200 (10 m), read at its 1/32 overview
    (~320 m pixels) straight from the public S3 bucket.
  * Boundaries: geoBoundaries gbOpen MAR ADM1 (12 regions) and ADM2
    (75 provinces and prefectures); Natural Earth 10m countries for neighbours.

For every hex we aggregate the pixels that fall inside it: mean elevation,
relief (standard deviation of elevation), an averaged hillshade, and the share
of each WorldCover class. Terrain is then a rule on those numbers; the rules
are printed in the Almanac of the site (js/almanac.js) and must match this file.

Run:  python morocco4x/pipeline/01_terrain.py
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import sys
import urllib.request
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from shapely import STRtree, points
from shapely.geometry import shape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (CACHE, COLS, DATA, HEX_AREA_KM2, HEX_KM, LAT0, LON0, N, R_KM, ROWS, ROW_KM,  # noqa: E402
                    SIZE, SOURCES, XMAX, XMIN, YMAX, YMIN, hex_center, hex_index, neighbors, project, unproject)

Z = 8                                   # terrarium zoom
TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
WORLDCOVER = ("https://esa-worldcover.s3.amazonaws.com/v200/2021/map/"
              "ESA_WorldCover_10m_2021_v200_{tile}_Map.tif")
GB = "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/MAR/{lvl}/geoBoundaries-MAR-{lvl}.geojson"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{name}.geojson"

# WorldCover class codes
WC = {10: "tree", 20: "shrub", 30: "grass", 40: "crop", 50: "built", 60: "bare",
      70: "snow", 80: "water", 90: "wetland", 95: "mangrove", 100: "moss"}

# ---- terrain rules (keep in sync with the Almanac text) ----------------------
LAND_MIN = 0.5          # a hex is land when at least half its pixels are not water
HILL_STD = 55.0         # relief: std-dev of elevation inside the hex, metres
MOUNTAIN_STD = 150.0
MOUNTAIN_HIGH = (1800.0, 95.0)   # ...or mean elevation above 1800 m with std above 95 m
SNOW_ELEV = 3300.0      # summits above this height are drawn with snow
DESERT_BARE = 0.60
FARM_CROP = 0.30
FOREST_TREE = 0.28
OASIS_GREEN = 0.05      # crop+tree share inside a desert hex
MARSH_WET = 0.20
URBAN_BUILT = 0.10

BIOME = ["ocean", "coast", "lake", "farmland", "grassland", "scrub", "desert"]
F_FOREST, F_OASIS, F_MARSH, F_URBAN, F_SNOW, F_RIVER = 1, 2, 4, 8, 16, 32


def fetch(url: str, path) -> bool:
    if path.exists():
        return path.stat().st_size > 0
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            path.write_bytes(r.read())
        return True
    except Exception as e:  # ocean tiles do not exist
        if "404" in str(e) or "403" in str(e):
            path.write_bytes(b"")
            return False
        raise


def frame_lonlat():
    xs = np.linspace(XMIN, XMAX, 60)
    ys = np.linspace(YMIN, YMAX, 60)
    ex = np.concatenate([xs, xs, np.full(60, XMIN), np.full(60, XMAX)])
    ey = np.concatenate([np.full(60, YMIN), np.full(60, YMAX), ys, ys])
    lon, lat = unproject(ex, ey)
    return lon.min(), lon.max(), lat.min(), lat.max()


# ---------------------------------------------------------------- elevation --
def load_dem():
    lon_a, lon_b, lat_a, lat_b = frame_lonlat()
    n = 2 ** Z
    tx = lambda lon: int(math.floor((lon + 180) / 360 * n))
    ty = lambda lat: int(math.floor((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n))
    x0, x1, y0, y1 = tx(lon_a), tx(lon_b), ty(lat_b), ty(lat_a)
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    def get(xy):
        x, y = xy
        p = CACHE / "terrarium" / f"{Z}_{x}_{y}.png"
        fetch(TERRARIUM.format(z=Z, x=x, y=y), p)
        a = np.asarray(Image.open(io.BytesIO(p.read_bytes())).convert("RGB"), dtype=np.float32)
        return xy, a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768

    dem = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), dtype=np.float32)
    with ThreadPoolExecutor(8) as ex:
        for (x, y), a in ex.map(get, jobs):
            dem[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = a
    # pixel-centre lon/lat
    px = (np.arange(dem.shape[1]) + 0.5) / 256 + x0
    py = (np.arange(dem.shape[0]) + 0.5) / 256 + y0
    lon = px / n * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * py / n))))
    return dem, lon, lat


def hillshade(dem, lat):
    """Classic hillshade, light from the north-west at 45 degrees, in 0..1."""
    res = 156543.03392 * np.cos(np.radians(lat)) / 2 ** Z        # metres per pixel, per row
    land = np.maximum(dem, 0)                                     # no shading from bathymetry
    dzdx = (np.roll(land, -1, 1) - np.roll(land, 1, 1)) / (2 * res[:, None])
    dzdy = (np.roll(land, 1, 0) - np.roll(land, -1, 0)) / (2 * res[:, None])   # +y = north
    zf = 2.2                                                     # vertical exaggeration
    slope = np.arctan(zf * np.hypot(dzdx, dzdy))
    aspect = np.arctan2(dzdy, -dzdx)
    az, alt = math.radians(360 - 315 + 90), math.radians(45)
    hs = math.sin(alt) * np.cos(slope) + math.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(hs, 0, 1)


def aggregate_dem():
    dem, lon, lat = load_dem()
    hs = hillshade(dem, lat)
    LON, LAT = np.meshgrid(lon, lat)
    x, y = project(LON, LAT)
    idx = hex_index(x, y).ravel()
    ok = idx >= 0
    idx = idx[ok]
    z = dem.ravel()[ok].astype(np.float64)
    h = hs.ravel()[ok].astype(np.float64)
    cnt = np.bincount(idx, minlength=N).astype(np.float64)
    cnt[cnt == 0] = 1
    mean = np.bincount(idx, z, N) / cnt
    var = np.bincount(idx, z * z, N) / cnt - mean ** 2
    shade = np.bincount(idx, h, N) / cnt
    zmax = np.full(N, -1e9)
    np.maximum.at(zmax, idx, z)
    return mean, np.sqrt(np.maximum(var, 0)), shade, zmax


# --------------------------------------------------------------- land cover --
def aggregate_worldcover():
    import rasterio

    os.environ.setdefault("GDAL_HTTP_PROXY", os.environ.get("HTTPS_PROXY", ""))
    lon_a, lon_b, lat_a, lat_b = frame_lonlat()
    tiles = []
    for la in range(int(math.floor(lat_a / 3) * 3), int(lat_b) + 1, 3):
        for lo in range(int(math.floor(lon_a / 3) * 3), int(lon_b) + 1, 3):
            tiles.append((lo, la))
    codes = sorted(WC)
    counts = np.zeros((len(codes) + 1, N), dtype=np.float64)     # last row: no data (open sea)
    OUT = 1125                                                    # 36000 / 32

    def read(t):
        lo, la = t
        name = f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"
        p = CACHE / "worldcover" / f"{name}.npy"
        if p.exists():
            a = np.load(p)
            return t, (a if a.size else None)
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                              GDAL_HTTP_MAX_RETRY=3, GDAL_HTTP_RETRY_DELAY=2):
                with rasterio.open("/vsicurl/" + WORLDCOVER.format(tile=name)) as ds:
                    a = ds.read(1, out_shape=(OUT, OUT))
        except Exception as e:
            msg = str(e)
            if "404" in msg or "403" in msg or "does not exist" in msg or "not recognized" in msg:
                np.save(p, np.zeros(0, dtype=np.uint8))          # open-ocean tile
                return t, None
            raise
        np.save(p, a)
        return t, a

    with ThreadPoolExecutor(6) as ex:
        results = list(ex.map(read, tiles))
    got = 0
    for (lo, la), a in results:
        if a is None:
            continue
        got += 1
        lon = lo + (np.arange(OUT) + 0.5) * 3 / OUT
        lat = la + 3 - (np.arange(OUT) + 0.5) * 3 / OUT
        LON, LAT = np.meshgrid(lon, lat)
        x, y = project(LON, LAT)
        idx = hex_index(x, y).ravel()
        v = a.ravel()
        ok = idx >= 0
        # weight by cos(lat): pixels are equal-angle, hexes equal-area
        w = np.cos(np.radians(LAT)).ravel()
        for k, code in enumerate(codes):
            m = ok & (v == code)
            if m.any():
                counts[k] += np.bincount(idx[m], w[m], N)
        m = ok & (v == 0)
        if m.any():
            counts[-1] += np.bincount(idx[m], w[m], N)
    print(f"worldcover: {got} land tiles of {len(tiles)} candidates")
    return {WC[c]: counts[k] for k, c in enumerate(codes)}, counts.sum(0)


# --------------------------------------------------------------- boundaries --
def load_json(url, path):
    fetch(url, path)
    return json.loads(path.read_text())


def main():
    DATA.mkdir(exist_ok=True)
    cols = np.tile(np.arange(COLS), ROWS)
    rows = np.repeat(np.arange(ROWS), COLS)
    cx, cy = hex_center(cols, rows)
    clon, clat = unproject(cx, cy)

    print(f"grid {COLS} x {ROWS} = {N} hexes of {HEX_KM} km ({HEX_AREA_KM2:.1f} km2)")
    elev, relief, shade, zmax = aggregate_dem()
    wc, wc_total = aggregate_worldcover()

    # WorldCover marks open sea as "no data" and inland/coastal water as class 80:
    # both count as water. Hexes outside every tile (wc_total == 0) are open ocean.
    land_px = sum(v for k, v in wc.items() if k != "water")
    land_frac = np.where(wc_total > 0, land_px / np.maximum(wc_total, 1e-9), 0.0)
    is_land = land_frac >= LAND_MIN
    frac = {k: np.where(land_px > 0, v / np.maximum(land_px, 1e-9), 0.0) for k, v in wc.items() if k != "water"}

    # ---- who owns each land hex
    adm2 = load_json(GB.format(lvl="ADM2"), CACHE / "adm2.geojson")
    adm1 = load_json(GB.format(lvl="ADM1"), CACHE / "adm1.geojson")
    ne = load_json(NE.format(name="ne_10m_admin_0_countries"), CACHE / "ne" / "ne_10m_admin_0_countries.geojson")
    provinces = json.loads((SOURCES / "provinces.json").read_text())   # census table + ADM2 name match
    regions = json.loads((SOURCES / "regions_base.json").read_text())  # id, name, iso
    reg_index = {r["id"]: i + 1 for i, r in enumerate(regions)}
    prov_by_shape = {p["shape_name"]: i + 1 for i, p in enumerate(provinces)}

    pts = points(clon, clat)

    def assign(geoms, values, out, mask):
        tree = STRtree(geoms)
        a, b = tree.query(pts[mask], predicate="within")
        where = np.flatnonzero(mask)
        out[where[a]] = np.asarray(values)[b]

    prov = np.zeros(N, dtype=np.int32)
    g2 = [shape(f["geometry"]) for f in adm2["features"]]
    v2 = [prov_by_shape[f["properties"]["shapeName"]] for f in adm2["features"]]
    assign(g2, v2, prov, is_land)

    region = np.zeros(N, dtype=np.int32)
    prov_region = np.array([0] + [reg_index[p["region"]] for p in provinces])
    region[:] = prov_region[prov]
    # land inside a region polygon but in no province polygon (slivers between the two layers)
    g1 = [shape(f["geometry"]) for f in adm1["features"]]
    iso_to_id = {r["iso"]: r["id"] for r in regions}
    v1 = [reg_index[iso_to_id[f["properties"]["shapeISO"]]] for f in adm1["features"]]
    reg1 = np.zeros(N, dtype=np.int32)
    assign(g1, v1, reg1, is_land)

    # neighbours
    names = ["", "Algeria", "Mauritania", "Spain", "Portugal", "Mali", "Gibraltar"]
    want = {"Algeria": 1, "Mauritania": 2, "Spain": 3, "Portugal": 4, "Mali": 5, "Gibraltar": 6}
    gc, vc = [], []
    for f in ne["features"]:
        nm = f["properties"].get("NAME")
        if nm in want:
            gc.append(shape(f["geometry"]))
            vc.append(want[nm])
    country = np.zeros(N, dtype=np.int32)
    assign(gc, vc, country, is_land & (prov == 0) & (reg1 == 0))

    # Coastal and border hexes whose centre falls just outside every polygon:
    # give them the owner of the nearest already-assigned land neighbour (two passes).
    def owner_code():
        return np.where(prov > 0, prov, np.where(country > 0, -country, 0))
    for _ in range(2):
        own = owner_code()
        todo = np.flatnonzero(is_land & (own == 0))
        for i in todo:
            c, r = int(cols[i]), int(rows[i])
            votes = Counter(own[rr * COLS + cc] for cc, rr in neighbors(c, r) if own[rr * COLS + cc] != 0)
            if votes:
                o = votes.most_common(1)[0][0]
                if o > 0:
                    prov[i] = o
                    region[i] = prov_region[o]
                else:
                    country[i] = -o
    in_play = prov > 0

    # ---- water: ocean vs lake (ocean = water connected to the frame edge)
    ocean = np.zeros(N, dtype=bool)
    is_water = ~is_land
    dq = deque()
    for i in range(N):
        c, r = int(cols[i]), int(rows[i])
        if is_water[i] and (c in (0, COLS - 1) or r in (0, ROWS - 1)):
            ocean[i] = True
            dq.append(i)
    while dq:
        i = dq.popleft()
        for cc, rr in neighbors(int(cols[i]), int(rows[i])):
            j = rr * COLS + cc
            if is_water[j] and not ocean[j]:
                ocean[j] = True
                dq.append(j)
    lake = is_water & ~ocean

    # ---- classify
    biome = np.zeros(N, dtype=np.uint8)
    rel = np.zeros(N, dtype=np.uint8)
    feat = np.zeros(N, dtype=np.uint8)
    green = frac["tree"] + frac["crop"]
    for i in range(N):
        if lake[i]:
            biome[i] = 2
            continue
        if ocean[i]:
            c, r = int(cols[i]), int(rows[i])
            biome[i] = 1 if any(is_land[rr * COLS + cc] for cc, rr in neighbors(c, r)) else 0
            continue
        bare, crop, tree, grass, shrub = (frac[k][i] for k in ("bare", "crop", "tree", "grass", "shrub"))
        if bare >= DESERT_BARE:
            b = 6
        elif crop >= FARM_CROP and crop >= max(grass, shrub, bare) * 0.8:
            b = 3
        else:
            b = {0: 4, 1: 5, 2: 6, 3: 3, 4: 4}[int(np.argmax([grass, shrub, bare, crop, tree]))]
        biome[i] = b
        if relief[i] >= MOUNTAIN_STD or (elev[i] >= MOUNTAIN_HIGH[0] and relief[i] >= MOUNTAIN_HIGH[1]):
            rel[i] = 2
        elif relief[i] >= HILL_STD:
            rel[i] = 1
        f = 0
        if tree >= FOREST_TREE:
            f |= F_FOREST
        if b == 6 and rel[i] < 2 and green[i] >= OASIS_GREEN:
            f |= F_OASIS
        if frac["wetland"][i] + frac["mangrove"][i] >= MARSH_WET:
            f |= F_MARSH
        if frac["built"][i] >= URBAN_BUILT:
            f |= F_URBAN
        if rel[i] == 2 and zmax[i] >= SNOW_ELEV:
            f |= F_SNOW
        feat[i] = f

    # ---- report
    play_km2 = in_play.sum() * HEX_AREA_KM2
    print(f"land hexes {is_land.sum()}  in play {in_play.sum()} ({play_km2:,.0f} km2)  lakes {lake.sum()}")
    print("biomes in play:", {BIOME[b]: int(((biome == b) & in_play).sum()) for b in range(3, 7)})
    print("relief in play:", {k: int(((rel == v) & in_play).sum()) for k, v in (("flat", 0), ("hills", 1), ("mountains", 2))})
    print("features in play:", {k: int((((feat & v) > 0) & in_play).sum()) for k, v in
                                (("forest", 1), ("oasis", 2), ("marsh", 4), ("urban", 8), ("snow", 16))})
    print("unowned land hexes:", int((is_land & ~in_play & (country == 0)).sum()))
    per_region = Counter(region[in_play].tolist())
    for r in regions:
        print(f"  {r['name']:<28} {per_region[reg_index[r['id']]] * HEX_AREA_KM2:>10,.0f} km2")

    def b64(a, dtype):
        return base64.b64encode(np.ascontiguousarray(a.astype(dtype)).tobytes()).decode()

    pct = lambda k: np.clip(np.rint(frac[k] * 100), 0, 100)
    out = {
        "cols": COLS, "rows": ROWS, "hexKm": HEX_KM, "hexAreaKm2": round(HEX_AREA_KM2, 2),
        "proj": {"type": "laea", "lon0": LON0, "lat0": LAT0, "R": R_KM, "xmin": XMIN, "ymax": YMAX},
        "biomes": BIOME, "countries": names,
        "regions": [r["id"] for r in regions],
        "provinces": [p["id"] for p in provinces],
        "arrays": {
            "biome": b64(biome, np.uint8), "relief": b64(rel, np.uint8), "feat": b64(feat, np.uint8),
            "elev": b64(np.clip(np.rint(elev), -32000, 32000), "<i2"),
            "shade": b64(np.clip(np.rint(shade * 255), 0, 255), np.uint8),
            "region": b64(region, np.uint8), "province": b64(prov, np.uint8), "country": b64(country, np.uint8),
            "crop": b64(pct("crop"), np.uint8), "tree": b64(pct("tree"), np.uint8),
            "built": b64(pct("built"), np.uint8), "bare": b64(pct("bare"), np.uint8),
        },
    }
    (DATA / "world.json").write_text(json.dumps(out, separators=(",", ":")))
    np.savez_compressed(CACHE / "grid.npz", biome=biome, relief=rel, feat=feat, elev=elev, region=region,
                        province=prov, country=country, land=is_land, in_play=in_play, relief_std=relief)
    print(f"wrote {DATA / 'world.json'} ({(DATA / 'world.json').stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
