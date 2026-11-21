"""Unsupervised urban typology: what kinds of building fabric make up the AOI?

This is the module where machine learning earns its place: there are no labels to
predict, so clustering explores structure instead of guessing a target. Buildings
are described by standardised morphometric and context features, grouped with
k-means, and the solution is checked for **stability** (adjusted Rand index across
subsamples) and **separation** (silhouette). The resulting typology is then used
as the unit of exposure reporting: "which kind of urban fabric is hottest?"
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import geopandas as gpd
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.metrics import adjusted_rand_score, silhouette_score
from sklearn.preprocessing import StandardScaler


@dataclass
class TypologyResult:
    buildings: gpd.GeoDataFrame
    profiles: pd.DataFrame
    summary: dict[str, Any]


def _matrix(buildings: gpd.GeoDataFrame) -> pd.DataFrame:
    """Cluster features: form and context only.

    Height is deliberately excluded: 90% of heights are imputed from building
    class, so clustering on it would mostly recover the rule that produced it.
    """
    frame = pd.DataFrame(
        {
            "log_area": np.log1p(buildings["area_m2"].to_numpy(dtype=float)),
            "compactness": buildings["compactness"].to_numpy(dtype=float),
            "aspect_ratio": buildings["aspect_ratio"].to_numpy(dtype=float),
            "log_neighbours": np.log1p(buildings["neighbour_count_100m"].to_numpy(dtype=float)),
            "log_neighbour_area": np.log1p(
                buildings["mean_neighbour_area_m2"].to_numpy(dtype=float)
            ),
            "dist_centre_km": buildings["dist_centre_m"].to_numpy(dtype=float) / 1000,
            "dist_green_m": buildings["dist_green_m"].to_numpy(dtype=float),
            "dist_road_m": buildings["dist_road_m"].to_numpy(dtype=float),
        }
    )
    return frame.fillna(frame.median(numeric_only=True))


#: Silhouette tolerance for preferring a smaller number of clusters.
K_TOLERANCE = 0.02


def _choose_k(X: np.ndarray, k_range: range, seed: int) -> tuple[int, dict[int, float]]:
    scores: dict[int, float] = {}
    sample = (
        X if len(X) <= 1500 else X[np.random.default_rng(seed).choice(len(X), 1500, replace=False)]
    )
    for k in k_range:
        if k >= len(X):
            continue
        model = KMeans(n_clusters=k, n_init=10, random_state=seed).fit(sample)
        scores[k] = float(silhouette_score(sample, model.labels_))
    if not scores:
        return 4, {}
    # Parsimony: the smallest k whose silhouette is within the tolerance of the best.
    # On a continuous fabric the curve is flat, and the arg-max alone would pick an
    # arbitrary, hard-to-name partition.
    ceiling = max(scores.values())
    best = min(k for k, value in scores.items() if value >= ceiling - K_TOLERANCE)
    return best, {k: round(v, 3) for k, v in scores.items()}


def _height_band(height: float) -> str:
    if height < 8:
        return "low"
    if height < 12:
        return "mid"
    return "tall"


def _describe_profile(row: pd.Series, neighbour_mean: float) -> str:
    """Human-readable label derived from the cluster profile, not from a guess.

    Density is judged against the study-area mean, so the labels do not depend on
    absolute thresholds tuned for another city.
    """
    if row["median_dist_green_m"] < 80:
        return "green-adjacent"
    if row["median_area_m2"] >= 500:
        return "block-scale footprints"
    if row["mean_neighbour_count"] <= 0.6 * neighbour_mean:
        return "sparse periphery"
    if row["mean_neighbour_count"] >= neighbour_mean:
        return "dense fine-grain fabric"
    return "mixed residential"


def build_typology(
    buildings: gpd.GeoDataFrame,
    *,
    n_clusters: int | None = None,
    seed: int = 3,
    stability_repeats: int = 10,
    sample_fraction: float = 0.8,
) -> TypologyResult:
    """Cluster buildings into urban fabric types and report stability."""
    features = _matrix(buildings)
    scaler = StandardScaler().fit(features)
    X = scaler.transform(features)

    silhouette_by_k: dict[int, float] = {}
    if n_clusters is None:
        n_clusters, silhouette_by_k = _choose_k(X, range(3, 9), seed)

    reference = KMeans(n_clusters=n_clusters, n_init=25, random_state=seed).fit_predict(X)

    rng = np.random.default_rng(seed)
    aris: list[float] = []
    silhouette_values: list[float] = []
    size = int(sample_fraction * len(X))
    for repeat in range(stability_repeats):
        indices = rng.choice(len(X), size=max(size, n_clusters + 1), replace=False)
        model = KMeans(n_clusters=n_clusters, n_init=10, random_state=seed + repeat).fit(X[indices])
        aris.append(adjusted_rand_score(reference[indices], model.labels_))
        subset_silhouette = silhouette_score(X[indices], model.labels_)
        silhouette_values.append(float(subset_silhouette))

    frame = buildings.copy()
    frame["cluster"] = reference
    # Relabel clusters by descending mean height so that T1..Tn are stable in meaning.
    order = (
        frame.groupby("cluster")["height_final_m"]
        .mean()
        .sort_values(ascending=False)
        .index.to_list()
    )
    frame["typology"] = frame["cluster"].map(
        {cluster: f"T{position + 1}" for position, cluster in enumerate(order)}
    )
    frame = frame.drop(columns="cluster")

    profiles = (
        frame.groupby("typology")
        .agg(
            buildings=("gers_id", "count"),
            share_pct=("gers_id", lambda s: round(100 * len(s) / len(frame), 1)),
            median_area_m2=("area_m2", "median"),
            median_height_m=("height_final_m", "median"),
            mean_neighbour_count=("neighbour_count_100m", "mean"),
            median_dist_centre_m=("dist_centre_m", "median"),
            median_dist_green_m=("dist_green_m", "median"),
            dominant_class=(
                "building_class",
                lambda s: s.mode().iat[0] if len(s.mode()) else "other",
            ),
        )
        .reset_index()
    )
    profiles["height_band"] = profiles["median_height_m"].map(_height_band)
    neighbour_mean = float(frame["neighbour_count_100m"].mean())
    profiles["descriptor"] = profiles.apply(
        _describe_profile, axis=1, neighbour_mean=neighbour_mean
    )
    # two clusters can satisfy the same rule; disambiguate by footprint size
    area_median = float(profiles["median_area_m2"].median())
    duplicates = profiles["descriptor"].duplicated(keep=False)
    profiles.loc[duplicates, "descriptor"] = profiles.loc[duplicates].apply(
        lambda row: (
            row["descriptor"]
            + (
                " · large footprint"
                if row["median_area_m2"] >= area_median
                else " · small footprint"
            )
        ),
        axis=1,
    )
    profiles["typology_name"] = (
        profiles["typology"] + " " + profiles["descriptor"] + " · " + profiles["height_band"]
    )
    frame = frame.merge(profiles[["typology", "typology_name"]], on="typology", how="left")

    summary = {
        "n_clusters": int(n_clusters),
        "silhouette": round(float(np.mean(silhouette_values)), 3),
        "silhouette_by_k": silhouette_by_k,
        "stability_ari_mean": round(float(np.mean(aris)), 3),
        "stability_ari_min": round(float(np.min(aris)), 3),
        "stability_repeats": stability_repeats,
        "sample_fraction": sample_fraction,
        "feature_set": list(features.columns),
        "interpretation": (
            "ARI near 1 across subsamples means the typology is reproducible. A low silhouette "
            "is expected for a continuous urban fabric and means the clusters are soft "
            "boundaries rather than natural classes — they summarise morphology, they do not "
            "classify buildings."
        ),
    }
    return TypologyResult(buildings=frame, profiles=profiles, summary=summary)


def exposure_by_typology(buildings: gpd.GeoDataFrame) -> pd.DataFrame:
    """Mean exposure per urban fabric type (requires cell_hei from analytics)."""
    if "cell_hei" not in buildings.columns:
        raise ValueError("run analytics.assign_buildings before aggregating exposure")
    return (
        buildings.groupby(["typology", "typology_name"])
        .agg(
            buildings=("gers_id", "count"),
            mean_hei=("cell_hei", "mean"),
            mean_height_m=("height_final_m", "mean"),
            share_pct=("gers_id", lambda s: round(100 * len(s) / len(buildings), 1)),
        )
        .round(2)
        .reset_index()
        .sort_values("mean_hei", ascending=False)
    )
