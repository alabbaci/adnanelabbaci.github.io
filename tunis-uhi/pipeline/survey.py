"""Survey Landsat 8 overpasses of Tunis in the public Google Cloud archive:
how much of the study area each one covers, and how much of it is cloud-free."""
import json, re, sys, urllib.request
import numpy as np, rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

GCS = "https://storage.googleapis.com/gcp-public-data-landsat"
AOI = (10.00, 36.65, 10.35, 36.95)  # west, south, east, north (same as the notebook)

def scenes(path_row, year=2021):
    p, r = path_row
    url = (f"https://storage.googleapis.com/storage/v1/b/gcp-public-data-landsat/o"
           f"?prefix=LC08/01/{p}/{r}/LC08_L1TP_{p}{r}_{year}&delimiter=/&maxResults=1000")
    ids = sorted(set(re.findall(r"LC08_L1TP_\d+_\d+_\d+_01_T1", urllib.request.urlopen(url).read().decode())))
    latest = {}
    for i in ids:                      # keep the latest processing of each acquisition
        latest[i.split("_")[3]] = i
    return [(d, f"{GCS}/LC08/01/{p}/{r}/{i}/{i}") for d, i in sorted(latest.items())]

def clear_share(base):
    """(covered share, clear share) of the AOI from the Collection 1 quality band."""
    with rasterio.open(f"/vsicurl/{base}_BQA.TIF") as src:
        b = transform_bounds("EPSG:4326", src.crs, *AOI)
        qa = src.read(1, window=from_bounds(*b, src.transform), boundless=True, fill_value=1)
    covered = qa > 1                                  # 1 = fill
    cloud = ((qa >> 4) & 1) | (((qa >> 7) & 3) == 3) | (((qa >> 11) & 3) == 3)
    return covered.mean(), (covered & (cloud == 0)).mean()

if __name__ == "__main__":
    for pr in [("191", "034"), ("191", "035")]:
        for day, base in scenes(pr):
            cov, clr = clear_share(base)
            print(pr, day, f"covered {cov:.2f} clear {clr:.2f}", flush=True)
