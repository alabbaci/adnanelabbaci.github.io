"""Geometry helpers: reprojection, analysis grid, spatial blocks, ranking."""

from __future__ import annotations

import math
from collections.abc import Iterable

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Polygon, box
from shapely.ops import transform

from .config import CRS_EQUAL_AREA, CRS_GEOGRAPHIC, CRS_METRIC


def to_metric(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if gdf.crs is None:
        raise ValueError("GeoDataFrame has no CRS; refusing to guess")
    if gdf.crs.to_string() == CRS_METRIC:
        return gdf
    return gdf.to_crs(CRS_METRIC)


def to_geographic(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if gdf.crs is None:
        raise ValueError("GeoDataFrame has no CRS; refusing to guess")
    if gdf.crs.to_string() == CRS_GEOGRAPHIC:
        return gdf
    return gdf.to_crs(CRS_GEOGRAPHIC)


def bbox_polygon(bbox: Iterable[float]) -> Polygon:
    x0, y0, x1, y1 = bbox
    return box(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def clip(gdf: gpd.GeoDataFrame, bbox: tuple[float, float, float, float]) -> gpd.GeoDataFrame:
    """Clip features to a bbox given in the frame's own CRS (non-destructive)."""
    return gdf.clip(bbox_polygon(bbox))


def make_grid(
    bbox_metric: tuple[float, float, float, float],
    cell_size: float,
    cell_id_prefix: str = "cell",
) -> gpd.GeoDataFrame:
    """Create an aligned square analysis grid covering ``bbox_metric``.

    Cells are aligned to the metric CRS origin, so the grid is stable
    across runs and can be joined to external statistics without drifting.
    """
    x0, y0, x1, y1 = bbox_metric
    i0, j0 = math.floor(x0 / cell_size), math.floor(y0 / cell_size)
    i1, j1 = math.ceil(x1 / cell_size), math.ceil(y1 / cell_size)
    records: list[dict[str, object]] = []
    for i in range(i0, i1):
        for j in range(j0, j1):
            gx0, gy0 = i * cell_size, j * cell_size
            records.append(
                {
                    "cell_id": f"{cell_id_prefix}-{i:05d}-{j:05d}",
                    "geometry": box(gx0, gy0, gx0 + cell_size, gy0 + cell_size),
                }
            )
    grid = gpd.GeoDataFrame(records, crs=CRS_METRIC)
    return grid


def block_ids(geometries: gpd.GeoDataFrame, block_size: float, prefix: str = "blk") -> pd.Series:
    """Assign coarse spatial blocks (used for blocked cross-validation)."""
    geoms = geometries.geometry
    if not geoms.geom_type.isin(["Point"]).all():
        geoms = geoms.centroid
    xs = geoms.x.to_numpy()
    ys = geoms.y.to_numpy()
    i = np.floor(xs / block_size).astype(int)
    j = np.floor(ys / block_size).astype(int)
    return pd.Series(
        [f"{prefix}-{a}-{b}" for a, b in zip(i, j, strict=True)], index=geometries.index
    )


def percentile_rank(values: pd.Series | np.ndarray) -> pd.Series:
    """Percentile rank in [0, 1]; ties receive the average rank."""
    series = pd.Series(values, dtype="float64")
    if series.notna().sum() == 0:
        return pd.Series(np.full(len(series), np.nan), index=series.index)
    return series.rank(pct=True, method="average")


def normalise(
    values: pd.Series | np.ndarray, vmin: float | None = None, vmax: float | None = None
) -> pd.Series:
    series = pd.Series(values, dtype="float64")
    lo = series.min() if vmin is None else vmin
    hi = series.max() if vmax is None else vmax
    if hi == lo:
        return pd.Series(np.zeros(len(series)), index=series.index)
    return ((series - lo) / (hi - lo)).clip(0, 1)


def convex_hull_ratio(geometry) -> float:
    """Polsby-Popper-like compactness in [0, 1]: 4*pi*A / P^2."""
    area = geometry.area
    perimeter = geometry.length
    if perimeter <= 0:
        return 0.0
    return float(min(1.0, 4 * math.pi * area / (perimeter**2)))


def geodetic_area_km2(geometry) -> float:
    """Area of a WGS84 geometry in km², via an equal-area projection on the fly."""
    from pyproj import Transformer

    transformer = Transformer.from_crs(CRS_GEOGRAPHIC, CRS_EQUAL_AREA, always_xy=True)
    projected = transform(transformer.transform, geometry)
    return float(projected.area / 1_000_000)
