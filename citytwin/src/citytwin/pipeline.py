"""Pipeline orchestration: one function that produces the whole twin.

Every step is recorded in a PROV-JSON document, so the derived artefacts can be
traced back to the Overture release and the parameters that produced them. Call it
from the CLI (``citytwin build``) or from a notebook.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import geopandas as gpd

from . import __version__
from .analytics import build_exposure
from .config import (
    BUILD_DIR,
    CRS_METRIC,
    DOCS_ASSETS,
    OVERTURE_RELEASE,
    PROCESSED_DIR,
    REPO_ROOT,
    WEB_DIR,
    aoi_from_slug,
    load_weights,
)
from .exporters.charts import benchmark_chart
from .exporters.cityjson import buildings_to_cityjson, validate_cityjson
from .exporters.tiles3d import buildings_to_3dtiles, validate_glb
from .exporters.viewer import build_viewer
from .features import build_features
from .ingest.overture import fetch_overture, parse_overture, write_layers
from .model import apply_rule, benchmark_heights, calibrate_rule, write_model_card
from .provenance import Provenance, sha256_file
from .store import FeatureStore
from .typology import build_typology, exposure_by_typology


@dataclass
class PipelineResult:
    aoi_name: str
    metrics: dict[str, Any]
    paths: dict[str, Path] = field(default_factory=dict)
    layers: Any = None
    buildings: gpd.GeoDataFrame | None = None
    cells: gpd.GeoDataFrame | None = None


def run_pipeline(
    aoi_slug: str | None = None,
    *,
    refresh: bool = False,
    n_draws: int = 200,
    n_sensitivity: int = 500,
    run_benchmark: bool = True,
    keep_model_bundle: bool = True,
) -> PipelineResult:
    """Build the twin end to end. Returns metrics and artefact paths."""
    aoi = aoi_from_slug(aoi_slug)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    provenance = Provenance(BUILD_DIR / "provenance.json")
    paths: dict[str, Path] = {}

    # 1. ingest ------------------------------------------------------------
    with provenance.activity(
        "ingest", aoi=aoi.slug, bbox=aoi.bbox, source=f"Overture Maps {OVERTURE_RELEASE}"
    ) as activity:
        raw = fetch_overture(aoi, refresh=refresh)
        layers = parse_overture(raw, aoi)
        processed = write_layers(layers, PROCESSED_DIR)
        for name, path in processed.items():
            provenance.record_file(
                path,
                kind=name,
                activity=activity,
                source=layers.metadata["source"],
                license="ODbL-1.0",
            )
        paths["layers_metadata"] = processed["metadata"]

    # 2. features ------------------------------------------------------------
    with provenance.activity("features", buildings=len(layers.buildings)) as activity:
        feature_set = build_features(layers)
        provenance.record_value("featureset", {"n": len(feature_set.buildings)}, activity=activity)

    # 3. height completion ---------------------------------------------------
    with provenance.activity("height", strategy="rule", interval=0.8) as activity:
        calibration = calibrate_rule(feature_set.buildings)
        heights = apply_rule(
            feature_set.buildings, calibration["table"], calibration["interval_quantile_m"]
        )
        provenance.record_value("height_calibration", calibration, activity=activity)

    benchmark = None
    if run_benchmark:
        with provenance.activity("height_benchmark", n_splits=5) as activity:
            benchmark = benchmark_heights(feature_set.buildings)
            provenance.record_value(
                "height_benchmark",
                {
                    "decision": benchmark["decision"],
                    "delta_mae_m": benchmark["delta_mae_m"],
                    "rule": benchmark["rule"]["metrics"],
                    "model": benchmark["model"]["metrics"],
                },
                activity=activity,
            )
            if keep_model_bundle:
                from .model import save_bundle

                paths["model"] = save_bundle(
                    benchmark["learned_bundle"], BUILD_DIR / "model" / "height_rf.joblib"
                )

    # 4. typology ------------------------------------------------------------
    with provenance.activity("typology", method="kmeans") as activity:
        typology = build_typology(heights)
        provenance.record_value("typology", typology.summary, activity=activity)

    # 5. exposure ------------------------------------------------------------
    green_metric = layers.green.to_crs(CRS_METRIC) if len(layers.green) else None
    trees_metric = layers.trees.to_crs(CRS_METRIC) if len(layers.trees) else None
    with provenance.activity(
        "exposure", weights=load_weights().as_dict(), n_draws=n_draws
    ) as activity:
        exposure = build_exposure(
            typology.buildings,
            green_metric,
            trees_metric,
            load_weights(),
            n_draws=n_draws,
            n_samples=n_sensitivity,
        )
        provenance.record_value("exposure_summary", exposure.summary, activity=activity)

    by_typology = exposure_by_typology(exposure.buildings)

    # 6. outputs -------------------------------------------------------------
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    buildings_path = PROCESSED_DIR / "buildings_enriched.geojson"
    exposure.buildings.to_file(buildings_path, driver="GeoJSON")
    cells_path = PROCESSED_DIR / "cells.geojson"
    exposure.cells.to_crs("EPSG:4326").to_file(cells_path, driver="GeoJSON")
    paths.update({"buildings": buildings_path, "cells": cells_path})

    with provenance.activity(
        "store_build", collections=["buildings", "cells", "green"]
    ) as activity:
        store_path = BUILD_DIR / "store" / "citytwin.sqlite"
        with FeatureStore.create(store_path) as store:
            store.add_collection(
                "buildings",
                exposure.buildings,
                id_column="gers_id",
                title="Building footprints with completed heights",
                description=(
                    "Overture footprints (OSM + Microsoft ML Buildings), height completion and "
                    "250 m exposure attributes. ODbL 1.0."
                ),
                extra_properties=[
                    "building_class",
                    "area_m2",
                    "height_final_m",
                    "height_provenance",
                    "height_uncertainty_m",
                    "cell_hei",
                    "hotspot_probability",
                    "typology",
                    "typology_name",
                    "height_source",
                    "footprint_source",
                ],
            )
            store.add_collection(
                "cells",
                exposure.cells,
                id_column="cell_id",
                title="250 m heat exposure grid",
                description="Weighted heat exposure index with sensitivity and uncertainty.",
                extra_properties=[
                    "mean_height_m",
                    "built_up_share",
                    "green_share",
                    "tree_count",
                    "hei",
                    "hei_percentile",
                    "hei_p05",
                    "hei_p95",
                    "hotspot_probability",
                ],
            )
            if len(layers.green):
                store.add_collection(
                    "green",
                    layers.green,
                    id_column="gers_id",
                    title="Urban green areas",
                    description="Parks, gardens and other vegetated land from Overture base (ODbL 1.0).",
                    extra_properties=["green_type", "name"],
                )
        paths["store"] = store_path
        provenance.record_file(store_path, kind="feature_store", activity=activity)

    # 7. 3D exports ----------------------------------------------------------
    with provenance.activity("cityjson_export") as activity:
        cityjson_path = buildings_to_cityjson(
            exposure.buildings,
            BUILD_DIR / "cityjson" / f"{aoi.slug}_lod1.city.json",
            aoi_name=aoi.name,
        )
        paths["cityjson"] = cityjson_path
        paths["cityjson_validation"] = BUILD_DIR / "cityjson" / "validation.json"
        validation = validate_cityjson(cityjson_path)
        paths["cityjson_validation"].write_text(json.dumps(validation, indent=2), encoding="utf-8")
        provenance.record_file(cityjson_path, kind="cityjson_lod1", activity=activity)

    with provenance.activity("tiles3d_export") as activity:
        tile_summary = buildings_to_3dtiles(exposure.buildings, BUILD_DIR / "3dtiles")
        paths["tileset"] = Path(tile_summary["tileset"])
        paths["glb"] = Path(tile_summary["content"])
        paths["tiles_summary"] = BUILD_DIR / "3dtiles" / "summary.json"
        paths["tiles_summary"].write_text(json.dumps(tile_summary, indent=2), encoding="utf-8")
        glb_validation = validate_glb(paths["glb"])
        paths["glb_validation"] = BUILD_DIR / "3dtiles" / "validation.json"
        paths["glb_validation"].write_text(json.dumps(glb_validation, indent=2), encoding="utf-8")
        provenance.record_file(paths["tileset"], kind="tileset", activity=activity)
        provenance.record_file(paths["glb"], kind="glb", activity=activity)

    # 8. viewer --------------------------------------------------------------
    viewer_path = build_viewer(
        exposure.buildings,
        exposure.cells,
        layers.green,
        layers.streets,
        out_path=WEB_DIR / "index.html",
        meta={
            "strategy": calibration["table"]["version"],
            "labelled": calibration["table"]["n_labelled"],
            "label_coverage": round(
                100 * calibration["table"]["n_labelled"] / len(feature_set.buildings), 1
            ),
            "interval": calibration["interval_quantile_m"],
            "release": layers.metadata["release"],
            "draws": n_draws,
            "aoi": aoi.name,
            "provenance": sha256_file(buildings_path),
        },
    )
    paths["viewer"] = viewer_path

    # 9. documentation artefacts ---------------------------------------------
    if benchmark:
        with provenance.activity("model_card") as activity:
            card = write_model_card(benchmark, REPO_ROOT / "docs" / "model_card.md", aoi.name)
            paths["model_card"] = card
            provenance.record_file(card, kind="model_card", activity=activity)

    DOCS_ASSETS.mkdir(parents=True, exist_ok=True)
    if benchmark:
        chart_path = benchmark_chart(benchmark, DOCS_ASSETS / "height_benchmark.svg")
        paths["benchmark_chart"] = chart_path

    # 10. metrics -------------------------------------------------------------
    metrics = {
        "aoi": {"name": aoi.name, "bbox": list(aoi.bbox)},
        "version": __version__,
        "generated": date.today().isoformat(),
        "data": layers.metadata,
        "height": {
            "strategy": calibration["table"]["version"],
            "metrics": calibration["metrics"],
            "interval_quantile_m": calibration["interval_quantile_m"],
            "interval_level": calibration["interval_level"],
            "table": calibration["table"]["table"],
            "benchmark": {
                "decision": benchmark["decision"],
                "delta_mae_m": benchmark["delta_mae_m"],
                "rule": benchmark["rule"]["metrics"],
                "model": benchmark["model"]["metrics"],
                "model_random_folds": benchmark["model"]["random_fold_metrics"],
                "model_coverage_80": benchmark["model"]["metrics"]["coverage_80"],
                "importance": benchmark["model"]["importance"][:6],
            }
            if benchmark
            else None,
        },
        "typology": typology.summary,
        "exposure": exposure.summary,
        "sensitivity": exposure.sensitivity,
        "uncertainty": exposure.uncertainty,
        "by_typology": by_typology.to_dict("records"),
        "artefacts": {
            "cityjson_buildings": validation["buildings"],
            "cityjson_open_shells": validation["open_shells"],
            "glb_triangles": tile_summary["triangles"],
            "glb_bytes": tile_summary["bytes"],
        },
    }
    metrics_path = REPO_ROOT / "docs" / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, default=str), encoding="utf-8")
    paths["metrics"] = metrics_path
    paths["provenance"] = provenance.write(BUILD_DIR / "provenance.json")

    return PipelineResult(
        aoi_name=aoi.name,
        metrics=metrics,
        paths=paths,
        layers=layers,
        buildings=exposure.buildings,
        cells=exposure.cells,
    )
