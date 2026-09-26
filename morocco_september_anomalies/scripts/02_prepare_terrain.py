#!/usr/bin/env python3
"""Build the Morocco terrain surface that forge3d renders.

1. Country outline from Natural Earth 10m admin-0 (Morocco + Western Sahara,
   dissolved), saved as GeoJSON for the overlay mask.
2. Elevation from Terrarium tiles (AWS Open Data), mosaicked, reprojected to
   a Lambert equal-area grid at 1 km and masked to the outline.

Outputs: data/morocco_boundary.geojson, data/morocco_dem_laea_1km.tif
"""

from __future__ import annotations

import io
import math
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import geometry_mask
from rasterio.transform import from_bounds, from_origin
from rasterio.warp import Resampling, reproject

from common import (
    BOUNDARY_ADMINS,
    CACHE_DIR,
    DEM_RESOLUTION_M,
    NATURAL_EARTH_URL,
    TARGET_CRS,
    TERRARIUM_URL,
    TERRARIUM_ZOOM,
    boundary_path,
    dem_path,
)

NODATA = -9999.0
MERCATOR_HALF = 20037508.342789244


def download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def build_boundary() -> gpd.GeoDataFrame:
    zip_path = CACHE_DIR / "ne_10m_admin_0_countries.zip"
    if not zip_path.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        zip_path.write_bytes(download(NATURAL_EARTH_URL))
    world = gpd.read_file(f"zip://{zip_path}")
    sel = world[world["ADMIN"].isin(BOUNDARY_ADMINS)]
    if len(sel) != len(BOUNDARY_ADMINS):
        raise SystemExit(f"Natural Earth lookup failed: found {list(sel['ADMIN'])}")
    outline = gpd.GeoDataFrame({"name": ["Morocco"]}, geometry=[sel.union_all()], crs=sel.crs)
    outline.to_file(boundary_path(), driver="GeoJSON")
    return outline


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def terrarium_mosaic(bounds: tuple[float, float, float, float], z: int):
    west, south, east, north = bounds
    x0, y0 = lonlat_to_tile(west, north, z)
    x1, y1 = lonlat_to_tile(east, south, z)
    tiles = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    print(f"  {len(tiles)} Terrarium tiles at z{z}")

    tile_dir = CACHE_DIR / "terrarium" / str(z)
    tile_dir.mkdir(parents=True, exist_ok=True)

    def get(xy):
        x, y = xy
        path = tile_dir / f"{x}_{y}.png"
        if not path.exists():
            path.write_bytes(download(TERRARIUM_URL.format(z=z, x=x, y=y)))
        rgb = np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert("RGB"), dtype=np.float32)
        return xy, rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0

    mosaic = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), dtype=np.float32)
    with ThreadPoolExecutor(16) as pool:
        for (x, y), elev in pool.map(get, tiles):
            mosaic[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = elev

    size = 2 * MERCATOR_HALF / 2**z
    transform = from_bounds(
        -MERCATOR_HALF + x0 * size,
        MERCATOR_HALF - (y1 + 1) * size,
        -MERCATOR_HALF + (x1 + 1) * size,
        MERCATOR_HALF - y0 * size,
        mosaic.shape[1],
        mosaic.shape[0],
    )
    return mosaic, transform


def build_dem(outline: gpd.GeoDataFrame) -> None:
    lon_lat_bounds = outline.total_bounds
    mosaic, src_transform = terrarium_mosaic(tuple(lon_lat_bounds + np.array([-0.3, -0.3, 0.3, 0.3])), TERRARIUM_ZOOM)

    projected = outline.to_crs(TARGET_CRS)
    minx, miny, maxx, maxy = projected.total_bounds
    pad = 10 * DEM_RESOLUTION_M
    minx, miny = minx - pad, miny - pad
    width = int(math.ceil((maxx + pad - minx) / DEM_RESOLUTION_M))
    height = int(math.ceil((maxy + pad - miny) / DEM_RESOLUTION_M))
    transform = from_origin(minx, miny + height * DEM_RESOLUTION_M, DEM_RESOLUTION_M, DEM_RESOLUTION_M)

    dem = np.full((height, width), NODATA, dtype=np.float32)
    reproject(
        mosaic,
        dem,
        src_transform=src_transform,
        src_crs="EPSG:3857",
        dst_transform=transform,
        dst_crs=TARGET_CRS,
        resampling=Resampling.average,
        dst_nodata=NODATA,
    )
    outside = geometry_mask(projected.geometry, out_shape=dem.shape, transform=transform)
    dem = np.maximum(dem, 0.0)  # sea / depressions: flat land surface
    dem[outside] = NODATA

    profile = dict(
        driver="GTiff", width=width, height=height, count=1, dtype="float32",
        crs=TARGET_CRS, transform=transform, nodata=NODATA, compress="deflate", predictor=3,
    )
    with rasterio.open(dem_path(), "w", **profile) as dst:
        dst.write(dem, 1)
    valid = dem[~outside]
    print(f"Wrote {dem_path()}  {width}x{height}  elevation {valid.min():.0f}..{valid.max():.0f} m")


def main() -> None:
    outline = build_boundary()
    print(f"Wrote {boundary_path()}")
    build_dem(outline)


if __name__ == "__main__":
    main()
