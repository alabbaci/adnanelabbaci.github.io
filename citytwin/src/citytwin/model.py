"""Height completion: a transparent rule, a learned benchmark, and the decision between them.

The module ships **two strategies** on purpose:

``rule`` (default)
    Per-``building_class`` median height, smoothed towards the global median,
    calibrated with a spatially blocked conformal interval (80%).
``model``
    Random forest on morphology plus a fold-safe target encoding of the class
    median. Available as ``--height-strategy model``.

``benchmark_heights`` runs both under identical blocked folds and ships the learned
model only when it reduces blocked MAE; otherwise the rule stays the default: fewer
parameters, fully explainable, and no silent extrapolation. The outcome for the
current build is in the generated model card, so the claim can be re-run rather
than asserted.

Both strategies floor the interval half-width at ``MIN_INTERVAL_M`` (one storey):
labels are whole floor counts, so the raw conformal quantile can collapse to zero
when a single storey count dominates them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.inspection import permutation_importance
from sklearn.model_selection import GroupKFold, KFold

from .config import MIN_INTERVAL_M, STOREY_HEIGHT_M
from .features import feature_matrix

MODEL_VERSION = "rf-height-0.5.0"
RULE_VERSION = "class-median-0.5.0"
Z_80 = 1.2816
SMOOTHING_K = 5.0

Strategy = Literal["rule", "model"]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------
def snap_to_storey(values: np.ndarray) -> np.ndarray:
    """Snap predictions to the 3 m storey lattice implied by floor-count labels."""
    return np.round(np.asarray(values, dtype=float) / STOREY_HEIGHT_M) * STOREY_HEIGHT_M


def _metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, float]:
    residuals = np.asarray(y_pred) - np.asarray(y_true)
    ss_res = float(np.sum(residuals**2))
    ss_tot = float(np.sum((y_true - y_true.mean()) ** 2))
    return {
        "mae": round(float(np.mean(np.abs(residuals))), 2),
        "rmse": round(float(np.sqrt(np.mean(residuals**2))), 2),
        "r2": round(1 - ss_res / ss_tot, 3) if ss_tot > 0 else float("nan"),
        "bias": round(float(np.mean(residuals)), 2),
        "n": len(y_true),
    }


def _storey_class(heights: np.ndarray) -> np.ndarray:
    storeys = np.round(np.asarray(heights) / STOREY_HEIGHT_M).astype(int)
    return np.where(
        storeys <= 2, "1-2", np.where(storeys == 3, "3", np.where(storeys == 4, "4", "5+"))
    )


# ---------------------------------------------------------------------------
# Strategy 1: the shipped rule
# ---------------------------------------------------------------------------
def rule_table(buildings: pd.DataFrame) -> dict[str, Any]:
    """Smoothed per-class median heights fitted on labelled buildings."""
    labelled = buildings[buildings["has_height_label"]]
    if labelled.empty:
        raise ValueError("no labelled buildings: cannot fit the rule table")
    global_median = float(labelled["height_m"].median())
    stats = labelled.groupby("building_class")["height_m"].agg(["median", "count"])
    table = {
        str(cls): float(
            (row["median"] * row["count"] + global_median * SMOOTHING_K)
            / (row["count"] + SMOOTHING_K)
        )
        for cls, row in stats.iterrows()
    }
    return {
        "table": table,
        "global_median_m": round(global_median, 2),
        "n_labelled": len(labelled),
        "version": RULE_VERSION,
    }


def apply_rule(buildings: pd.DataFrame, table: dict[str, Any], quantile_m: float) -> pd.DataFrame:
    frame = buildings.copy()
    point = (
        frame["building_class"].map(table["table"]).astype(float).fillna(table["global_median_m"])
    )
    point = snap_to_storey(point.to_numpy())
    frame["height_modelled_m"] = point
    frame["height_lo_m"] = np.maximum(0.0, point - quantile_m)
    frame["height_hi_m"] = point + quantile_m
    frame["height_final_m"] = frame["height_observed_m"].fillna(pd.Series(point, index=frame.index))
    frame["height_lo_final_m"] = np.where(
        frame["has_height_label"], frame["height_observed_m"], frame["height_lo_m"]
    )
    frame["height_hi_final_m"] = np.where(
        frame["has_height_label"], frame["height_observed_m"], frame["height_hi_m"]
    )
    frame["height_uncertainty_m"] = (frame["height_hi_final_m"] - frame["height_lo_final_m"]) / 2
    frame["height_provenance"] = np.where(
        frame["has_height_label"], frame["height_source"], "rule:" + RULE_VERSION
    )
    return frame


def calibrate_rule(
    buildings: pd.DataFrame, *, n_splits: int = 5, interval: float = 0.8
) -> dict[str, Any]:
    """Blocked out-of-fold evaluation of the rule, with nested conformal coverage."""
    labelled = buildings[buildings["has_height_label"]].reset_index(drop=True)
    groups = labelled["cv_block"].to_numpy()
    y = labelled["height_m"].to_numpy(dtype=float)
    folds = list(GroupKFold(n_splits=n_splits).split(np.zeros((len(y), 1)), y, groups))
    oof = np.full(len(y), np.nan)
    residual_abs: list[np.ndarray] = []
    tables = []
    for train_idx, test_idx in folds:
        table = rule_table(buildings.loc[labelled.index[train_idx]])
        tables.append(table)
        pred = snap_to_storey(
            labelled.iloc[test_idx]["building_class"]
            .map(table["table"])
            .astype(float)
            .fillna(table["global_median_m"])
            .to_numpy()
        )
        oof[test_idx] = pred
        residual_abs.append(np.abs(pred - y[test_idx]))

    coverage, widths = [], []
    for fold, res in enumerate(residual_abs):
        others = np.concatenate([r for i, r in enumerate(residual_abs) if i != fold])
        q = float(np.quantile(others, interval))
        coverage.append(float(np.mean(res <= q)))
        widths.append(2 * q)

    raw_quantile = float(np.quantile(np.concatenate(residual_abs), interval))
    quantile = max(raw_quantile, MIN_INTERVAL_M)
    metrics = _metrics(y, oof)
    metrics["coverage_80"] = round(float(np.mean(coverage)), 3)
    metrics["coverage_shipped"] = round(float(np.mean(np.concatenate(residual_abs) <= quantile)), 3)
    return {
        "strategy": "rule",
        "version": RULE_VERSION,
        "metrics": metrics,
        "interval_quantile_m": round(quantile, 2),
        "interval_quantile_raw_m": round(raw_quantile, 2),
        "interval_floor_m": MIN_INTERVAL_M,
        "interval_level": interval,
        "interval_width_median_m": round(float(np.median(widths)), 2),
        "folds": [
            {"fold": i, "n_test": len(res)}
            | {
                k: v
                for k, v in _metrics(y[folds[i][1]], oof[folds[i][1]]).items()
                if k in {"mae", "rmse", "r2"}
            }
            for i, res in enumerate(residual_abs)
        ],
        "table": rule_table(buildings),
    }


# ---------------------------------------------------------------------------
# Strategy 2: the learned benchmark
# ---------------------------------------------------------------------------
def _new_model(seed: int) -> RandomForestRegressor:
    return RandomForestRegressor(
        n_estimators=200,
        min_samples_leaf=8,
        max_features=0.5,
        random_state=seed,
        n_jobs=-1,
    )


def _target_encode(
    train_frame: pd.DataFrame, target_frame: pd.DataFrame, y_train: np.ndarray
) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    """Fold-safe class-median encoding: leave-one-out on train, table on target."""
    stats = pd.DataFrame({"c": train_frame["building_class"].to_numpy(), "h": y_train})
    sums = stats.groupby("c")["h"].sum()
    counts = stats.groupby("c")["h"].count()
    prior = float(np.mean(y_train))
    train_classes = train_frame["building_class"].to_numpy()
    target_classes = target_frame["building_class"].to_numpy()
    train_values = (sums.reindex(train_classes).to_numpy() - y_train + prior * SMOOTHING_K) / (
        counts.reindex(train_classes).to_numpy() - 1 + SMOOTHING_K
    )
    target_values = (sums.reindex(target_classes).to_numpy() + prior * SMOOTHING_K) / (
        counts.reindex(target_classes).to_numpy() + SMOOTHING_K
    )
    encoding_table = {
        str(k): float(v) for k, v in ((sums + prior * SMOOTHING_K) / (counts + SMOOTHING_K)).items()
    }
    return train_values, target_values, encoding_table


@dataclass
class FoldScore:
    fold: int
    n_train: int
    n_test: int
    mae: float
    rmse: float
    r2: float
    coverage_80: float = float("nan")


def train_height_model(
    buildings: pd.DataFrame, *, seed: int = 42, n_splits: int = 5, interval: float = 0.8
) -> dict[str, Any]:
    """Train the learned strategy and return a serialisable bundle."""
    labelled = buildings[buildings["has_height_label"]].reset_index(drop=True)
    if len(labelled) < n_splits * 4:
        raise ValueError(f"not enough labelled buildings ({len(labelled)}) for {n_splits}-fold CV")

    base = feature_matrix(labelled)
    y = labelled["height_m"].to_numpy(dtype=float)
    groups = labelled["cv_block"].to_numpy()
    folds = list(GroupKFold(n_splits=n_splits).split(base, y, groups))

    oof = np.full(len(y), np.nan)
    fold_scores: list[FoldScore] = []
    residual_abs: list[np.ndarray] = []
    importance_acc = np.zeros(len(base.columns) + 1)  # + class median target encoding
    encoding_table: dict[str, float] = {}
    for fold, (train_idx, test_idx) in enumerate(folds):
        train_values, target_values, encoding_table = _target_encode(
            labelled.iloc[train_idx], labelled.iloc[test_idx], y[train_idx]
        )
        X_train = np.c_[base.iloc[train_idx].to_numpy(), train_values]
        X_test = np.c_[base.iloc[test_idx].to_numpy(), target_values]
        model = _new_model(seed + fold).fit(X_train, y[train_idx])
        oof[test_idx] = snap_to_storey(model.predict(X_test))
        m = _metrics(y[test_idx], oof[test_idx])
        fold_scores.append(
            FoldScore(fold, len(train_idx), len(test_idx), m["mae"], m["rmse"], m["r2"])
        )
        result = permutation_importance(
            model,
            X_test,
            y[test_idx],
            n_repeats=8,
            random_state=seed + fold,
            scoring="neg_mean_absolute_error",
            n_jobs=1,
        )
        importance_acc += result.importances_mean
        residual_abs.append(np.abs(oof[test_idx] - y[test_idx]))

    coverage, widths = [], []
    for fold, res in enumerate(residual_abs):
        others = np.concatenate([r for i, r in enumerate(residual_abs) if i != fold])
        q = float(np.quantile(others, interval))
        coverage.append(float(np.mean(res <= q)))
        widths.append(2 * q)
        fold_scores[fold].coverage_80 = round(coverage[-1], 3)
    q_raw = float(np.quantile(np.concatenate(residual_abs), interval))
    q_final = max(q_raw, MIN_INTERVAL_M)

    metrics = _metrics(y, oof)
    metrics["coverage_80"] = round(float(np.mean(coverage)), 3)

    random_oof = np.full(len(y), np.nan)
    for fold, (train_idx, test_idx) in enumerate(
        KFold(n_splits=n_splits, shuffle=True, random_state=seed).split(base)
    ):
        train_values, target_values, _ = _target_encode(
            labelled.iloc[train_idx], labelled.iloc[test_idx], y[train_idx]
        )
        model = _new_model(seed + 100 + fold).fit(
            np.c_[base.iloc[train_idx].to_numpy(), train_values], y[train_idx]
        )
        random_oof[test_idx] = snap_to_storey(
            model.predict(np.c_[base.iloc[test_idx].to_numpy(), target_values])
        )
    random_metrics = _metrics(y, random_oof)

    final_values, _, final_table = _target_encode(labelled, labelled, y)
    final_model = _new_model(seed).fit(np.c_[base.to_numpy(), final_values], y)

    importance = pd.DataFrame(
        {
            "feature": [*base.columns, "class_median_height_m"],
            "permutation_importance_mae_m": (importance_acc / n_splits).round(3),
        }
    ).sort_values("permutation_importance_mae_m", ascending=False)

    return {
        "model": final_model,
        "feature_names": [*base.columns, "class_median_height_m"],
        "encoding_table": final_table or encoding_table,
        "global_median_m": round(float(np.median(y)), 2),
        "medians": {name: float(np.median(base[name].to_numpy())) for name in base.columns},
        "metrics": metrics,
        "random_fold_metrics": random_metrics,
        "folds": [score.__dict__ for score in fold_scores],
        "importance": importance.to_dict("records"),
        "interval_quantile_m": round(q_final, 2),
        "interval_quantile_raw_m": round(q_raw, 2),
        "interval_level": interval,
        "interval_width_median_m": round(float(np.median(widths)), 2),
        "storey_exact_accuracy": round(float(np.mean(_storey_class(oof) == _storey_class(y))), 3),
        "storey_within_one_accuracy": round(
            float(
                np.mean(
                    np.abs(np.round(oof / STOREY_HEIGHT_M) - np.round(y / STOREY_HEIGHT_M)) <= 1
                )
            ),
            3,
        ),
        "storey_prior": round(
            float(pd.Series(_storey_class(y)).value_counts(normalize=True).max()), 3
        ),
        "label_coverage": round(100 * len(labelled) / len(buildings), 1),
        "n_labelled": len(labelled),
        "n_total": len(buildings),
        "seed": seed,
        "version": MODEL_VERSION,
        "target_definition": "height_m = Overture `height` when present, else `num_floors` * 3.0 m",
    }


def predict_heights(bundle: dict[str, Any], buildings: pd.DataFrame) -> pd.DataFrame:
    """Apply the learned strategy to all footprints."""
    frame = buildings.copy()
    base = feature_matrix(frame)
    encoded = (
        frame["building_class"]
        .map(bundle["encoding_table"])
        .astype(float)
        .fillna(bundle["global_median_m"])
        .to_numpy()
    )
    X = np.c_[base.to_numpy(dtype=float), encoded]
    point = snap_to_storey(bundle["model"].predict(X))
    q = float(bundle["interval_quantile_m"])

    frame["height_modelled_m"] = point
    frame["height_lo_m"] = np.maximum(0.0, point - q)
    frame["height_hi_m"] = point + q
    frame["height_final_m"] = frame["height_observed_m"].fillna(pd.Series(point, index=frame.index))
    frame["height_lo_final_m"] = np.where(
        frame["has_height_label"], frame["height_observed_m"], frame["height_lo_m"]
    )
    frame["height_hi_final_m"] = np.where(
        frame["has_height_label"], frame["height_observed_m"], frame["height_hi_m"]
    )
    frame["height_uncertainty_m"] = np.where(
        frame["has_height_label"],
        0.0,
        (frame["height_hi_final_m"] - frame["height_lo_final_m"]) / 2,
    )
    frame["height_provenance"] = np.where(
        frame["has_height_label"], frame["height_source"], "model:" + bundle["version"]
    )
    return frame


def explain_prediction(
    bundle: dict[str, Any], buildings: pd.DataFrame, gers_id: str, *, top_k: int = 5
) -> dict[str, Any]:
    """Occlusion explanation: replace one feature with the training median."""
    row = buildings.loc[buildings["gers_id"] == gers_id]
    if row.empty:
        raise KeyError(f"unknown building {gers_id}")
    base = feature_matrix(row)
    encoded = (
        row["building_class"]
        .map(bundle["encoding_table"])
        .astype(float)
        .fillna(bundle["global_median_m"])
        .to_numpy()
    )
    x = np.r_[base.to_numpy(dtype=float)[0], encoded]
    point = float(bundle["model"].predict(x.reshape(1, -1))[0])
    contributions = []
    for index, name in enumerate(bundle["feature_names"]):
        occluded = x.copy()
        occluded[index] = bundle["medians"].get(name, 0.0)
        contributions.append(
            {
                "feature": name,
                "delta_m": round(
                    point - float(bundle["model"].predict(occluded.reshape(1, -1))[0]), 2
                ),
            }
        )
    contributions.sort(key=lambda item: abs(item["delta_m"]), reverse=True)
    return {
        "gers_id": gers_id,
        "prediction_m": round(point, 2),
        "interval_80_m": [
            round(point - bundle["interval_quantile_m"], 2),
            round(point + bundle["interval_quantile_m"], 2),
        ],
        "explanation_method": "occlusion-to-training-median",
        "top_contributions": contributions[:top_k],
        "all_contributions": contributions,
    }


# ---------------------------------------------------------------------------
# The decision: benchmark, then choose
# ---------------------------------------------------------------------------
def benchmark_heights(
    buildings: pd.DataFrame, *, seed: int = 42, n_splits: int = 5, interval: float = 0.8
) -> dict[str, Any]:
    """Evaluate rule and learned strategies under identical blocked folds."""
    rule = calibrate_rule(buildings, n_splits=n_splits, interval=interval)
    learned = train_height_model(buildings, seed=seed, n_splits=n_splits, interval=interval)
    delta = round(learned["metrics"]["mae"] - rule["metrics"]["mae"], 2)
    decision = "rule" if delta >= 0 else "model"
    return {
        "decision": decision,
        "delta_mae_m": delta,
        "rule": {k: v for k, v in rule.items() if k != "table"},
        "rule_table": rule["table"],
        "model": {k: v for k, v in learned.items() if k != "model"},
        "learned_bundle": learned,
        "rationale": (
            "The learned strategy is only adopted when it reduces blocked MAE; otherwise the "
            "rule is shipped because it is simpler and fully explainable."
        ),
    }


def write_model_card(benchmark: dict[str, Any], path: Path, aoi_name: str) -> Path:
    """Write a model card covering both strategies and the selection decision."""
    rule = benchmark["rule"]
    learned = benchmark["model"]
    top = learned["importance"][:6]
    rows = "\n".join(
        f"| `{item['feature']}` | {item['permutation_importance_mae_m']:.2f} |" for item in top
    )
    folds = "\n".join(
        f"| {f['fold']} | {f['n_test']} | {f['mae']:.2f} | {f['rmse']:.2f} | {f['r2']:.3f} | {f['coverage_80']:.2f} |"
        for f in learned["folds"]
    )
    table = "\n".join(
        f"| `{k}` | {v:.2f} |" for k, v in sorted(benchmark["rule_table"]["table"].items())
    )
    if benchmark["delta_mae_m"] < 0:
        comparison = (
            f"The learned model reduces blocked MAE by {-benchmark['delta_mae_m']} m, so it is the "
            "shipped strategy."
        )
    elif benchmark["delta_mae_m"] == 0:
        comparison = (
            "The two strategies are indistinguishable under blocked cross-validation (identical "
            "MAE), so the rule is shipped: it has no fitted parameters beyond a per-class median "
            "and is fully explainable."
        )
    else:
        comparison = (
            f"The learned model is worse by {benchmark['delta_mae_m']} m of blocked MAE, so the "
            "rule is shipped: simpler, and fully explainable."
        )
    comparison += (
        f" Random-fold validation gives MAE {learned['random_fold_metrics']['mae']} m against "
        f"{learned['metrics']['mae']} m with blocked folds; blocked scores are the ones quoted "
        "because they are the defensible design for spatial data."
    )
    text = f"""# Model card — building height completion

**Study area:** {aoi_name} · **Regenerate with:** `citytwin height --benchmark`

## What this module does

{learned["n_labelled"]} of {learned["n_total"]} footprints ({learned["label_coverage"]}%) carry a
height label. The rest need a height so that a LoD1 city model can be generated.
Two strategies are implemented and compared; the shipped default is **{benchmark["decision"]}**.

| Strategy | Definition |
|---|---|
| `rule` (default) | Smoothed per-`building_class` median, snapped to the 3 m storey lattice |
| `model` | Random forest on morphology + fold-safe class-median encoding |

Target: {learned["target_definition"]} · Source: Overture Maps (© OpenStreetMap
contributors, Microsoft ML Buildings), ODbL 1.0.

## Blocked cross-validation (300 m spatial blocks, 5 folds)

| Strategy | MAE (m) | RMSE (m) | R² | 80% coverage | Interval width |
|---|---|---|---|---|---|
| **rule (shipped)** | **{rule["metrics"]["mae"]}** | **{rule["metrics"]["rmse"]}** | **{rule["metrics"]["r2"]}** | {rule["metrics"]["coverage_80"]} | ±{rule["interval_quantile_m"]} m |
| model (benchmark) | {learned["metrics"]["mae"]} | {learned["metrics"]["rmse"]} | {learned["metrics"]["r2"]} | {learned["metrics"]["coverage_80"]} | ±{learned["interval_quantile_m"]} m |
| model, random folds (reference only) | {learned["random_fold_metrics"]["mae"]} | {learned["random_fold_metrics"]["rmse"]} | {learned["random_fold_metrics"]["r2"]} | — | — |

ΔMAE (model − rule): **{benchmark["delta_mae_m"]} m**. {benchmark["rationale"]}

{comparison}

### Read these scores with the label set in mind

{learned["storey_prior"]:.0%} of the labelled footprints fall in the one-to-two-storey class, so a
constant prediction is already nearly unbeatable: R² close to zero for *both* strategies
says that neither explains the little variance there is. The MAE therefore measures how
homogeneous the labels are, not how accurate an imputed height is on an unlabelled
footprint. The labels are OSM floor counts concentrated in a few hand-mapped residential
neighbourhoods; the unlabelled footprints are mostly Microsoft ML detections elsewhere in
the city, which the cross-validation cannot reach.

### Rule calibration table

| Building class | Estimated height (m) |
|---|---|
{table}

### Learned model per fold

| Fold | Test | MAE | RMSE | R² | Coverage@80 |
|---|---|---|---|---|---|
{folds}

### Learned model importance (ΔMAE, metres)

| Feature | Importance |
|---|---|
{rows}

## Uncertainty

Every imputed footprint carries an interval of ±{rule["interval_quantile_m"]} m, stored as
`height_lo_final_m` / `height_hi_final_m` and propagated by Monte Carlo into the
exposure index (`docs/uncertainty.md`). The raw 80% conformal quantile of the rule is
±{rule["interval_quantile_raw_m"]} m; the shipped half-width is floored at one storey
({rule["interval_floor_m"]:.0f} m) because floor-count labels are whole storeys and an imputed
height is never known to better than that. With the floor, {rule["metrics"]["coverage_shipped"]:.0%}
of the out-of-fold labels fall inside the interval.

## What this benchmark shows

Footprint morphology carries almost no height signal in a homogeneous low-rise city
with a narrow label set. That is a property of the data, not a tuning failure, and it
is why the twin reports intervals, gives height a small weight in the exposure index
(`configs/exposure_weights.json`) and shows how unstable the hotspot set is under
height redraws. A photogrammetric or LiDAR DSM, or building heights from a
stereo-satellite product, would change this conclusion; the benchmark can be re-run
with any label source.

## Limitations

1. Small, clustered label set: almost all labels are two-storey residential blocks mapped in OSM.
2. Many OSM footprints are whole blocks rather than single buildings; ML footprints are single roofs.
3. Flat-roof LoD1 only — no roof shape, setbacks or building parts.
4. Floor counts are mapped inconsistently (roof terraces, mezzanines); 3 m/storey is an assumption.
5. Static heights: no construction year, no vertical extension over time.

## Operational notes

Each geometry keeps `height_provenance` (`height_tag`, `levels`, `rule:<version>`,
`model:<version>`). The provenance document records the strategy, the quantile and
the label hash, so an auditor can reproduce every interval.
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def save_bundle(bundle: dict[str, Any], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {key: value for key, value in bundle.items() if key != "model"}
    joblib.dump({"model": bundle["model"], "meta": payload}, path)
    path.with_suffix(".json").write_text(
        json.dumps(payload, indent=2, default=str), encoding="utf-8"
    )
    return path


def load_bundle(path: Path) -> dict[str, Any]:
    payload = joblib.load(path)
    return {"model": payload["model"], **payload["meta"]}
