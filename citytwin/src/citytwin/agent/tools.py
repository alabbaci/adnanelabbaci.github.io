"""Deterministic, auditable tools the agent can call.

Every tool answers from the built feature store or the recorded metrics — never
from the language model's memory. Each result carries ``evidence`` (the numbers
and where they came from) and ``caveats``, because the point of this layer is
that a planner cannot invent a number: it can only choose which query to run.

The same registry is exposed twice: as Python functions for the CLI/eval harness
and as MCP tools (``citytwin.agent.mcp_server``) for external assistants.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ..config import BUILD_DIR, REPO_ROOT
from ..provenance import Provenance
from ..store import Feature, FeatureStore

STORE_PATH = BUILD_DIR / "store" / "citytwin.sqlite"
METRICS_PATH = REPO_ROOT / "docs" / "metrics.json"


@dataclass
class ToolResult:
    tool: str
    args: dict[str, Any]
    answer: str
    data: dict[str, Any] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "args": self.args,
            "answer": self.answer,
            "data": self.data,
            "evidence": self.evidence,
            "caveats": self.caveats,
            "sources": self.sources,
        }


def _store() -> FeatureStore:
    if not STORE_PATH.exists():
        raise FileNotFoundError(
            f"feature store missing at {STORE_PATH} — run `citytwin build` first"
        )
    return FeatureStore.open(STORE_PATH)


def _metrics() -> dict[str, Any]:
    if not METRICS_PATH.exists():
        return {}
    return json.loads(METRICS_PATH.read_text(encoding="utf-8"))


def _filter(features: list[Feature], **conditions: Any) -> list[Feature]:
    matched = []
    for feature in features:
        if all(feature.properties.get(key) == value for key, value in conditions.items()):
            matched.append(feature)
    return matched


def _feature_collection_url(collection: str) -> str:
    return f"/collections/{collection}/items"


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------
def area_summary(bbox: str | None = None) -> ToolResult:
    """Summarise the exposure grid inside an optional WGS84 bbox."""
    query_bbox = None
    if bbox:
        parts = [float(v) for v in bbox.split(",")]
        if len(parts) != 4:
            raise ValueError("bbox must be minx,miny,maxx,maxy")
        query_bbox = tuple(parts)
    with _store() as store:
        cells = store.bbox("cells", bbox=query_bbox, limit=10_000)
        buildings = store.bbox("buildings", bbox=query_bbox, limit=10_000)
    hei = [c.properties["hei"] for c in cells if isinstance(c.properties.get("hei"), (int, float))]
    heights = [
        b.properties["height_final_m"]
        for b in buildings
        if isinstance(b.properties.get("height_final_m"), (int, float))
    ]
    mean_hei = round(sum(hei) / len(hei), 1) if hei else None
    answer = (
        f"{len(cells)} grid cells ({len(hei)} with an exposure score) covering "
        f"{len(buildings)} buildings; mean exposure index {mean_hei}, "
        f"mean modelled height {round(sum(heights) / len(heights), 1) if heights else 'n/a'} m."
    )
    return ToolResult(
        tool="area_summary",
        args={"bbox": bbox},
        answer=answer,
        data={
            "cells": len(cells),
            "buildings": len(buildings),
            "mean_hei": mean_hei,
            "max_hei": round(max(hei), 1) if hei else None,
            "mean_height_m": round(sum(heights) / len(heights), 2) if heights else None,
        },
        evidence=[
            f"{len(cells)} cells read from collection `cells` (R*Tree bbox query)",
            f"{len(buildings)} footprints read from collection `buildings`",
        ],
        caveats=[
            "Exposure is a relative index (0-100), not a temperature measurement.",
            "Heights are completed from a rule where the source has no floor count.",
        ],
        sources=[_feature_collection_url("cells"), _feature_collection_url("buildings")],
    )


def hotspot_report(min_probability: float = 0.8) -> ToolResult:
    """Cells that are persistent hotspots across the height uncertainty draws."""
    with _store() as store:
        cells = store.bbox("cells", limit=10_000)
    robust = [
        c
        for c in cells
        if isinstance(c.properties.get("hotspot_probability"), (int, float))
        and c.properties["hotspot_probability"] >= min_probability
    ]
    fragile = [
        c
        for c in cells
        if isinstance(c.properties.get("hotspot_probability"), (int, float))
        and 0 < c.properties["hotspot_probability"] < min_probability
    ]
    ordered = sorted(robust, key=lambda c: -(c.properties.get("hei") or 0))
    answer = (
        f"{len(robust)} of {len(cells)} cells stay above the 90th-percentile hotspot threshold in "
        f"at least {int(min_probability * 100)}% of the height-uncertainty draws "
        f"({len(fragile)} more are intermittently hot)."
    )
    return ToolResult(
        tool="hotspot_report",
        args={"min_probability": min_probability},
        answer=answer,
        data={
            "cells": len(cells),
            "robust_hotspots": len(robust),
            "intermittent_hotspots": len(fragile),
            "top_hotspots": [
                {
                    "cell_id": c.fid,
                    "hei": c.properties.get("hei"),
                    "probability": c.properties.get("hotspot_probability"),
                    "buildings": c.properties.get("buildings", None),
                }
                for c in ordered[:5]
            ],
        },
        evidence=[
            "hotspot_probability stored per cell from Monte Carlo redraws of imputed heights",
            "threshold = 90th percentile of the observed exposure index",
        ],
        caveats=[
            "Only cells with probability >= the requested level should be treated as robust findings.",
            "Probability is conditional on the rule-based height distribution, not on LiDAR truth.",
        ],
        sources=[_feature_collection_url("cells")],
    )


def explain_cell(cell_id: str) -> ToolResult:
    """Decompose one cell: exposure, its inputs, and the buildings inside it."""
    with _store() as store:
        cell = store.get("cells", cell_id)
        if cell is None:
            available = [f.fid for f in store.bbox("cells", limit=10)]
            return ToolResult(
                tool="explain_cell",
                args={"cell_id": cell_id},
                answer=(
                    f"No grid cell {cell_id} in this study area. "
                    f"Available cell ids start with {', '.join(available[:5])}."
                ),
                data={"found": False, "available": available},
                evidence=["cell ids enumerated from collection `cells`"],
                caveats=["Cell identifiers are grid-generated and do not carry meaning."],
                sources=[_feature_collection_url("cells")],
            )
        buildings = [
            b
            for b in store.bbox("buildings", limit=10_000)
            if b.properties.get("cell_id") == cell_id
        ]
    props = cell.properties
    weights = _metrics().get("exposure", {}).get("weights") or {}
    components = {
        "mean_height_m": props.get("mean_height_m"),
        "green_share": props.get("green_share"),
        "tree_count": props.get("tree_count"),
        "built_up_share": props.get("built_up_share"),
    }
    answer = (
        f"Cell {cell_id} has exposure {props.get('hei')} (percentile {props.get('hei_percentile')}), "
        f"mean building height {props.get('mean_height_m')} m, green cover "
        f"{round(100 * (props.get('green_share') or 0), 1)}%, and {len(buildings)} buildings."
    )
    return ToolResult(
        tool="explain_cell",
        args={"cell_id": cell_id},
        answer=answer,
        data={
            "cell": props,
            "component_values": components,
            "weights": weights,
            "building_count": len(buildings),
            "tallest": max(
                (b.properties.get("height_final_m") or 0 for b in buildings), default=None
            ),
        },
        evidence=[
            "cell attributes read from collection `cells`",
            f"{len(buildings)} building attributes filtered on cell_id",
        ],
        caveats=[
            "Component weights are a documented choice (configs/exposure_weights.json), not a fitted model.",
        ],
        sources=[_feature_collection_url("cells")],
    )


def height_profile() -> ToolResult:
    """How heights were completed, how accurate they are, and what was shipped."""
    metrics = _metrics()
    height = metrics.get("height", {})
    rule = height.get("metrics", {})
    benchmark = height.get("benchmark") or {}
    answer = (
        f"Shipped strategy `{height.get('strategy')}` reaches MAE {rule.get('mae')} m "
        f"(RMSE {rule.get('rmse')} m, 80% coverage {rule.get('coverage_80')}) on blocked folds; "
        f"the learned benchmark MAE is {benchmark.get('model', {}).get('mae')} m, so "
        f"`{benchmark.get('decision', 'rule')}` is published."
    )
    return ToolResult(
        tool="height_profile",
        args={},
        answer=answer,
        data={
            "strategy": height.get("strategy"),
            "rule": rule,
            "benchmark": {
                "decision": benchmark.get("decision"),
                "delta_mae_m": benchmark.get("delta_mae_m"),
                "model": benchmark.get("model"),
                "model_random_folds": benchmark.get("model_random_folds"),
            },
            "class_table": height.get("table"),
        },
        evidence=[
            "docs/metrics.json written by the last pipeline run",
            "5-fold blocked CV with 300 m spatial blocks",
        ],
        caveats=[
            "Accuracy is measured on the 10% of footprints that carry a height label.",
            "Labels skew towards public buildings and recent mapping activity.",
        ],
        sources=["docs/metrics.json", "docs/model_card.md"],
    )


def list_tall_buildings(min_height: float = 12.0, limit: int = 10) -> ToolResult:
    """Find the tallest footprints, with their provenance tag."""
    with _store() as store:
        buildings = store.bbox("buildings", limit=10_000)
    candidates = [
        b
        for b in buildings
        if isinstance(b.properties.get("height_final_m"), (int, float))
        and b.properties["height_final_m"] >= min_height
    ]
    candidates.sort(key=lambda b: -b.properties["height_final_m"])
    answer = (
        f"{len(candidates)} footprints are at least {min_height} m tall; the highest is "
        f"{candidates[0].properties['height_final_m']} m."
        if candidates
        else f"No footprint reaches {min_height} m."
    )
    return ToolResult(
        tool="list_tall_buildings",
        args={"min_height": min_height, "limit": limit},
        answer=answer,
        data={
            "count": len(candidates),
            "buildings": [
                {
                    "id": b.fid,
                    "height_m": b.properties.get("height_final_m"),
                    "provenance": b.properties.get("height_provenance"),
                    "class": b.properties.get("building_class"),
                }
                for b in candidates[:limit]
            ],
        },
        evidence=["height_final_m and height_provenance read from collection `buildings`"],
        caveats=[
            "Labelled heights are OSM floor counts x 3 m carried by Overture; they are not survey-grade."
        ],
        sources=[_feature_collection_url("buildings")],
    )


def typology_profile() -> ToolResult:
    """The unsupervised urban typology and its exposure signature."""
    metrics = _metrics()
    typology = metrics.get("typology", {})
    by_type = metrics.get("by_typology", [])
    answer = (
        f"{typology.get('n_clusters')} morphology clusters (silhouette {typology.get('silhouette')}, "
        f"stability ARI {typology.get('stability_ari_mean')}); exposure ranges from "
        + (
            f"{min(t.get('mean_hei', 0) for t in by_type):.1f} to "
            f"{max(t.get('mean_hei', 0) for t in by_type):.1f}"
            if by_type
            else "n/a"
        )
        + " across types."
    )
    return ToolResult(
        tool="typology_profile",
        args={},
        answer=answer,
        data={"summary": typology, "by_typology": by_type},
        evidence=[
            "KMeans on standardised form and context features, k chosen by silhouette",
            "stability = mean adjusted Rand index over resampled fits",
        ],
        caveats=[
            "Height is excluded from the clustering features because it is mostly imputed.",
            "Silhouette around 0.2 indicates weak but real structure, not clean classes.",
        ],
        sources=["docs/metrics.json"],
    )


def greening_candidates(top_n: int = 5) -> ToolResult:
    """Cells with high exposure and little green cover — where planting pays off."""
    with _store() as store:
        cells = store.bbox("cells", limit=10_000)
    scored = [
        c
        for c in cells
        if isinstance(c.properties.get("hei"), (int, float))
        and isinstance(c.properties.get("green_share"), (int, float))
    ]
    scored.sort(key=lambda c: -(c.properties["hei"] * (1 - c.properties["green_share"])))
    answer = (
        "Highest exposure with lowest green cover: "
        + ", ".join(
            f"{c.fid} (HEI {c.properties['hei']}, green {round(100 * c.properties['green_share'])}%)"
            for c in scored[:top_n]
        )
        + "."
    )
    return ToolResult(
        tool="greening_candidates",
        args={"top_n": top_n},
        answer=answer,
        data={
            "candidates": [
                {
                    "cell_id": c.fid,
                    "hei": c.properties.get("hei"),
                    "green_share": c.properties.get("green_share"),
                    "tree_count": c.properties.get("tree_count"),
                    "built_up_share": c.properties.get("built_up_share"),
                }
                for c in scored[:top_n]
            ]
        },
        evidence=["score = HEI × (1 − green share), both stored per cell"],
        caveats=[
            "A screening heuristic for planning dialogue, not a planting plan: soil, ownership and "
            "street trees are not in the model.",
        ],
        sources=[_feature_collection_url("cells")],
    )


def uncertainty_report() -> ToolResult:
    """How stable the hotspot decision is under height uncertainty."""
    metrics = _metrics()
    uncertainty = metrics.get("uncertainty", {})
    answer = (
        f"Across {uncertainty.get('n_draws')} redraws the hotspot set overlaps the observed set "
        f"with Jaccard {uncertainty.get('hotspot_jaccard_mean')} on average "
        f"({uncertainty.get('cells_hotspot_prob_ge_0_8')} cells stay hot in ≥80% of draws); "
        f"the median 80% interval width of the index is {uncertainty.get('hei_interval_width_median')} points."
    )
    return ToolResult(
        tool="uncertainty_report",
        args={},
        answer=answer,
        data=uncertainty,
        evidence=[
            "Monte Carlo over per-building 80% conformal height intervals",
            "Jaccard compares each draw's hotspot set with the observed-height hotspot set",
        ],
        caveats=[
            "Low Jaccard is a statement about the height labels, not about the city: "
            "more height observations would shrink it.",
        ],
        sources=["docs/metrics.json", "docs/uncertainty.md"],
    )


def provenance_check() -> ToolResult:
    """Re-hash every recorded artefact and report mismatches."""
    document = BUILD_DIR / "provenance.json"
    if not document.exists():
        raise FileNotFoundError("no provenance record — run `citytwin build`")
    problems = Provenance.verify(document)
    record = json.loads(document.read_text(encoding="utf-8"))
    answer = (
        "All recorded artefacts match their hashes."
        if not problems
        else f"{len(problems)} artefact(s) do not match: " + "; ".join(problems[:3])
    )
    return ToolResult(
        tool="provenance_check",
        args={},
        answer=answer,
        data={
            "entities": len(record.get("entity", {})),
            "activities": len(record.get("activity", {})),
            "problems": problems,
        },
        evidence=["sha256 re-computed for every entity with a path"],
        caveats=["Only files still present on disk are verified; deleted artefacts are reported."],
        sources=["build/provenance.json"],
    )


def dataset_card() -> ToolResult:
    """What is in the twin, under which licence, at which resolution."""
    with _store() as store:
        collections = store.collections()
    metrics = _metrics()
    data = metrics.get("data", {})
    answer = (
        "Collections: "
        + ", ".join(f"{c['name']} ({c['count']})" for c in collections)
        + f"; study area {data.get('aoi', 'n/a')}."
    )
    return ToolResult(
        tool="dataset_card",
        args={},
        answer=answer,
        data={"collections": collections, "metadata": data},
        evidence=["collection registry read from the SQLite store"],
        caveats=["Source data: Overture Maps (© OpenStreetMap contributors, Microsoft), ODbL 1.0."],
        sources=["/collections"],
    )


TOOLS: dict[str, dict[str, Any]] = {
    "area_summary": {
        "function": area_summary,
        "description": "Summarise the 250 m exposure grid and building heights, optionally inside a WGS84 bbox.",
        "parameters": {
            "type": "object",
            "properties": {
                "bbox": {
                    "type": "string",
                    "description": "minx,miny,maxx,maxy in WGS84 (EPSG:4326)",
                }
            },
            "required": [],
        },
    },
    "hotspot_report": {
        "function": hotspot_report,
        "description": "List cells that remain hotspots across Monte Carlo redraws of imputed heights.",
        "parameters": {
            "type": "object",
            "properties": {
                "min_probability": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.8}
            },
            "required": [],
        },
    },
    "explain_cell": {
        "function": explain_cell,
        "description": "Explain one grid cell: exposure score, inputs, weights, buildings inside it.",
        "parameters": {
            "type": "object",
            "properties": {"cell_id": {"type": "string", "description": "grid cell identifier"}},
            "required": ["cell_id"],
        },
    },
    "height_profile": {
        "function": height_profile,
        "description": "Report the height completion strategy, blocked-CV accuracy and the model-vs-rule decision.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "list_tall_buildings": {
        "function": list_tall_buildings,
        "description": "Find the tallest footprints and their height provenance.",
        "parameters": {
            "type": "object",
            "properties": {
                "min_height": {"type": "number", "default": 12},
                "limit": {"type": "integer", "default": 10, "maximum": 50},
            },
            "required": [],
        },
    },
    "typology_profile": {
        "function": typology_profile,
        "description": "Describe the unsupervised building typology and its exposure signature.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "greening_candidates": {
        "function": greening_candidates,
        "description": "Screen cells where high exposure coincides with low green cover.",
        "parameters": {
            "type": "object",
            "properties": {"top_n": {"type": "integer", "default": 5, "maximum": 20}},
            "required": [],
        },
    },
    "uncertainty_report": {
        "function": uncertainty_report,
        "description": "Report Monte Carlo stability of hotspots and the exposure interval width.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "provenance_check": {
        "function": provenance_check,
        "description": "Re-hash every artefact in the provenance document and report mismatches.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "dataset_card": {
        "function": dataset_card,
        "description": "List stored collections, counts, study area and licence.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}


def call_tool(name: str, arguments: dict[str, Any] | None = None) -> ToolResult:
    """Validate the tool name and arguments, then execute it."""
    if name not in TOOLS:
        raise KeyError(f"unknown tool {name!r}; available: {', '.join(TOOLS)}")
    arguments = arguments or {}
    signature = TOOLS[name]["parameters"]
    allowed = set(signature.get("properties", {}))
    unexpected = set(arguments) - allowed
    if unexpected:
        raise ValueError(f"unexpected argument(s) for {name}: {sorted(unexpected)}")
    for required in signature.get("required", []):
        if required not in arguments:
            raise ValueError(f"{name} requires {required!r}")
    return TOOLS[name]["function"](**arguments)


def tool_schemas() -> list[dict[str, Any]]:
    """MCP-compatible tool descriptors."""
    return [
        {
            "name": name,
            "description": spec["description"],
            "inputSchema": spec["parameters"],
        }
        for name, spec in TOOLS.items()
    ]
