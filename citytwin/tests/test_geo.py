"""Geometry helpers: grid construction, block ids and ranking."""

from __future__ import annotations

import numpy as np

from citytwin.config import GRID_SIZE_M
from citytwin.geo import block_ids, make_grid, normalise, percentile_rank


def test_grid_tiles_the_extent(simple_buildings):
    buildings = simple_buildings.to_crs(32628)
    bbox = tuple(buildings.total_bounds)
    grid = make_grid(bbox, cell_size=GRID_SIZE_M)
    assert grid.crs.to_epsg() == 32628
    assert grid["cell_id"].is_unique
    assert len(grid) >= 1
    # the grid covers the union of the footprints
    union = buildings.union_all()
    assert grid.union_all().area >= union.area


def test_block_ids_are_stable_and_coarse():
    import geopandas as gpd
    from shapely.geometry import Point

    points = gpd.GeoDataFrame(geometry=[Point(10, 10), Point(310, 10), Point(10, 310)], crs=32628)
    ids = block_ids(points, block_size=300)
    assert ids.iloc[0] != ids.iloc[1]
    assert len(set(ids)) == 3
    # idempotent for the same input
    assert list(ids) == list(block_ids(points, block_size=300))


def test_percentile_rank_and_normalise():
    values = np.array([1.0, 2.0, 3.0, 4.0])
    ranks = percentile_rank(values)
    assert ranks.min() == 0.25 and ranks.max() == 1.0
    scaled = normalise(values)
    assert scaled.min() == 0 and scaled.max() == 1
    assert normalise(np.array([5.0, 5.0])).tolist() == [0.0, 0.0]
