"""
02_vegetation_sentinel2.py

Measures vegetation cover in every zone, every year, from Sentinel-2 L2A
imagery (Cloud-Optimised GeoTIFFs in the public `sentinel-cogs` bucket on
AWS, anonymous access). It adds to observatory/data/:

    zones.geojson      + veg_<year> (share of the zone that is vegetated, %)
                       + veg_m2_<year> (vegetated area, m2)
    green.geojson      vegetated patches per year, for the map
    city.json          + years, city-wide vegetation per year, scenes used

Method: for each year, every scene of tile 28QDM acquired in SEASON is read
over the city window (red, near-infrared and the scene classification
layer). Cloud, shadow and no-data pixels are dropped, NDVI is computed per
scene, and the per-pixel median over the season is the yearly composite.
A 10 m pixel counts as vegetated when its median NDVI reaches NDVI_MIN.

Run 01_build_zones.py first.

Requirements: rasterio, numpy, geopandas, shapely
"""

import json
import os
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import geopandas as gpd
import numpy as np
import rasterio
import rasterio.features
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from shapely.geometry import shape

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
BUCKET = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
PREFIX = "sentinel-s2-l2a-cogs/28/Q/DM"
YEARS = [int(y) for y in os.environ.get("YEARS", "2021,2022,2023,2024,2025,2026").split(",")]
SEASON = (3, 4, 5)            # March to May: after the winter rains, before the summer haze
NDVI_MIN = 0.20
MIN_CLEAR = 4                 # a pixel needs this many clear looks in the season
SCL_BAD = (0, 1, 3, 8, 9, 10, 11)   # no data, saturated, shadow, clouds, cirrus, snow
UTM = "EPSG:32628"

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
if os.path.exists("/root/.ccr/ca-bundle.crt"):
    os.environ.setdefault("CURL_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")


def list_scenes(year, month):
    url = f"{BUCKET}/?list-type=2&prefix={PREFIX}/{year}/{month}/&delimiter=/"
    xml = urllib.request.urlopen(url, timeout=60).read().decode()
    return sorted(set(re.findall(rf"{PREFIX}/{year}/{month}/(S2[ABC]_28QDM_\d{{8}}_\d_L2A)/", xml)))


def read_scene(year, month, scene, bounds, shape_):
    base = f"/vsicurl/{BUCKET}/{PREFIX}/{year}/{month}/{scene}"
    try:
        bands = {}
        for b in ("B04", "B08", "SCL"):
            with rasterio.open(f"{base}/{b}.tif") as src:
                win = from_bounds(*bounds, transform=src.transform)
                bands[b] = src.read(1, window=win, out_shape=shape_, resampling=Resampling.nearest).astype("float32")
        red, nir, scl = bands["B04"], bands["B08"], bands["SCL"]
        ok = (red > 0) & (nir > 0) & ~np.isin(scl, SCL_BAD)
        if ok.mean() < 0.2:
            return scene, None
        # Scenes processed with baseline 04.00+ carry a +1000 offset unless it was removed
        # on ingest. Dark water tells the two apart.
        if np.percentile(red[ok], 1) >= 900:
            red, nir = red - 1000, nir - 1000
        ndvi = np.where(ok & (red + nir > 0), (nir - red) / np.maximum(red + nir, 1), np.nan)
        return scene, ndvi.astype("float32")
    except Exception as e:                                  # one unreadable scene must not stop a year
        print("   skip", scene, str(e)[:80])
        return scene, None


def main():
    zones = gpd.read_file(os.path.join(OUT, "zones.geojson"))
    zu = zones.to_crs(UTM)
    b = zu.total_bounds
    bounds = (np.floor(b[0] / 10) * 10 - 100, np.floor(b[1] / 10) * 10 - 100,
              np.ceil(b[2] / 10) * 10 + 100, np.ceil(b[3] / 10) * 10 + 100)
    w, h = int((bounds[2] - bounds[0]) / 10), int((bounds[3] - bounds[1]) / 10)
    transform = rasterio.transform.from_origin(bounds[0], bounds[3], 10, 10)
    zone_id = rasterio.features.rasterize(((g, i + 1) for i, g in enumerate(zu.geometry)),
                                          out_shape=(h, w), transform=transform, fill=0, dtype="int16")
    city = json.load(open(os.path.join(OUT, "city.json")))
    used, city_veg, patches = {}, {}, []

    for year in YEARS:
        scenes = [(year, m, s) for m in SEASON for s in list_scenes(year, m)]
        with ThreadPoolExecutor(8) as pool:
            res = list(pool.map(lambda a: read_scene(*a, bounds, (h, w)), scenes))
        stack = np.stack([n for _, n in res if n is not None])
        looks = np.isfinite(stack).sum(0)
        med = np.nanmedian(stack, axis=0)
        veg = (med >= NDVI_MIN) & (looks >= MIN_CLEAR)
        used[year] = int(len(stack))
        print(f"{year}: {len(scenes)} scenes listed, {len(stack)} usable, vegetated px in zones: {int((veg & (zone_id > 0)).sum())}")
        for i in range(len(zones)):
            m = zone_id == i + 1
            zones.loc[zones.index[i], f"veg_{year}"] = round(100 * float(veg[m].mean()), 2)
            zones.loc[zones.index[i], f"veg_m2_{year}"] = int(veg[m].sum() * 100)
        inside = zone_id > 0
        city_veg[year] = {"share": round(100 * float(veg[inside].mean()), 2), "m2": int(veg[inside].sum() * 100)}
        for geom, v in rasterio.features.shapes(veg.astype("uint8"), mask=veg & inside, transform=transform):
            if v == 1:
                patches.append({"year": year, "geometry": shape(geom)})

    zones.to_file(os.path.join(OUT, "zones.geojson"), driver="GeoJSON", COORDINATE_PRECISION=5)
    gpd.GeoDataFrame(patches, crs=UTM).to_crs(4326).to_file(os.path.join(OUT, "green.geojson"),
                                                           driver="GeoJSON", COORDINATE_PRECISION=5)
    city.update({"years": YEARS, "vegetation": {str(y): v for y, v in city_veg.items()},
                 "sentinel": {"tile": "28QDM", "season": "March to May", "ndvi_min": NDVI_MIN,
                              "scenes_used": {str(y): n for y, n in used.items()}}})
    pop = city["population"]
    city["city_values"]["green_per_capita"] = round(city_veg[city["population_year"]]["m2"] / pop, 2)
    json.dump(city, open(os.path.join(OUT, "city.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(city["vegetation"]), city["sentinel"])


if __name__ == "__main__":
    main()
