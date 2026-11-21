"""Heat-exposure analytics on a 250 m grid, with weight sensitivity analysis.

The index is intentionally simple and decomposable: four components, each
converted to a percentile rank inside the study area, then combined with
configurable weights. That makes every cell's score explainable ("high because
dense tall buildings and no green within 200 m") and lets a planner test whether
a conclusion survives a different weighting -- which is what we report as the
sensitivity envelope instead of a single magic number.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point

from .config import CRS_METRIC, GRID_SIZE_M, ExposureWeights
from .geo import make_grid, percentile_rank


@dataclass
class ExposureResult:
    cells: gpd.GeoDataFrame
    buildings: gpd.GeoDataFrame
    weights: ExposureWeights
    summary: dict[str, Any]
    sensitivity: dict[str, Any]
    uncertainty: dict[str, Any]


def build_cells(
    buildings: gpd.GeoDataFrame,
    green: gpd.GeoDataFrame | None = None,
    trees: gpd.GeoDataFrame | None = None,
    *,
    cell_size: float = GRID_SIZE_M,
    height_column: str = "height_final_m",
) -> gpd.GeoDataFrame:
    """Aggregate buildings, green areas and trees to an aligned 250 m grid."""
    bounds = tuple(buildings.total_bounds)
    if green is not None and len(green):
        gb = tuple(green.total_bounds)
        bounds = (
            min(bounds[0], gb[0]),
            min(bounds[1], gb[1]),
            max(bounds[2], gb[2]),
            max(bounds[3], gb[3]),
        )
    grid = make_grid(bounds, cell_size)
    grid["cell_area_m2"] = cell_size**2
    grid = grid.to_crs(CRS_METRIC)

    green_union = green.geometry.union_all() if green is not None and len(green) else None

    rows: list[dict[str, Any]] = []
    for cell in grid.itertuples():
        geometry = cell.geometry
        clipped = gpd.clip(buildings, geometry)
        built_area = float(clipped.geometry.area.sum()) if len(clipped) else 0.0
        if len(clipped):
            weights = clipped.geometry.area.to_numpy()
            heights = clipped[height_column].to_numpy()
            valid = ~np.isnan(heights)
            mean_height = (
                float(np.average(heights[valid], weights=weights[valid])) if valid.any() else 0.0
            )
            max_height = float(np.nanmax(heights)) if valid.any() else 0.0
        else:
            mean_height = max_height = 0.0

        green_area = 0.0
        if green is not None and len(green):
            green_area = float(gpd.clip(green, geometry).geometry.area.sum())

        tree_count = 0
        if trees is not None and len(trees):
            tree_count = int(trees.within(geometry).sum())

        centroid: Point = geometry.centroid
        dist_green = float(centroid.distance(green_union)) if green_union is not None else 800.0

        rows.append(
            {
                "cell_id": cell.cell_id,
                "geometry": geometry,
                "building_count": len(clipped),
                "built_up_share": built_area / (cell_size**2),
                "green_share": green_area / (cell_size**2),
                "tree_count": tree_count,
                "trees_per_ha": tree_count / ((cell_size / 100) ** 2),
                "mean_height_m": round(mean_height, 2),
                "max_height_m": round(max_height, 2),
                "dist_green_m": round(dist_green, 1),
            }
        )
    cells = gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_METRIC)
    # Cells entirely outside the built-up area carry no information for exposure.
    cells = cells[(cells["building_count"] > 0) | (cells["green_share"] > 0.2)].reset_index(
        drop=True
    )
    return cells


def compute_hei(cells: gpd.GeoDataFrame, weights: ExposureWeights) -> gpd.GeoDataFrame:
    """Add the Heat Exposure Index and its four components."""
    frame = cells.copy()
    frame["c_height"] = percentile_rank(frame["mean_height_m"]).fillna(0.0)
    frame["c_lack_green"] = 1 - percentile_rank(frame["green_share"]).fillna(0.0)
    frame["c_dist_green"] = percentile_rank(frame["dist_green_m"]).fillna(0.0)
    frame["c_built_up"] = percentile_rank(frame["built_up_share"]).fillna(0.0)

    frame["hei"] = 100 * (
        weights.building_height * frame["c_height"]
        + weights.lack_of_green * frame["c_lack_green"]
        + weights.distance_to_green * frame["c_dist_green"]
        + weights.built_up_share * frame["c_built_up"]
    )
    frame["hei"] = frame["hei"].round(1)
    frame["hei_percentile"] = (percentile_rank(frame["hei"]) * 100).round(0)
    return frame


def assign_buildings(buildings: gpd.GeoDataFrame, cells: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Join cell-level exposure back to buildings (for 3D colouring and queries)."""
    points = buildings.copy()
    points["geometry"] = points.geometry.centroid
    keep = ["cell_id", "hei", "hei_percentile"]
    for optional in ("hotspot_probability", "hei_p05", "hei_p95"):
        if optional in cells.columns:
            keep.append(optional)
    # idempotent: a second pass must not duplicate (or suffix) the columns it adds
    derived = set(keep) | {"cell_hei", "cell_hei_percentile"}
    points = points.drop(columns=[c for c in derived if c in points.columns])
    joined = gpd.sjoin(points, cells[[*keep, "geometry"]], predicate="within")
    joined = joined.rename(columns={"hei": "cell_hei", "hei_percentile": "cell_hei_percentile"})
    joined = joined.drop(columns=["index_right"])
    joined["geometry"] = buildings.geometry.loc[joined.index]

    missing = buildings.loc[~buildings.index.isin(joined.index)]
    if len(missing):
        nearest = gpd.sjoin_nearest(
            missing[["geometry"]], cells[[*keep, "geometry"]], how="left", distance_col="_d"
        )
        nearest = nearest.drop(columns=["index_right", "_d"])
        nearest = nearest.rename(
            columns={"hei": "cell_hei", "hei_percentile": "cell_hei_percentile"}
        )
        nearest["geometry"] = buildings.geometry.loc[nearest.index]
        joined = pd.concat([joined, nearest], ignore_index=False)
    return gpd.GeoDataFrame(joined, geometry="geometry", crs=buildings.crs)


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    ranks_a = pd.Series(a).rank().to_numpy()
    ranks_b = pd.Series(b).rank().to_numpy()
    if ranks_a.std() == 0 or ranks_b.std() == 0:
        return 0.0
    return float(np.corrcoef(ranks_a, ranks_b)[0, 1])


def sensitivity_analysis(
    cells: gpd.GeoDataFrame,
    weights: ExposureWeights,
    *,
    n_samples: int = 500,
    seed: int = 7,
) -> dict[str, Any]:
    """Sample alternative weightings; report how stable the ranking is."""
    rng = np.random.default_rng(seed)
    base_weights = np.array(
        [
            weights.building_height,
            weights.lack_of_green,
            weights.distance_to_green,
            weights.built_up_share,
        ]
    )
    components = cells[["c_height", "c_lack_green", "c_dist_green", "c_built_up"]].to_numpy()
    base = components @ base_weights
    top_n = max(3, round(0.1 * len(cells)))
    base_top = set(cells.index.to_numpy()[np.argsort(base)[-top_n:]])

    alphas = np.clip(base_weights * 12, 1.0, None)
    correlations: list[float] = []
    jaccards: list[float] = []
    for _ in range(n_samples):
        sampled = rng.dirichlet(alphas)
        scores = components @ sampled
        correlations.append(_spearman(base, scores))
        top = set(cells.index.to_numpy()[np.argsort(scores)[-top_n:]])
        jaccards.append(len(top & base_top) / len(top | base_top))

    return {
        "n_samples": n_samples,
        "seed": seed,
        "spearman_median": round(float(np.median(correlations)), 3),
        "spearman_p05": round(float(np.percentile(correlations, 5)), 3),
        "top_decile_jaccard_median": round(float(np.median(jaccards)), 3),
        "top_decile_jaccard_p05": round(float(np.percentile(jaccards, 5)), 3),
        "interpretation": (
            "Spearman rho compares the full cell ranking under resampled weights with the "
            "baseline ranking; the Jaccard score compares the top-decile hotspot sets. Medians "
            "near 1 mean the ranking survives plausible re-weighting; the 5th percentiles show "
            "how far cells near the threshold can still move."
        ),
    }


def summarise(cells: gpd.GeoDataFrame, buildings: gpd.GeoDataFrame) -> dict[str, Any]:
    hotspot_threshold = float(np.percentile(cells["hei"], 90))
    hotspots = cells[cells["hei"] >= hotspot_threshold]
    exposed_hei = (
        buildings["cell_hei"].fillna(-1.0)
        if "cell_hei" in buildings.columns
        else pd.Series(-1.0, index=buildings.index)
    )
    exposed = buildings.loc[exposed_hei.to_numpy() >= hotspot_threshold]
    area_ha = float(cells.geometry.area.sum() / 10_000)
    return {
        "cells": len(cells),
        "area_ha": round(area_ha, 1),
        "mean_hei": round(float(cells["hei"].mean()), 1),
        "median_hei": round(float(cells["hei"].median()), 1),
        "max_hei": round(float(cells["hei"].max()), 1),
        "hotspot_threshold": round(hotspot_threshold, 1),
        "hotspot_cells": len(hotspots),
        "hotspot_area_ha": round(float(hotspots.geometry.area.sum() / 10_000), 1),
        "hotspot_share_pct": round(
            100 * float(hotspots.geometry.area.sum()) / float(cells.geometry.area.sum()), 1
        ),
        "buildings_in_hotspots": len(exposed),
        "mean_height_m": round(float(buildings["height_final_m"].mean()), 2),
        "green_share": round(float(cells["green_share"].mean()), 3),
    }


def propagate_height_uncertainty(
    buildings: gpd.GeoDataFrame,
    cells: gpd.GeoDataFrame,
    weights: ExposureWeights,
    *,
    n_draws: int = 200,
    seed: int = 11,
) -> tuple[gpd.GeoDataFrame, dict[str, Any]]:
    """Resample imputed heights inside their conformal intervals and re-score the grid.

    Only the height component varies between draws; green cover, distance and
    built-up share are observed. The output answers a decision question rather
    than a statistical one: *how often does a cell remain a hotspot when the
    imputed heights are redrawn?*
    """
    import scipy.sparse as sp

    right = gpd.GeoDataFrame(
        {"cell_id": cells["cell_id"].to_numpy(), "cell_geom": cells.geometry.to_numpy()},
        geometry="cell_geom",
        crs=cells.crs,
    )
    pairs = gpd.sjoin(buildings[["geometry"]], right, predicate="intersects")
    cell_geometries = cells.geometry.to_numpy()
    areas = np.asarray(
        [
            g.intersection(cell_geometries[right_index]).area
            for g, right_index in zip(
                buildings.geometry.loc[pairs.index], pairs["index_right"], strict=True
            )
        ]
    )
    cell_codes = pd.Categorical(pairs["cell_id"], categories=cells["cell_id"]).codes
    build_codes = buildings.index.get_indexer(pairs.index)

    n_cells, n_buildings = len(cells), len(buildings)
    W = sp.csr_matrix((areas, (cell_codes, build_codes)), shape=(n_cells, n_buildings))
    denominator = np.asarray(W.sum(axis=1)).ravel()
    denominator[denominator == 0] = np.nan

    base = buildings["height_final_m"].to_numpy(dtype=float)
    lo = buildings["height_lo_final_m"].to_numpy(dtype=float)
    hi = buildings["height_hi_final_m"].to_numpy(dtype=float)
    imputed = ~buildings["has_height_label"].to_numpy()

    rng = np.random.default_rng(seed)
    draws = np.tile(base[:, None], (1, n_draws))
    if imputed.any():
        draws[np.ix_(imputed, np.arange(n_draws))] = rng.uniform(
            lo[imputed, None], hi[imputed, None], size=(int(imputed.sum()), n_draws)
        )

    mean_height = np.asarray(W @ draws) / denominator[:, None]  # (n_cells, n_draws)

    static = (
        weights.lack_of_green * cells["c_lack_green"].to_numpy()
        + weights.distance_to_green * cells["c_dist_green"].to_numpy()
        + weights.built_up_share * cells["c_built_up"].to_numpy()
    )
    hei_draws = np.empty_like(mean_height)
    for draw in range(n_draws):
        rank = percentile_rank(mean_height[:, draw]).fillna(0.0).to_numpy()
        hei_draws[:, draw] = 100 * (static + weights.building_height * rank)

    observed = cells["hei"].to_numpy()
    top_n = max(3, round(0.1 * n_cells))
    baseline_top = set(np.argsort(observed)[-top_n:])
    jaccards = []
    for draw in range(n_draws):
        top = set(np.argsort(hei_draws[:, draw])[-top_n:])
        jaccards.append(len(top & baseline_top) / len(top | baseline_top))

    enriched = cells.copy()
    enriched["hei_p05"] = np.round(np.percentile(hei_draws, 5, axis=1), 1)
    enriched["hei_p95"] = np.round(np.percentile(hei_draws, 95, axis=1), 1)
    enriched["hei_std"] = np.round(hei_draws.std(axis=1), 1)
    enriched["hotspot_probability"] = np.round(
        (hei_draws >= np.percentile(hei_draws, 90, axis=0)).mean(axis=1), 2
    )
    summary = {
        "n_draws": n_draws,
        "seed": seed,
        "intervals": "80% (percentile 5-95 of the redrawn height distribution)",
        "hotspot_jaccard_mean": round(float(np.mean(jaccards)), 3),
        "hotspot_jaccard_p05": round(float(np.percentile(jaccards, 5)), 3),
        "cells_hotspot_prob_ge_0_8": int((enriched["hotspot_probability"] >= 0.8).sum()),
        "hei_interval_width_median": round(
            float((enriched["hei_p95"] - enriched["hei_p05"]).median()), 1
        ),
        "interpretation": (
            "The Jaccard score compares the 90th-percentile hotspot set of each draw with "
            "the observed-height hotspot set. Low values mean the decision layer is not "
            "identified by the current height data alone."
        ),
    }
    return enriched, summary


def build_exposure(
    buildings: gpd.GeoDataFrame,
    green: gpd.GeoDataFrame | None,
    trees: gpd.GeoDataFrame | None,
    weights: ExposureWeights,
    *,
    cell_size: float = GRID_SIZE_M,
    n_samples: int = 500,
    n_draws: int = 200,
) -> ExposureResult:
    cells = build_cells(buildings, green, trees, cell_size=cell_size)
    cells = compute_hei(cells, weights)
    buildings = assign_buildings(buildings, cells)
    cells, uncertainty = propagate_height_uncertainty(buildings, cells, weights, n_draws=n_draws)
    buildings = assign_buildings(buildings, cells)
    return ExposureResult(
        cells=cells,
        buildings=buildings,
        weights=weights,
        summary=summarise(cells, buildings),
        sensitivity=sensitivity_analysis(cells, weights, n_samples=n_samples),
        uncertainty=uncertainty,
    )
