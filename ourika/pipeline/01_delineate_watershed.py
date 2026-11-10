"""
01_delineate_watershed.py

Delineates the Ourika watershed (High Atlas, Morocco) upstream of the
Aghbalou gauging station from the Copernicus GLO-30 DEM (public AWS S3
bucket, anonymous access) and exports everything the live dashboard needs:

    ourika/data/watershed.geojson   basin boundary (1 polygon)
    ourika/data/subbasins.geojson   incremental sub-catchments + forecast points
    ourika/data/rivers.geojson      DEM-derived stream network (upstream_km2 per reach)
    ourika/data/basin.json          stats, hypsometry, main-stem long profile

Method: pit / depression filling + flat resolution, D8 flow direction and
accumulation (pysheds), outlet snapped to the main stem near Aghbalou.

Requirements: pysheds, rasterio, numpy, shapely
"""

import json
import os
import urllib.request

import numpy as np

if not hasattr(np, "in1d"):      # pysheds 0.5 still calls the alias removed in NumPy 2.4
    np.in1d = np.isin

import rasterio
from rasterio.features import shapes
from rasterio.merge import merge
from pysheds.grid import Grid
from pysheds.sview import Raster
from shapely.geometry import shape, mapping, LineString
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
CACHE = os.environ.get("OURIKA_DEM_CACHE", os.path.join(HERE, ".cache"))
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

TILES = ["N31_00_W008_00", "N30_00_W008_00"]
S3 = "https://copernicus-dem-30m.s3.amazonaws.com"
# Working window (lon_min, lat_min, lon_max, lat_max) — generous around the basin.
WINDOW = (-8.05, 30.95, -7.45, 31.45)
# Aghbalou hydrometric station (ABH Tensift), the classic basin outlet.
OUTLET_GUESS = (-7.745, 31.317)
SNAP_KM2 = 300.0          # snap the outlet to a cell draining at least this much
STREAM_KM2 = 1.5          # channel initiation threshold for the drawn network
SUBBASIN_KM2 = 12.0       # reaches above this split the basin into sub-catchments
MIN_SUBBASIN_KM2 = 12.0   # smaller units are folded into the one downstream
DIRMAP = (64, 128, 1, 2, 4, 8, 16, 32)  # N, NE, E, SE, S, SW, W, NW


def fetch_dem():
    paths = []
    for t in TILES:
        name = f"Copernicus_DSM_COG_10_{t}_DEM"
        p = os.path.join(CACHE, name + ".tif")
        if not os.path.exists(p):
            print("downloading", name)
            urllib.request.urlretrieve(f"{S3}/{name}/{name}.tif", p)
        paths.append(p)
    srcs = [rasterio.open(p) for p in paths]
    mosaic, transform = merge(srcs, bounds=WINDOW)
    profile = srcs[0].profile.copy()
    profile.update(driver="GTiff", height=mosaic.shape[1], width=mosaic.shape[2],
                   transform=transform, compress="deflate", nodata=-9999.0,
                   tiled=False, blockxsize=None, blockysize=None)
    for k in ("blockxsize", "blockysize", "interleave"):
        profile.pop(k, None)
    out = os.path.join(CACHE, "ourika_window.tif")
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(mosaic)
    return out


def cell_area_km2(grid, shape_):
    """Per-row cell area for a geographic (lat/lon) grid."""
    a = grid.affine
    rows = np.arange(shape_[0])
    lat = a.f + (rows + 0.5) * a.e
    dy = abs(a.e) * 110.574
    dx = abs(a.a) * 111.320 * np.cos(np.radians(lat))
    return np.repeat((dx * dy)[:, None], shape_[1], axis=1)


def rc_to_xy(grid, r, c):
    a = grid.affine
    return (a.c + (c + 0.5) * a.a, a.f + (r + 0.5) * a.e)


def polygon_of(grid, mask):
    polys = [shape(g) for g, v in shapes(mask.astype(np.uint8), mask=mask, transform=grid.affine)]
    return unary_union(polys)


def main():
    dem_path = fetch_dem()
    grid = Grid.from_raster(dem_path)
    dem = grid.read_raster(dem_path)
    filled = grid.fill_depressions(grid.fill_pits(dem))
    inflated = grid.resolve_flats(filled)
    fdir = grid.flowdir(inflated, dirmap=DIRMAP)
    acc = grid.accumulation(fdir, dirmap=DIRMAP)

    area = cell_area_km2(grid, dem.shape)
    mean_cell = float(area.mean())
    acc_km2 = np.asarray(acc) * mean_cell

    # --- outlet + basin -------------------------------------------------
    R = lambda m: Raster(np.asarray(m, dtype=bool), viewfinder=acc.viewfinder)
    x, y = grid.snap_to_mask(R(acc_km2 > SNAP_KM2), OUTLET_GUESS)
    catch = grid.catchment(x=x, y=y, fdir=fdir, dirmap=DIRMAP, xytype="coordinate")
    cmask = np.asarray(catch).astype(bool)
    basin_km2 = float(area[cmask].sum())
    elev = np.asarray(dem)[cmask]
    print(f"outlet {x:.4f},{y:.4f}  area {basin_km2:.1f} km2  "
          f"elev {elev.min():.0f}-{elev.max():.0f} m")

    basin_poly = polygon_of(grid, cmask)
    if basin_poly.geom_type == "MultiPolygon":
        basin_poly = max(basin_poly.geoms, key=lambda g: g.area)
    basin_s = basin_poly.simplify(0.0006)

    # --- stream network --------------------------------------------------
    branches = grid.extract_river_network(fdir, R((acc_km2 > STREAM_KM2) & cmask),
                                          dirmap=DIRMAP)
    full_inv = ~grid.affine

    def sample_acc(pt):
        c, r = full_inv * pt
        r, c = int(r), int(c)
        r = min(max(r, 1), acc_km2.shape[0] - 2)
        c = min(max(c, 1), acc_km2.shape[1] - 2)
        return float(acc_km2[r - 1:r + 2, c - 1:c + 2].max())   # vertices sit on cell edges

    river_feats = []
    for b in branches["features"]:
        coords = b["geometry"]["coordinates"]
        if len(coords) < 2:
            continue
        up = max(sample_acc(coords[0]), sample_acc(coords[-1]),
                 sample_acc(coords[len(coords) // 2]))
        line = LineString(coords).simplify(0.00025)
        river_feats.append({
            "type": "Feature",
            "properties": {"upstream_km2": round(up, 1),
                           "length_km": round(LineString(coords).length * 100.0, 2)},
            "geometry": mapping(line),
        })
    print(len(river_feats), "reaches")

    # --- main stem (walk upstream from the outlet) ------------------------
    grid2 = grid
    dem_np = np.asarray(dem)
    fd = np.asarray(fdir)
    step = {64: (-1, 0), 128: (-1, 1), 1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1),
            16: (0, -1), 32: (-1, -1)}
    oc, orow = full_inv * (x, y)
    r, c = int(orow), int(oc)
    path = [(r, c)]
    while True:   # walk upstream along the largest contributing neighbour
        best, bv = None, 0
        for d, (dr, dc) in step.items():
            rn, cn = r - dr, c - dc
            if 0 <= rn < fd.shape[0] and 0 <= cn < fd.shape[1] and fd[rn, cn] == d and cmask[rn, cn]:
                if acc_km2[rn, cn] > bv:
                    best, bv = (rn, cn), acc_km2[rn, cn]
        if best is None:
            break
        r, c = best
        path.append(best)
    # --- sub-catchments ---------------------------------------------------
    # Pour points: every tributary draining more than SUBBASIN_KM2 where it meets
    # the main stem, plus the main stem itself just above that junction.
    pours = [(basin_km2 + 1, path[0])]
    for i, (r, c) in enumerate(path[:-1]):
        for d, (dr, dc) in step.items():
            rn, cn = r - dr, c - dc
            if (rn, cn) != path[i + 1] and fd[rn, cn] == d and cmask[rn, cn] \
                    and acc_km2[rn, cn] > SUBBASIN_KM2:
                pours.append((float(acc_km2[rn, cn]), (rn, cn)))
                pours.append((float(acc_km2[path[i + 1]]), path[i + 1]))
    pours.sort(key=lambda t: -t[0])
    label = np.zeros(dem.shape, dtype=np.int32)
    parent = {}
    for i, (_, pt) in enumerate(pours, start=1):
        c = grid2.catchment(x=pt[1], y=pt[0], fdir=fdir, dirmap=DIRMAP, xytype="index")
        m = np.asarray(c).astype(bool) & cmask
        if m.any():
            parent[i] = int(np.bincount(label[m]).argmax())
        label[m] = i
    for i in range(len(pours), 1, -1):       # fold slivers into their downstream unit
        m = label == i
        if 0 < area[m].sum() < MIN_SUBBASIN_KM2:
            label[m] = parent.get(i, 1)
    if area[label == 1].sum() < MIN_SUBBASIN_KM2:   # remnant below the last junction
        label[label == 1] = 2
    sub_feats = []
    for i in range(1, len(pours) + 1):
        m = label == i
        a_km2 = float(area[m].sum())
        if a_km2 == 0:
            continue
        poly = polygon_of(grid2, m)
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)
        rr, cc = np.nonzero(m)
        rp = poly.representative_point()
        e = dem_np[m]
        sub_feats.append({
            "type": "Feature",
            "properties": {
                "area_km2": round(a_km2, 1),
                "elev_min": int(e.min()), "elev_mean": int(e.mean()), "elev_max": int(e.max()),
                "upstream_km2": round(min(pours[i - 1][0], basin_km2), 1),
                "pt_lon": round(rp.x, 4), "pt_lat": round(rp.y, 4),
                "pour_lon": round(rc_to_xy(grid2, *pours[i - 1][1])[0], 4),
                "pour_lat": round(rc_to_xy(grid2, *pours[i - 1][1])[1], 4),
            },
            "geometry": mapping(poly.simplify(0.0006)),
        })
    # north -> south is downstream -> upstream here; order by mean elevation
    sub_feats.sort(key=lambda f: f["properties"]["elev_mean"])
    for n, f in enumerate(sub_feats, start=1):
        f["properties"]["id"] = f"SB{n:02d}"
    print(len(sub_feats), "sub-basins:",
          [(f["properties"]["id"], f["properties"]["area_km2"]) for f in sub_feats])

    # --- hypsometry + main-stem profile ----------------------------------
    edges = np.arange(1000, 4400, 200)
    hist = [float(area[cmask & (dem_np >= lo) & (dem_np < lo + 200)].sum()) for lo in edges]
    dist, prof, main = 0.0, [], []
    a = grid2.affine
    for i, (r, c) in enumerate(path):
        if i:
            pr, pc_ = path[i - 1]
            lat = a.f + (r + 0.5) * a.e
            dist += np.hypot((r - pr) * abs(a.e) * 110.574,
                             (c - pc_) * a.a * 111.320 * np.cos(np.radians(lat)))
        if i % 8 == 0 or i == len(path) - 1:
            prof.append([round(dist, 2), int(dem_np[r, c])])
            main.append([round(v, 5) for v in rc_to_xy(grid2, r, c)])
    print(f"main stem {dist:.1f} km, source at {prof[-1][1]} m")

    hi = np.unravel_index(np.argmax(np.where(cmask, dem_np, -1)), dem_np.shape)
    stats = {
        "name": "Ourika watershed at Aghbalou",
        "outlet": {"lon": round(float(x), 5), "lat": round(float(y), 5),
                   "elev_m": int(dem_np[int(orow), int(oc)])},
        "area_km2": round(basin_km2, 1),
        "perimeter_km": round(basin_poly.length * 104.0, 1),
        "elev_min": int(elev.min()), "elev_mean": int(elev.mean()), "elev_max": int(elev.max()),
        "summit": {"lon": round(rc_to_xy(grid2, *hi)[0], 5), "lat": round(rc_to_xy(grid2, *hi)[1], 5)},
        "main_stem_km": round(dist, 1),
        "mean_slope_main_stem_pct": round((prof[-1][1] - prof[0][1]) / (dist * 10.0), 1),
        "bbox": [round(v, 4) for v in basin_poly.bounds],
        "hypsometry": {"band_m": 200, "from_m": [int(e) for e in edges],
                       "area_km2": [round(h, 1) for h in hist]},
        "profile": prof,
        "dem": "Copernicus GLO-30 (ESA / DLR / Airbus), 1 arc-second",
    }
    dump = lambda name, obj: json.dump(obj, open(os.path.join(OUT, name), "w"),
                                       separators=(",", ":"))
    dump("watershed.geojson", {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": stats["name"], "area_km2": stats["area_km2"]},
         "geometry": mapping(basin_s)}]})
    dump("subbasins.geojson", {"type": "FeatureCollection", "features": sub_feats})
    dump("rivers.geojson", {"type": "FeatureCollection", "features": river_feats + [
        {"type": "Feature", "properties": {"main_stem": True, "upstream_km2": stats["area_km2"],
                                           "length_km": stats["main_stem_km"]},
         "geometry": {"type": "LineString", "coordinates": main}}]})
    dump("basin.json", stats)


if __name__ == "__main__":
    main()
