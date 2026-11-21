"""Feature engineering for the building-height model and exposure analytics.

All features are computed in the metric CRS (EPSG:32628, UTM zone 28N), so lengths and areas
are meaningful metres. Each feature is documented in ``docs/model_card.md`` with
the leak-age check that justifies its inclusion.
"""

from __future__ import annotations

from dataclasses import dataclass

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point

from .config import CRS_METRIC
from .geo import block_ids, convex_hull_ratio, to_metric
from .ingest.overture import Layers

#: Building types kept as individual one-hot columns; the rest become ``other``.
KEPT_TYPES = (
    "house",
    "apartments",
    "residential",
    "bungalow",
    "retail",
    "commercial",
    "industrial",
    "school",
    "mosque",
    "hotel",
    "public",
    "hospital",
)


@dataclass
class FeatureSet:
    buildings: gpd.GeoDataFrame
    centre: Point
    green_union: object


def _aspect_ratio(geometry) -> float:
    """Short/long side ratio of the minimum rotated rectangle."""
    if geometry.is_empty:
        return 1.0
    rect = geometry.minimum_rotated_rectangle
    if rect.geom_type != "Polygon":
        return 1.0
    coords = list(rect.exterior.coords)
    sides = [
        Point(coords[i]).distance(Point(coords[i + 1])) for i in range(min(3, len(coords) - 1))
    ]
    if not sides:
        return 1.0
    longest, shortest = max(sides), min(sides)
    return float(shortest / longest) if longest > 0 else 1.0


def build_features(layers: Layers) -> FeatureSet:
    """Compute per-building morphology and context features."""
    buildings = to_metric(layers.buildings.copy())
    green = to_metric(layers.green.copy()) if len(layers.green) else None
    trees = to_metric(layers.trees.copy()) if len(layers.trees) else None
    streets = to_metric(layers.streets.copy()) if len(layers.streets) else None

    buildings = buildings[buildings.geometry.area > 10].reset_index(drop=True)
    buildings["height_m"] = pd.to_numeric(buildings["height_m"], errors="coerce").astype(float)
    buildings["has_height_label"] = buildings["height_m"].notna()
    buildings["height_observed_m"] = buildings["height_m"]
    buildings["height_source"] = buildings["height_source"].fillna("missing")

    buildings["area_m2"] = buildings.geometry.area.round(2)
    buildings["perimeter_m"] = buildings.geometry.length.round(2)
    buildings["compactness"] = buildings.geometry.apply(convex_hull_ratio).round(4)
    buildings["aspect_ratio"] = buildings.geometry.apply(_aspect_ratio).round(4)
    buildings["n_vertices"] = buildings.geometry.apply(lambda g: max(0, len(g.exterior.coords) - 1))
    buildings["cx"] = buildings.geometry.centroid.x
    buildings["cy"] = buildings.geometry.centroid.y

    centre = Point(
        np.mean([buildings.geometry.total_bounds[0], buildings.geometry.total_bounds[2]]),
        np.mean([buildings.geometry.total_bounds[1], buildings.geometry.total_bounds[3]]),
    )
    buildings["dist_centre_m"] = buildings.geometry.distance(centre).round(1)

    # -- green context ----------------------------------------------------
    if green is not None and len(green):
        green_union = green.geometry.union_all()
        nearest = gpd.sjoin_nearest(
            buildings[["geometry"]], green[["geometry"]], how="left", distance_col="d"
        )
        dist_green = nearest.groupby(level=0)["d"].min()
        buildings["dist_green_m"] = buildings.index.map(dist_green).fillna(1e4).round(1)
    else:
        green_union = None
        buildings["dist_green_m"] = 1e4

    if trees is not None and len(trees):
        nearest_tree = gpd.sjoin_nearest(
            buildings[["geometry"]], trees[["geometry"]], how="left", distance_col="d"
        )
        dist_tree = nearest_tree.groupby(level=0)["d"].min()
        buildings["dist_tree_m"] = buildings.index.map(dist_tree).fillna(1e4).round(1)
    else:
        buildings["dist_tree_m"] = 1e4

    # -- neighbourhood context (self excluded) ----------------------------
    buffers = gpd.GeoDataFrame(
        {"idx": buildings.index}, geometry=buildings.geometry.buffer(100), crs=CRS_METRIC
    )
    pairs = gpd.sjoin(
        buffers, buildings[["geometry", "area_m2"]], predicate="intersects", how="inner"
    )
    pairs = pairs[pairs["idx"] != pairs.index_right]
    neighbours = pairs.groupby("idx").agg(
        neighbour_count_100m=("index_right", "count"),
        mean_neighbour_area=("area_m2", "mean"),
    )
    buildings["neighbour_count_100m"] = (
        buildings.index.map(neighbours["neighbour_count_100m"]).fillna(0).astype(int)
    )
    buildings["mean_neighbour_area_m2"] = (
        buildings.index.map(neighbours["mean_neighbour_area"]).astype(float).fillna(0.0).round(1)
    )

    # -- street context ----------------------------------------------------
    if streets is not None and len(streets):
        major = streets[
            streets["highway"].isin(
                ["primary", "secondary", "tertiary", "residential", "unclassified"]
            )
        ]
        if len(major):
            nearest_road = gpd.sjoin_nearest(
                buildings[["geometry"]], major[["geometry"]], how="left", distance_col="d"
            )
            dist_road = nearest_road.groupby(level=0)["d"].min()
            buildings["dist_road_m"] = buildings.index.map(dist_road).fillna(500).round(1)
        else:
            buildings["dist_road_m"] = 500.0
    else:
        buildings["dist_road_m"] = 500.0

    # -- height context from *labelled* neighbours (self excluded) --------
    # Only labels observable at prediction time may enter this feature: an
    # unlabelled building's own height is unknown, so it is never used.
    labelled = buildings[buildings["has_height_label"]]
    if len(labelled) > 1:
        neighbourhood = gpd.GeoDataFrame(
            {"idx": labelled.index}, geometry=labelled.geometry.buffer(150), crs=CRS_METRIC
        )
        pairs_h = gpd.sjoin(
            neighbourhood, labelled[["geometry", "height_m"]], predicate="intersects"
        )
        pairs_h = pairs_h[pairs_h["idx"] != pairs_h.index_right]
        stats = pairs_h.groupby("idx")["height_m"].agg(["mean", "max"])
        buildings["neighbour_height_mean_150m"] = buildings.index.map(stats["mean"])
        buildings["neighbour_height_max_150m"] = buildings.index.map(stats["max"])
    else:
        buildings["neighbour_height_mean_150m"] = np.nan
        buildings["neighbour_height_max_150m"] = np.nan
    buildings["neighbour_height_mean_150m"] = buildings["neighbour_height_mean_150m"].fillna(
        float(buildings["height_m"].median()) if buildings["height_m"].notna().any() else 6.0
    )
    buildings["neighbour_height_max_150m"] = buildings["neighbour_height_max_150m"].fillna(
        buildings["neighbour_height_mean_150m"]
    )

    # -- categorical ------------------------------------------------------
    type_norm = buildings["building_type"].fillna("yes").str.lower().str.strip()
    buildings["building_class"] = np.where(type_norm.isin(KEPT_TYPES), type_norm, "other")
    for kept in KEPT_TYPES:
        buildings[f"is_{kept}"] = (buildings["building_class"] == kept).astype(int)

    buildings["cv_block"] = block_ids(buildings, block_size=300.0)

    return FeatureSet(buildings=buildings, centre=centre, green_union=green_union)


def feature_matrix(buildings: gpd.GeoDataFrame) -> pd.DataFrame:
    """Return the model matrix (numeric only) for height estimation."""
    columns = [
        "area_m2",
        "perimeter_m",
        "compactness",
        "aspect_ratio",
        "n_vertices",
        "dist_centre_m",
        "dist_green_m",
        "dist_tree_m",
        "neighbour_count_100m",
        "mean_neighbour_area_m2",
        "dist_road_m",
        "neighbour_height_mean_150m",
        "neighbour_height_max_150m",
        *(f"is_{kept}" for kept in KEPT_TYPES),
    ]
    matrix = buildings[columns].astype(float)
    matrix.index = buildings.index
    return matrix
