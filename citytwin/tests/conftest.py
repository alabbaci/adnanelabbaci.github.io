"""Shared fixtures: a tiny, fully synthetic twin that needs no network or Overture data."""

from __future__ import annotations

import geopandas as gpd
import pytest
from shapely.geometry import LineString, Polygon, box

from citytwin.config import CRS_METRIC


@pytest.fixture
def simple_buildings() -> gpd.GeoDataFrame:
    """Four footprints on a 600 m square, two of them labelled."""
    polygons = [
        Polygon([(0, 0), (40, 0), (40, 20), (0, 20)]),
        Polygon([(60, 0), (100, 0), (100, 20), (60, 20)]),
        Polygon([(0, 60), (30, 60), (30, 90), (0, 90)]),
        Polygon([(70, 70), (110, 70), (110, 100), (70, 100)]),
    ]
    frame = gpd.GeoDataFrame(
        {
            "gers_id": ["1", "2", "3", "4"],
            "building_class": ["house", "house", "apartments", "house"],
            "area_m2": [800.0, 800.0, 900.0, 1200.0],
            "height_observed_m": [6.0, None, 12.0, None],
            "height_m": [6.0, None, 12.0, None],
            "has_height_label": [True, False, True, False],
            "height_source": ["height_tag", "", "levels", ""],
            "height_final_m": [6.0, 6.0, 12.0, 6.0],
            "height_provenance": [
                "height_tag",
                "rule:class-median-0.5",
                "levels",
                "rule:class-median-0.5",
            ],
            "height_uncertainty_m": [0.0, 3.0, 0.0, 3.0],
            "compactness": [0.8, 0.8, 0.6, 0.4],
            "aspect_ratio": [2.0, 2.0, 3.0, 1.4],
        },
        geometry=polygons,
        crs=CRS_METRIC,
    )
    return frame


@pytest.fixture
def simple_cells() -> gpd.GeoDataFrame:
    cells = gpd.GeoDataFrame(
        {
            "cell_id": ["C1", "C2"],
            "hei": [30.0, 80.0],
            "hei_percentile": [20.0, 95.0],
            "mean_height_m": [6.0, 9.0],
            "green_share": [0.4, 0.05],
            "dist_green_m": [80.0, 260.0],
            "tree_count": [10, 1],
            "built_up_share": [0.3, 0.8],
            "hotspot_probability": [0.1, 0.9],
            "hei_p05": [20.0, 70.0],
            "hei_p95": [40.0, 90.0],
        },
        geometry=[box(0, 0, 300, 300), box(300, 0, 600, 300)],
        crs=CRS_METRIC,
    )
    return cells


@pytest.fixture
def simple_green() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"gers_id": ["g1"], "green_type": ["park"], "name": ["Test park"]},
        geometry=[Polygon([(10, 10), (60, 10), (60, 50), (10, 50)])],
        crs=CRS_METRIC,
    )


@pytest.fixture
def simple_streets() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"gers_id": ["s1"], "name": ["Test street"]},
        geometry=[LineString([(0, 30), (600, 30)])],
        crs=CRS_METRIC,
    )
