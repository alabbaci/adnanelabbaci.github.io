"""
01_build_study_area.py

Builds the static geography of the Dakhla dashboard from the Overture Maps
coastline (GeoParquet on AWS S3, anonymous access) and the Copernicus GLO-30
DEM (public AWS S3 bucket) and exports everything the live page needs:

    dakhla/data/area.geojson       watch area outline (peninsula + lagoon + east shore)
    dakhla/data/sectors.geojson    forecast sectors + one forecast point each
    dakhla/data/shoreline.geojson  Atlantic and lagoon shorelines
    dakhla/data/area.json          stats, hypsometry, spine profile of the peninsula

Method: the Rio de Oro peninsula runs almost straight from its southern tip
to the head of the lagoon. Everything is measured along that axis: the land
west of the lagoon is the peninsula, the water it encloses is the lagoon, and
both are sliced into bands across the axis. A strip of the mainland facing
the lagoon closes the watch area.

Requirements: pyarrow, s3fs, geopandas, shapely, rasterio, numpy
"""

import json
import math
import os
import urllib.request

import geopandas as gpd
import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as ds
import rasterio
import rasterio.features
import rasterio.windows
import s3fs
import shapely
from shapely.geometry import LineString, Point, Polygon, mapping
from shapely.ops import transform as shp_transform

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
CACHE = os.environ.get("DAKHLA_CACHE", os.path.join(HERE, ".cache"))
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

OVERTURE_RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-10-21.0")
S3_ROOT = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
DEM_TILE = "Copernicus_DSM_COG_10_N23_00_W016_00_DEM"
DEM_S3 = "https://copernicus-dem-30m.s3.amazonaws.com"
UTM = "EPSG:32628"                       # UTM 28N covers Dakhla
WINDOW = (-16.10, 23.55, -15.60, 24.10)  # lon_min, lat_min, lon_max, lat_max

# Axis of the peninsula: southern tip (near Lassarga) to the head of the lagoon (PK 25).
TIP = (-15.995, 23.628)
HEAD = (-15.772, 23.916)
GAP_M = 300              # keep this clear of the tip and of the lagoon head when cutting
PENINSULA_BANDS = 6
LAGOON_BANDS = 3
SHORE_BANDS = 2
SHORE_STRIP_M = 4000     # depth of the mainland strip facing the lagoon
PROFILE_STEP_M = 250
HYPS_BAND_M = 5
# Open-Meteo marine grid cell on the open Atlantic, abeam of the city.
MARINE_POINT = (-16.05, 23.70)


def s3():
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    cfg = {"proxies": {"https": proxy, "http": proxy}} if proxy else {}
    return s3fs.S3FileSystem(anon=True, config_kwargs=cfg,
                             client_kwargs={"region_name": "us-west-2"})


def read_land():
    xmin, ymin, xmax, ymax = WINDOW
    flt = ((pc.field("bbox", "xmin") < xmax) & (pc.field("bbox", "xmax") > xmin)
           & (pc.field("bbox", "ymin") < ymax) & (pc.field("bbox", "ymax") > ymin)
           & (pc.field("class") == "land"))
    dataset = ds.dataset(f"{S3_ROOT}/theme=base/type=land/", filesystem=s3(), format="parquet")
    df = dataset.to_table(filter=flt, columns=["id", "class", "geometry"]).to_pandas()
    geoms = [g for g in shapely.from_wkb(df["geometry"]) if g.geom_type in ("Polygon", "MultiPolygon")]
    land = shapely.union_all(geoms).intersection(shapely.box(*WINDOW))
    return gpd.GeoSeries([land], crs=4326).to_crs(UTM).iloc[0]


def fetch_dem():
    p = os.path.join(CACHE, DEM_TILE + ".tif")
    if not os.path.exists(p):
        print("downloading", DEM_TILE)
        urllib.request.urlretrieve(f"{DEM_S3}/{DEM_TILE}/{DEM_TILE}.tif", p)
    return p


def parts(geom):
    return list(getattr(geom, "geoms", [geom]))


def main():
    to_utm = gpd.GeoSeries([Point(TIP), Point(HEAD), Point(MARINE_POINT)], crs=4326).to_crs(UTM)
    tip, head = np.array(to_utm.iloc[0].coords[0]), np.array(to_utm.iloc[1].coords[0])
    length = float(np.linalg.norm(head - tip))
    ax = (head - tip) / length            # unit vector along the peninsula
    nx = np.array([-ax[1], ax[0]])        # unit vector across it (positive = Atlantic side)

    def st(x, y):                          # UTM -> (along, across)
        d = np.stack([np.asarray(x) - tip[0], np.asarray(y) - tip[1]])
        return ax @ d.reshape(2, -1), nx @ d.reshape(2, -1)

    def band(s0, s1, half=60000):          # rectangle across the axis between s0 and s1
        c = [tip + ax * s + nx * t for s, t in ((s0, -half), (s1, -half), (s1, half), (s0, half))]
        return Polygon(c)

    land = read_land()
    pt = lambda lon, lat: gpd.GeoSeries([Point(lon, lat)], crs=4326).to_crs(UTM).iloc[0]

    # Land south of the lagoon head splits cleanly into peninsula and mainland.
    south = land.intersection(band(-20000, length - GAP_M))
    pieces = sorted(parts(south), key=lambda g: g.area, reverse=True)
    peninsula = next(g for g in pieces if g.contains(pt(-15.943, 23.694)))
    mainland = next(g for g in pieces if g is not peninsula)
    s_pen = st(*np.array(peninsula.exterior.coords).T)[0]
    s_min = float(s_pen.min())

    # The lagoon is the water enclosed between the two, from the tip to the head.
    water = band(GAP_M, length - GAP_M).difference(land)
    lagoon = next(g for g in parts(water) if g.contains(pt(-15.85, 23.75)))
    shore = mainland.intersection(lagoon.buffer(SHORE_STRIP_M)).intersection(band(GAP_M, length - GAP_M))
    shore = max(parts(shore), key=lambda g: g.area)

    def slices(geom, n, lo, hi, kind, prefix):
        out = []
        edges = np.linspace(lo, hi, n + 1)
        for i in range(n):
            g = geom.intersection(band(edges[i], edges[i + 1]))
            g = shapely.union_all([p for p in parts(g) if p.geom_type == "Polygon" and p.area > 2e4])
            out.append({"id": f"{prefix}{i + 1}", "kind": kind, "geom": g,
                        "km_from": round((edges[i] - s_min) / 1000, 1),
                        "km_to": round((edges[i + 1] - s_min) / 1000, 1)})
        return out

    units = (slices(peninsula, PENINSULA_BANDS, s_min, length - GAP_M, "peninsula", "P")
             + slices(lagoon, LAGOON_BANDS, GAP_M, length - GAP_M, "lagoon", "L")
             + slices(shore, SHORE_BANDS, GAP_M, length - GAP_M, "shore", "E"))

    # --- elevation --------------------------------------------------------
    dem_path = fetch_dem()
    with rasterio.open(dem_path) as src:
        win = rasterio.windows.from_bounds(*WINDOW, transform=src.transform).round_offsets().round_lengths()
        win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        dem = src.read(1, window=win).astype("float32")
        aff = src.window_transform(win)
    rows, cols = np.indices(dem.shape)
    lon = aff.c + (cols + 0.5) * aff.a
    lat = aff.f + (rows + 0.5) * aff.e
    cell_km2 = (abs(aff.a) * 111.32 * np.cos(np.radians(lat))) * (abs(aff.e) * 110.57)
    back = lambda g: gpd.GeoSeries([g], crs=UTM).to_crs(4326).iloc[0]

    def mask_of(geom_utm):
        return rasterio.features.geometry_mask([mapping(back(geom_utm))], dem.shape, aff, invert=True)

    for u in units:
        g = u["geom"]
        u["area_km2"] = round(g.area / 1e6, 1)
        rp = back(g.representative_point())
        u["pt_lon"], u["pt_lat"] = round(rp.x, 4), round(rp.y, 4)
        if u["kind"] == "lagoon":
            u.update(elev_min=0, elev_mean=0, elev_max=0)
        else:
            z = dem[mask_of(g)]
            u.update(elev_min=int(round(float(z.min()))), elev_mean=int(round(float(z.mean()))),
                     elev_max=int(round(float(z.max()))))
        # A sector faces the open Atlantic if the peninsula's outer coast runs through it.
        u["atlantic"] = u["kind"] == "peninsula"

    pm = mask_of(peninsula)
    z = dem[pm]
    top = int(np.ceil(z.max() / HYPS_BAND_M) * HYPS_BAND_M)
    lows = list(range(0, top, HYPS_BAND_M))
    hyps = [round(float(cell_km2[pm][(z >= lo) & (z < lo + HYPS_BAND_M)].sum()), 2) for lo in lows]
    hyps[0] = round(hyps[0] + float(cell_km2[pm][z < 0].sum()), 2)

    # Spine profile: mean and highest ground across the peninsula, every PROFILE_STEP_M.
    tr = gpd.GeoSeries(gpd.points_from_xy(lon[pm], lat[pm]), crs=4326).to_crs(UTM)
    s_cells = st(tr.x.values, tr.y.values)[0]
    profile, widths = [], []
    for s0 in np.arange(s_min, length - GAP_M, PROFILE_STEP_M):
        m = (s_cells >= s0) & (s_cells < s0 + PROFILE_STEP_M)
        if m.sum() < 3:
            continue
        profile.append([round((s0 - s_min) / 1000, 2), round(float(z[m].mean()), 1), round(float(z[m].max()), 1)])
        widths.append(peninsula.intersection(band(s0, s0 + PROFILE_STEP_M)).area / PROFILE_STEP_M / 1000)
    iy, ix = np.unravel_index(np.argmax(np.where(pm, dem, -1e9)), dem.shape)

    # --- shoreline --------------------------------------------------------
    cuts = LineString([tip + ax * (length - GAP_M) + nx * t for t in (-60000, 60000)]).buffer(40)
    edge = shapely.box(*gpd.GeoSeries([shapely.box(*WINDOW)], crs=4326).to_crs(UTM).total_bounds).boundary.buffer(200)
    near_lagoon = lagoon.buffer(25)
    lines = []
    for name, poly in (("peninsula", peninsula), ("mainland", shore)):
        ring = poly.boundary.difference(cuts).difference(edge)
        inner = ring.intersection(near_lagoon)
        lines.append(("lagoon", name, inner))
        if name == "peninsula":
            lines.append(("atlantic", name, ring.difference(near_lagoon)))
    if lagoon.interiors:
        lines.append(("lagoon", "islets", shapely.MultiLineString([LineString(r.coords) for r in lagoon.interiors])))
    feats = []
    for side, of, g in lines:
        g = shapely.line_merge(g) if g.geom_type == "MultiLineString" and of != "islets" else g
        segs = [p for p in parts(g) if p.geom_type == "LineString" and p.length > 150]
        if not segs:
            continue
        feats.append({"side": side, "of": of, "length_km": round(sum(p.length for p in segs) / 1000, 1),
                      "geometry": shapely.MultiLineString(segs).simplify(8)})
    shoreline = gpd.GeoDataFrame(feats, crs=UTM).to_crs(4326)

    # --- export ------------------------------------------------------------
    area = shapely.union_all([u["geom"].buffer(1) for u in units]).buffer(-1)
    sectors = gpd.GeoDataFrame(
        [{k: v for k, v in u.items() if k != "geom"} for u in units],
        geometry=[u["geom"].simplify(8) for u in units], crs=UTM).to_crs(4326)
    sectors.to_file(os.path.join(OUT, "sectors.geojson"), driver="GeoJSON", COORDINATE_PRECISION=5)
    shoreline.to_file(os.path.join(OUT, "shoreline.geojson"), driver="GeoJSON", COORDINATE_PRECISION=5)
    outline = gpd.GeoDataFrame([{"name": "Dakhla watch area"}], geometry=[area.simplify(8)], crs=UTM).to_crs(4326)
    outline.to_file(os.path.join(OUT, "area.geojson"), driver="GeoJSON", COORDINATE_PRECISION=5)

    b = outline.total_bounds
    tip_ll, neck_ll = back(Point(tip + ax * s_min)), back(Point(tip + ax * (length - GAP_M)))
    atl = float(shoreline[shoreline.side == "atlantic"].length_km.sum())
    lag = float(shoreline[shoreline.side == "lagoon"].length_km.sum())
    stats = {
        "name": "Dakhla peninsula and lagoon",
        "bbox": [round(float(v), 4) for v in b],
        "peninsula_km2": round(peninsula.area / 1e6, 1),
        "lagoon_km2": round(lagoon.area / 1e6, 1),
        "shore_km2": round(shore.area / 1e6, 1),
        "length_km": round((length - GAP_M - s_min) / 1000, 1),
        "width_mean_km": round(float(np.mean(widths)), 1),
        "width_max_km": round(float(np.max(widths)), 1),
        "width_min_km": round(float(np.min(widths[4:-4])), 1),
        "elev_mean": round(float(z.mean()), 1),
        "elev_max": int(round(float(z.max()))),
        "summit": {"lon": round(float(lon[iy, ix]), 5), "lat": round(float(lat[iy, ix]), 5)},
        "tip": {"lon": round(tip_ll.x, 5), "lat": round(tip_ll.y, 5)},
        "neck": {"lon": round(neck_ll.x, 5), "lat": round(neck_ll.y, 5)},
        "marine": {"lon": MARINE_POINT[0], "lat": MARINE_POINT[1]},
        "shoreline_atlantic_km": round(atl, 1),
        "shoreline_lagoon_km": round(lag, 1),
        "hypsometry": {"band_m": HYPS_BAND_M, "from_m": lows, "area_km2": hyps},
        "profile": profile,
        "dem": "Copernicus GLO-30 (ESA / DLR / Airbus), 1 arc-second",
        "coastline": f"Overture Maps base/land {OVERTURE_RELEASE}",
    }
    json.dump(stats, open(os.path.join(OUT, "area.json"), "w"), separators=(",", ":"))
    print(json.dumps({k: v for k, v in stats.items() if k not in ("profile", "hypsometry")}, indent=1))
    print(sectors.drop(columns="geometry").to_string())
    print(shoreline.drop(columns="geometry").to_string())


if __name__ == "__main__":
    main()
