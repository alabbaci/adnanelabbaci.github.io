"""
run_workflow.py

NDVI monitoring of the Maâmora forest (Kénitra, Morocco), organised the way
Microsoft's AI Workflow for Planetary Computer Pro organises an inference job:

    1. inputs      area of interest, time range, mask, thresholds
    2. imagery     find the Sentinel-2 L2A scenes that cover the area
    3. partition   split the area into 2 km processing cells
    4. inference   cloud-masked NDVI composites, anomalies, trend and
                   vectorised canopy-change features (GeoJSON polygons with a
                   category and a confidence, the output shape MARS produces)
    5. catalog     write every output as a STAC item next to the data

The "model" here is the NDVI index plus change statistics, not MARS: MARS
extracts buildings, roads and railways and does not measure vegetation.

Sources, both read anonymously from public AWS S3 buckets:
    Sentinel-2 L2A cloud-optimised GeoTIFFs   s3://sentinel-cogs (Element 84)
    forest polygons                           Overture Maps, theme=base type=land

Outputs go to maamora/data/. Months already on disk are reused, except the
last REFRESH_MONTHS, so a scheduled run only fetches what is new.

    python maamora/pipeline/run_workflow.py
"""

import datetime as dt
import json
import math
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize, shapes
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform, transform_geom
from rasterio.windows import Window
from scipy import ndimage
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
CACHE = os.environ.get("MAAMORA_CACHE", os.path.join(HERE, ".cache"))

# ---------------------------------------------------------------- 1. inputs
AOI = (-6.83, 33.955, -5.86, 34.42)          # lon_min, lat_min, lon_max, lat_max
START = os.environ.get("MAAMORA_START", "2019-01")
REFRESH_MONTHS = int(os.environ.get("MAAMORA_REFRESH", "2"))
BASELINE_YEARS = (2019, 2023)                # "normal" for anomalies, inclusive
SUMMER = (7, 8, 9)                           # dry season: only tree canopy is green
MAX_SCENES = 3                               # scenes per monthly composite
MAX_SCREEN = 10                              # scenes screened per month, least cloudy first
CLEAR_SCL = (4, 5, 6, 7)                     # vegetation, bare, water, unclassified
CELL_KM = 2.0
CHANGE_T = 0.12                              # summer NDVI change that counts
MIN_PATCH_HA = 3.0
NDVI_MIN, NDVI_MAX = -0.2, 1.0               # range packed into the 8 bit PNGs

OVERTURE_RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-11-18.0")
S2 = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
S2_PREFIX = "sentinel-s2-l2a-cogs/29/S"
# Two granules, same orbit and UTM zone: QT covers the forest up to 34.3 N,
# QU the northern stands. Both sit on one 10 m grid, so they mosaic exactly.
TILES = {"QT": (699960.0, 3800040.0), "QU": (699960.0, 3900000.0)}   # upper left x, y
TILE_SIZE = 109800.0
UTM = "EPSG:32629"
RES = 40.0                                   # working resolution in UTM, metres
PIX = 85.0                                   # output pixel in Web Mercator units (about 70 m on the ground)

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")


def log(*a):
    print(*a, flush=True)


def http(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except Exception:
            if i == tries - 1:
                raise


# ------------------------------------------------------------------- grids
def utm_grid():
    xs, ys = transform("EPSG:4326", UTM, [AOI[0], AOI[0], AOI[2], AOI[2]], [AOI[1], AOI[3], AOI[1], AOI[3]])
    x0t = TILES["QT"][0]
    y0t = TILES["QU"][1]
    x0 = max(x0t, x0t + math.floor((min(xs) - x0t) / RES) * RES)
    x1 = x0t + math.ceil((max(xs) - x0t) / RES) * RES
    y1 = y0t - math.floor((y0t - max(ys)) / RES) * RES
    y0 = y0t - math.ceil((y0t - min(ys)) / RES) * RES
    return x0, y1, int(round((x1 - x0) / RES)), int(round((y1 - y0) / RES))


def merc_grid():
    xs, ys = transform("EPSG:4326", "EPSG:3857", [AOI[0], AOI[2]], [AOI[1], AOI[3]])
    w = int(math.ceil((xs[1] - xs[0]) / PIX))
    h = int(math.ceil((ys[1] - ys[0]) / PIX))
    return xs[0], ys[1], w, h


UX0, UY1, UW, UH = utm_grid()
UTM_T = from_origin(UX0, UY1, RES, RES)
MX0, MY1, W, H = merc_grid()
MERC_T = from_origin(MX0, MY1, PIX, PIX)


def merc_lonlat(x, y):
    lon, lat = transform("EPSG:3857", "EPSG:4326", [x], [y])
    return [round(lon[0], 6), round(lat[0], 6)]


def row_area_ha():
    """Ground area of one output pixel, per row (Web Mercator stretches with latitude)."""
    y = MY1 - (np.arange(H) + 0.5) * PIX
    lat = np.degrees(2 * np.arctan(np.exp(y / 6378137.0)) - math.pi / 2)
    return (PIX * np.cos(np.radians(lat))) ** 2 / 1e4


# ------------------------------------------------------------- forest mask
def forest_polygons():
    path = os.path.join(OUT, "forest.geojson")
    if os.path.exists(path) and not os.environ.get("MAAMORA_REBUILD_MASK"):
        gj = json.load(open(path))
        return [shape(f["geometry"]) for f in gj["features"]]
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import s3fs
    import shapely

    log("forest polygons from Overture", OVERTURE_RELEASE)
    fs = s3fs.S3FileSystem(anon=True)
    d = ds.dataset(f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=base/type=land/", filesystem=fs, format="parquet")
    f = ((pc.field("bbox", "xmin") < AOI[2]) & (pc.field("bbox", "xmax") > AOI[0])
         & (pc.field("bbox", "ymin") < AOI[3]) & (pc.field("bbox", "ymax") > AOI[1])
         & pc.field("class").isin(["forest", "wood"]))
    t = d.to_table(filter=f, columns=["geometry"]).to_pandas()
    geoms = [g.buffer(0) for g in shapely.from_wkb(t.geometry) if g.geom_type in ("Polygon", "MultiPolygon")]
    box = shape({"type": "Polygon", "coordinates": [[(AOI[0], AOI[1]), (AOI[2], AOI[1]), (AOI[2], AOI[3]), (AOI[0], AOI[3]), (AOI[0], AOI[1])]]})
    u = unary_union(geoms).intersection(box).simplify(0.0002)
    parts = [p for p in getattr(u, "geoms", [u]) if p.geom_type == "Polygon" and p.area > 2e-6]
    gj = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": round_geom(mapping(p))} for p in parts]}
    json.dump(gj, open(path, "w"), separators=(",", ":"))
    return parts


def round_geom(g, nd=5):
    def r(c):
        return [round(c[0], nd), round(c[1], nd)] if isinstance(c[0], (int, float)) else [r(x) for x in c]
    return {"type": g["type"], "coordinates": r(g["coordinates"])}


# ------------------------------------------------------- 2. imagery search
def load_meta():
    p = os.path.join(CACHE, "scenes.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def save_meta(meta):
    json.dump(meta, open(os.path.join(CACHE, "scenes.json"), "w"))


def list_month(tile, ym):
    y, m = ym.split("-")
    url = f"{S2}/?list-type=2&prefix={S2_PREFIX}/{tile}/{y}/{int(m)}/&delimiter=/"
    return sorted(set(re.findall(rf"(S2[A-D]_29S{tile}_\d{{8}}_\d+_L2A)/", http(url).decode())))


def scene_url(sid):
    tile, date = sid.split("_")[1][3:], sid.split("_")[2]
    return f"{S2}/{S2_PREFIX}/{tile}/{date[:4]}/{int(date[4:6])}/{sid}/"


def scene_meta(sid, meta):
    if sid not in meta:
        try:
            p = json.loads(http(scene_url(sid) + sid + ".json"))["properties"]
            meta[sid] = {"cloud": p.get("eo:cloud_cover", 100.0), "datetime": p.get("datetime")}
        except Exception as e:                      # a scene without metadata is skipped
            meta[sid] = {"cloud": 100.0, "datetime": None, "error": str(e)[:80]}
    return meta[sid]


def month_dates(ym, meta):
    """One entry per acquisition date: the newest processing of each tile."""
    by = {}
    for tile in TILES:
        for sid in list_month(tile, ym):
            date, seq = sid.split("_")[2], int(sid.split("_")[3])
            cur = by.setdefault(date, {}).get(tile)
            if cur is None or seq > int(cur.split("_")[3]):
                by[date][tile] = sid
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda s: scene_meta(s, meta), [s for d in by.values() for s in d.values()]))
    out = []
    for date, sc in sorted(by.items()):
        if "QT" not in sc:
            continue
        out.append({"date": date, "scenes": sc, "cloud": meta[sc["QT"]]["cloud"]})
    return out


# ------------------------------------------------------------ COG reading
def read_band(sid, band, native):
    """Read the part of one granule that falls in the working grid, at RES."""
    tx0, ty1 = TILES[sid.split("_")[1][3:]]
    left, right = max(UX0, tx0), min(UX0 + UW * RES, tx0 + TILE_SIZE)
    top, bottom = min(UY1, ty1), max(UY1 - UH * RES, ty1 - TILE_SIZE)
    if right <= left or top <= bottom:
        return None
    win = Window((left - tx0) / native, (ty1 - top) / native, (right - left) / native, (top - bottom) / native)
    shp = (int(round((top - bottom) / RES)), int(round((right - left) / RES)))
    with rasterio.open(scene_url(sid) + band + ".tif") as src:
        a = src.read(1, window=win, out_shape=shp, resampling=Resampling.nearest)
    return a, int(round((UY1 - top) / RES)), int(round((left - UX0) / RES))


def mosaic(scenes, band, native, dtype):
    out = np.zeros((UH, UW), dtype)
    for tile in ("QU", "QT"):                      # QT last: it wins in the overlap
        if tile in scenes:
            got = read_band(scenes[tile], band, native)
            if got is not None:
                a, r, c = got
                sub = out[r:r + a.shape[0], c:c + a.shape[1]]
                np.copyto(sub, a.astype(dtype), where=a > 0)
    return out


def clear_mask(scenes):
    return np.isin(mosaic(scenes, "SCL", 20.0, np.uint8), CLEAR_SCL)


def scene_ndvi(scenes, clear):
    # No reflectance offset is subtracted. From processing baseline 04.00 ESA adds
    # 1000 to every digital number, but the COGs in this archive already have it
    # removed: the darkest pixels of every scene used sit far below 1000, also where
    # the item's "earthsearch:boa_offset_applied" flag says false.
    with ThreadPoolExecutor(2) as ex:
        red, nir = ex.map(lambda b: mosaic(scenes, b, 10.0, np.float32), ("B04", "B08"))
    ok = clear & (red > 0) & (nir > 0)
    return np.where(ok, (nir - red) / (nir + red), np.nan).astype(np.float32)


def to_merc(a, resampling=Resampling.average):
    out = np.full((H, W), np.nan, np.float32)
    reproject(a, out, src_transform=UTM_T, src_crs=UTM, dst_transform=MERC_T, dst_crs="EPSG:3857",
              src_nodata=np.nan, dst_nodata=np.nan, resampling=resampling)
    return out


# ------------------------------------------------------------ PNG packing
def pack(a, lo=NDVI_MIN, hi=NDVI_MAX):
    q = np.clip(np.round((a - lo) / (hi - lo) * 254), 0, 254) + 1
    return np.where(np.isfinite(a), q, 0).astype(np.uint8)


def unpack(q, lo=NDVI_MIN, hi=NDVI_MAX):
    return np.where(q > 0, (q.astype(np.float32) - 1) / 254 * (hi - lo) + lo, np.nan).astype(np.float32)


def save_png(path, q):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(q, "L").save(path, optimize=True)


def load_png(path):
    return np.asarray(Image.open(path).convert("L"))


# ------------------------------------------------------- monthly composite
def build_month(ym, meta, forest_utm, keep):
    dates = month_dates(ym, meta)
    cand = sorted([d for d in dates if d["cloud"] < 95], key=lambda d: d["cloud"])[:MAX_SCREEN]
    nf = forest_utm.sum()

    def screen(d):
        try:
            d["clear"] = clear_mask(d["scenes"])
            d["frac"] = float((d["clear"] & forest_utm).sum() / nf)
        except Exception as e:
            log("   skip", d["date"], str(e)[:80])
            d["frac"] = 0.0
        return d

    with ThreadPoolExecutor(6) as ex:
        cand = list(ex.map(screen, cand))
    cand.sort(key=lambda d: -d["frac"])
    picked, covered = [], np.zeros_like(forest_utm)
    for d in cand:
        if len(picked) == MAX_SCENES or d["frac"] < 0.05:
            break
        # A scene is taken even when the forest is already covered: one pass that the
        # classification calls clear can still be hazy or dusty, and the maximum over
        # several passes drops it. Scenes that add almost nothing are left out.
        if picked and d["frac"] < 0.3 and ((d["clear"] & forest_utm & ~covered).sum() / nf) < 0.01:
            continue
        picked.append(d)
        covered |= d["clear"] & forest_utm
    info = {"listed": len(dates), "screened": len(cand), "used": [d["scenes"]["QT"] for d in picked],
            "dates": [d["date"] for d in picked]}
    if not picked:
        return None, info
    with ThreadPoolExecutor(3) as ex:
        stack = list(ex.map(lambda d: scene_ndvi(d["scenes"], d["clear"]), picked))
    comp = stack[0]
    for s in stack[1:]:                             # maximum value composite: clouds and haze lower NDVI
        comp = np.fmax(comp, s)
    m = to_merc(comp)
    m[~keep] = np.nan
    return m, info


# ----------------------------------------------------------------- helpers
def months_between(a, b):
    y, m = map(int, a.split("-"))
    out = []
    while f"{y:04d}-{m:02d}" <= b:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def r3(v):
    return None if v is None or not np.isfinite(v) else round(float(v), 3)


def nanmean0(stack):
    """Mean over axis 0 that stays NaN where nothing is valid, without warnings."""
    n = np.isfinite(stack).sum(0)
    return np.where(n > 0, np.nansum(stack, 0) / np.maximum(n, 1), np.nan).astype(np.float32)


def phi(z):
    return 0.5 * (1 + np.vectorize(math.erf)(z / math.sqrt(2)))


# -------------------------------------------------------------------- main
def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    today = dt.datetime.now(dt.timezone.utc)
    months = months_between(START, today.strftime("%Y-%m"))
    meta = load_meta()

    polys = forest_polygons()
    forest = rasterize([(transform_geom("EPSG:4326", "EPSG:3857", mapping(p)), 1) for p in polys],
                       out_shape=(H, W), transform=MERC_T, dtype="uint8").astype(bool)
    forest_utm = rasterize([(transform_geom("EPSG:4326", UTM, mapping(p)), 1) for p in polys],
                           out_shape=(UH, UW), transform=UTM_T, dtype="uint8").astype(bool)
    keep = ndimage.binary_dilation(forest, iterations=3)       # forest plus a 200 m rim for context
    area = np.repeat(row_area_ha()[:, None], W, 1)
    forest_ha = float(area[forest].sum())
    log(f"grid {W}x{H}, forest {forest_ha:,.0f} ha, {len(months)} months")

    # ---- monthly composites (reuse what is on disk)
    prev = {}
    sp = os.path.join(OUT, "series.json")
    if os.path.exists(sp):
        prev = json.load(open(sp)).get("scenes", {})
    refresh = set(months[-REFRESH_MONTHS:]) if REFRESH_MONTHS else set()
    cube, scenes = {}, {}

    def one(ym):
        png = os.path.join(OUT, "ndvi", ym + ".png")
        if os.path.exists(png) and ym not in refresh and ym in prev:
            q = load_png(png)
            if q.shape == (H, W):
                return ym, unpack(q), prev[ym]
        try:
            m, info = build_month(ym, meta, forest_utm, keep)
        except Exception as e:
            if os.path.exists(png) and ym in prev:             # keep the last good month
                log(ym, "failed, keeping previous:", str(e)[:100])
                return ym, unpack(load_png(png)), prev[ym]
            raise
        if m is None:
            log(ym, "no usable scene")
            if os.path.exists(png):
                os.remove(png)
            return ym, None, info
        save_png(png, pack(m))
        log(ym, f"{len(info['used'])}/{info['listed']} scenes, forest cover {np.isfinite(m[forest]).mean():.0%}")
        return ym, unpack(pack(m)), info

    with ThreadPoolExecutor(int(os.environ.get("MAAMORA_JOBS", "3"))) as ex:
        for ym, m, info in ex.map(one, months):
            scenes[ym] = info
            if m is not None:
                cube[ym] = m
    save_meta(meta)

    have = [ym for ym in months if ym in cube]
    T = len(have)
    stack = np.stack([cube[ym] for ym in have])                # T, H, W
    ym_year = np.array([int(s[:4]) for s in have])
    ym_mon = np.array([int(s[5:]) for s in have])

    # ---- forest-wide series
    fmean, fp10, fp90, fcov = [], [], [], []
    for t in range(T):
        v = stack[t][forest]
        ok = np.isfinite(v)
        fcov.append(round(float(ok.mean()), 3))
        if ok.mean() < 0.3:                                    # too little of the forest seen
            fmean.append(None); fp10.append(None); fp90.append(None)
            continue
        fmean.append(r3(np.average(v[ok], weights=area[forest][ok])))
        fp10.append(r3(np.percentile(v[ok], 10))); fp90.append(r3(np.percentile(v[ok], 90)))

    # ---- climatology per calendar month over the baseline years
    base = (ym_year >= BASELINE_YEARS[0]) & (ym_year <= BASELINE_YEARS[1])
    clim_mean, clim_std = [], []
    fm = np.array([np.nan if v is None else v for v in fmean])
    for mo in range(1, 13):
        sel = base & (ym_mon == mo)
        if sel.any():
            save_png(os.path.join(OUT, "clim", f"{mo:02d}.png"), pack(nanmean0(stack[sel])))
        v = fm[sel]
        v = v[np.isfinite(v)]
        clim_mean.append(r3(v.mean()) if len(v) else None)
        clim_std.append(r3(v.std(ddof=1)) if len(v) > 2 else None)
    anom = [r3(fm[t] - clim_mean[ym_mon[t] - 1]) if np.isfinite(fm[t]) and clim_mean[ym_mon[t] - 1] is not None else None for t in range(T)]
    zs = [r3(a / max(clim_std[ym_mon[t] - 1] or 0, 0.01)) if a is not None and clim_std[ym_mon[t] - 1] else None for t, a in enumerate(anom)]

    # ---- summer (dry season) canopy composites, one per year
    years = sorted(set(ym_year))
    summer = {}
    for y in years:
        sel = (ym_year == y) & np.isin(ym_mon, SUMMER)
        if sel.sum() >= 2:
            summer[int(y)] = np.nanmedian(np.where(np.isfinite(stack[sel]).sum(0) > 0, stack[sel], np.nan), 0) if sel.sum() > 1 else stack[sel][0]
    syears = sorted(summer)
    sstack = np.stack([summer[y] for y in syears])
    for y in syears:
        save_png(os.path.join(OUT, "summer", f"{y}.png"), pack(summer[y]))
    summer_mean = [r3(np.nanmean(summer[y][forest])) for y in syears]

    # ---- per pixel trend of summer NDVI (ordinary least squares, NDVI per year)
    x = np.array(syears, np.float32)
    okc = np.isfinite(sstack)
    n = okc.sum(0)
    xs = np.where(okc, x[:, None, None], 0)
    ysum = np.where(okc, sstack, 0)
    xm = xs.sum(0) / np.maximum(n, 1)
    ymn = ysum.sum(0) / np.maximum(n, 1)
    sxx = (np.where(okc, (x[:, None, None] - xm) ** 2, 0)).sum(0)
    sxy = (np.where(okc, (x[:, None, None] - xm) * (sstack - ymn), 0)).sum(0)
    trend = np.where((n >= max(4, len(syears) - 2)) & (sxx > 0) & forest, sxy / np.maximum(sxx, 1e-9), np.nan).astype(np.float32)
    save_png(os.path.join(OUT, "trend.png"), pack(trend, -0.05, 0.05))

    # ---- change features: latest summer against the first three summers
    nb = min(3, max(1, len(syears) - 1))
    ref = np.nanmedian(sstack[:nb], 0)
    delta = np.where(forest, sstack[-1] - ref, np.nan)
    save_png(os.path.join(OUT, "change.png"), pack(delta, -0.5, 0.5))
    dv = delta[np.isfinite(delta)]
    sigma = float(1.4826 * np.median(np.abs(dv - np.median(dv)))) if len(dv) else 0.05
    sigma = max(sigma, 0.01)
    # Confidence: how far the change stands out from the spread of change across the
    # forest, scaled down where the summer before does not show it as well.
    conf_px = 2 * phi(np.abs(np.nan_to_num(delta)) / (2 * sigma)) - 1
    prev_delta = np.nan_to_num(sstack[-2] - ref) if len(syears) > nb + 1 else np.nan_to_num(delta)
    persist = (np.sign(prev_delta) == np.sign(np.nan_to_num(delta))) & (np.abs(prev_delta) >= CHANGE_T / 2)
    conf_px = conf_px * (0.6 + 0.4 * persist)
    feats = []
    for cat, mask in (("canopy_loss", delta <= -CHANGE_T), ("canopy_gain", delta >= CHANGE_T)):
        mask = ndimage.binary_opening(np.nan_to_num(mask, nan=0).astype(bool), iterations=1)
        lab, nlab = ndimage.label(mask)
        if not nlab:
            continue
        idx = np.arange(1, nlab + 1)
        ha = ndimage.sum(area, lab, idx)
        for i in idx[ha >= MIN_PATCH_HA]:
            sel = lab == i
            series = [float(np.nanmean(s[sel])) if np.isfinite(s[sel]).any() else np.nan for s in sstack]
            steps = np.diff(series)
            k = int(np.nanargmin(steps) if cat == "canopy_loss" else np.nanargmax(steps)) if np.isfinite(steps).any() else None
            geom = [shape(g) for g, v in shapes(sel.astype(np.uint8), mask=sel, transform=MERC_T) if v == 1]
            g = unary_union(geom).simplify(PIX * 0.6)
            c = g.representative_point()
            feats.append({"type": "Feature",
                          "geometry": round_geom(transform_geom("EPSG:3857", "EPSG:4326", mapping(g))),
                          "properties": {
                              "category": cat,
                              "confidence": round(float(conf_px[sel].mean()), 2),
                              "area_ha": round(float(ha[i - 1]), 1),
                              "confirmed_previous_summer": round(float(persist[sel].mean()), 2),
                              "delta_ndvi": round(float(np.nanmean(delta[sel])), 3),
                              "ndvi_before": r3(np.nanmean(ref[sel])), "ndvi_after": r3(series[-1]),
                              "step_year": int(syears[k + 1]) if k is not None else None,
                              "summer_ndvi": [r3(v) for v in series],
                              "center": merc_lonlat(c.x, c.y)}})
    feats.sort(key=lambda f: -f["properties"]["area_ha"])
    for i, f in enumerate(feats):
        f["properties"]["id"] = i + 1
    change_meta = {"reference_summers": syears[:nb], "latest_summer": syears[-1], "threshold": CHANGE_T,
                   "min_patch_ha": MIN_PATCH_HA, "sigma": round(sigma, 3)}
    json.dump({"type": "FeatureCollection", "properties": change_meta, "features": feats},
              open(os.path.join(OUT, "change.geojson"), "w"), separators=(",", ":"))
    loss_ha = sum(f["properties"]["area_ha"] for f in feats if f["properties"]["category"] == "canopy_loss")
    gain_ha = sum(f["properties"]["area_ha"] for f in feats if f["properties"]["category"] == "canopy_gain")
    log(f"change features: {len(feats)}, loss {loss_ha:,.0f} ha, gain {gain_ha:,.0f} ha, sigma {sigma:.3f}")

    # ---- 3. partition: 2 km cells, each with its own series
    lat_mid = (AOI[1] + AOI[3]) / 2
    step = max(1, int(round(CELL_KM * 1000 / (PIX * math.cos(math.radians(lat_mid))))))
    cells, grid_feats = [], []
    clim_px = {}
    for mo in range(1, 13):
        sel = base & (ym_mon == mo)
        clim_px[mo] = nanmean0(stack[sel]) if sel.any() else np.full((H, W), np.nan, np.float32)
    last = T - 1
    for r in range(0, H, step):
        for c in range(0, W, step):
            fm_ = forest[r:r + step, c:c + step]
            if fm_.mean() < 0.25:
                continue
            blk = stack[:, r:r + step, c:c + step][:, fm_]
            cnt = np.isfinite(blk).sum(1)
            mean = np.where(cnt >= 0.3 * fm_.sum(), np.nansum(blk, 1) / np.maximum(cnt, 1), np.nan)
            cl = np.array([np.nanmean(clim_px[mo][r:r + step, c:c + step][fm_]) if np.isfinite(clim_px[mo][r:r + step, c:c + step][fm_]).any() else np.nan for mo in range(1, 13)])
            tr = trend[r:r + step, c:c + step][fm_]
            dl = delta[r:r + step, c:c + step][fm_]
            a_last = mean[last] - cl[ym_mon[last] - 1]
            x0, y1 = MX0 + c * PIX, MY1 - r * PIX
            x1, y0 = MX0 + min(c + step, W) * PIX, MY1 - min(r + step, H) * PIX
            ring = [merc_lonlat(x0, y1), merc_lonlat(x1, y1), merc_lonlat(x1, y0), merc_lonlat(x0, y0)]
            cid = len(cells)
            props = {"id": cid, "forest_ha": round(float(area[r:r + step, c:c + step][fm_].sum()), 1),
                     "trend": r3(np.nanmean(tr)) if np.isfinite(tr).any() else None,
                     "change": r3(np.nanmean(dl)) if np.isfinite(dl).any() else None,
                     "anomaly": r3(a_last)}
            cells.append({**props, "ndvi": [None if not np.isfinite(v) else int(round(v * 1000)) for v in mean],
                          "clim": [None if not np.isfinite(v) else int(round(v * 1000)) for v in cl]})
            grid_feats.append({"type": "Feature", "id": cid, "properties": props,
                               "geometry": {"type": "Polygon", "coordinates": [ring + [ring[0]]]}})
    json.dump({"type": "FeatureCollection", "features": grid_feats}, open(os.path.join(OUT, "grid.geojson"), "w"), separators=(",", ":"))

    # ---- series.json: everything the page charts
    save_png(os.path.join(OUT, "mask.png"), np.where(forest, 255, 0).astype(np.uint8))
    corners = [merc_lonlat(MX0, MY1), merc_lonlat(MX0 + W * PIX, MY1), merc_lonlat(MX0 + W * PIX, MY1 - H * PIX), merc_lonlat(MX0, MY1 - H * PIX)]
    n_listed = sum(s.get("listed", 0) for s in scenes.values())
    n_screen = sum(s.get("screened", 0) for s in scenes.values())
    n_used = sum(len(s.get("used", [])) for s in scenes.values())
    series = {
        "generated": today.strftime("%Y-%m-%dT%H:%MZ"),
        "aoi": list(AOI),
        "raster": {"width": W, "height": H, "corners": corners, "ndvi_range": [NDVI_MIN, NDVI_MAX],
                   "trend_range": [-0.05, 0.05], "change_range": [-0.5, 0.5], "pixel_m": round(PIX * math.cos(math.radians(lat_mid)), 1)},
        "forest_ha": round(forest_ha), "cell_km": CELL_KM, "baseline_years": list(BASELINE_YEARS),
        "months": have,
        "forest": {"mean": fmean, "p10": fp10, "p90": fp90, "cover": fcov, "anomaly": anom, "z": zs},
        "clim": {"mean": clim_mean, "std": clim_std},
        "summer": {"years": syears, "mean": summer_mean},
        "change": {**change_meta, "features": len(feats), "loss_ha": round(loss_ha), "gain_ha": round(gain_ha)},
        "workflow": {"scenes_listed": n_listed, "scenes_screened": n_screen, "scenes_used": n_used,
                     "months": T, "cells": len(cells), "tiles": [f"29S{t}" for t in TILES],
                     "overture_release": OVERTURE_RELEASE},
        "scenes": scenes,
        "cells": cells,
    }
    json.dump(series, open(sp, "w"), separators=(",", ":"))

    write_stac(have, scenes, fmean, fcov, corners, syears, change_meta, len(feats), today)
    log(f"done: {T} months, {len(cells)} cells, {n_used} scenes used of {n_listed} listed")


# -------------------------------------------------------------- 5. catalog
def write_stac(have, scenes, fmean, fcov, corners, syears, change_meta, nfeat, today):
    root = os.path.join(OUT, "stac")
    os.makedirs(os.path.join(root, "items"), exist_ok=True)
    for f in os.listdir(os.path.join(root, "items")):
        os.remove(os.path.join(root, "items", f))
    bbox = [AOI[0], AOI[1], AOI[2], AOI[3]]
    geom = {"type": "Polygon", "coordinates": [corners + [corners[0]]]}
    proj = {"proj:epsg": 3857, "proj:shape": [H, W], "proj:transform": [PIX, 0, MX0, 0, -PIX, MY1]}
    packing = {"nodata": 0, "scale": (NDVI_MAX - NDVI_MIN) / 254, "offset": NDVI_MIN - (NDVI_MAX - NDVI_MIN) / 254}
    links = [{"rel": "root", "href": "./collection.json", "type": "application/json"},
             {"rel": "self", "href": "./collection.json", "type": "application/json"}]

    def item(iid, datetime_, start, end, props, assets):
        links.append({"rel": "item", "href": f"./items/{iid}.json", "type": "application/geo+json"})
        it = {"type": "Feature", "stac_version": "1.0.0", "id": iid, "collection": "maamora-ndvi",
              "stac_extensions": ["https://stac-extensions.github.io/projection/v1.1.0/schema.json"],
              "bbox": bbox, "geometry": geom,
              "properties": {"datetime": datetime_, "start_datetime": start, "end_datetime": end, **proj, **props},
              "assets": assets,
              "links": [{"rel": "collection", "href": "../collection.json", "type": "application/json"},
                        {"rel": "root", "href": "../collection.json", "type": "application/json"}]}
        json.dump(it, open(os.path.join(root, "items", iid + ".json"), "w"), indent=1)

    for t, ym in enumerate(have):
        y, m = map(int, ym.split("-"))
        end = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)).isoformat()
        item(f"ndvi-{ym}", None, f"{ym}-01T00:00:00Z", f"{end}T23:59:59Z",
             {"maamora:forest_mean_ndvi": fmean[t], "maamora:forest_cover": fcov[t],
              "maamora:source_scenes": scenes[ym].get("used", []), "maamora:composite": "maximum value"},
             {"ndvi": {"href": f"../../ndvi/{ym}.png", "type": "image/png", "roles": ["data"],
                       "title": "Monthly NDVI, 8 bit packed", "raster:bands": [packing]}})
    item("canopy-change", None, f"{change_meta['reference_summers'][0]}-07-01T00:00:00Z", f"{change_meta['latest_summer']}-09-30T23:59:59Z",
         {"maamora:features": nfeat, **{f"maamora:{k}": v for k, v in change_meta.items()}},
         {"features": {"href": "../../change.geojson", "type": "application/geo+json", "roles": ["data"],
                       "title": "Canopy loss and gain polygons with category and confidence"},
          "delta": {"href": "../../change.png", "type": "image/png", "roles": ["data"], "title": "Summer NDVI change"},
          "trend": {"href": "../../trend.png", "type": "image/png", "roles": ["data"], "title": "Summer NDVI trend per year"}})
    coll = {"type": "Collection", "stac_version": "1.0.0", "id": "maamora-ndvi",
            "title": "Maâmora forest NDVI monitoring",
            "description": "Monthly cloud-masked Sentinel-2 NDVI composites of the Maâmora forest near Kénitra, Morocco, "
                           "with canopy-change features. Derived from Copernicus Sentinel-2 L2A data.",
            "license": "CC-BY-4.0", "updated": today.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "extent": {"spatial": {"bbox": [bbox]}, "temporal": {"interval": [[f"{have[0]}-01T00:00:00Z", None]]}},
            "providers": [{"name": "ESA / Copernicus", "roles": ["producer"], "url": "https://sentinels.copernicus.eu/"},
                          {"name": "Element 84 (sentinel-cogs on AWS)", "roles": ["host"], "url": "https://registry.opendata.aws/sentinel-2-l2a-cogs/"}],
            "links": links}
    json.dump(coll, open(os.path.join(root, "collection.json"), "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
