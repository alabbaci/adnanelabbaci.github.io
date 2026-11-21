"""Build the offline viewer: one self-contained HTML file, no CDN, no build step.

The viewer is deliberately dependency-free so that a reviewer can open the file
from a USB stick, and so the same artefact can be attached to a proposal. It reads
a compact JSON payload produced here (local metric coordinates, one decimal).
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np

from ..config import CRS_METRIC, REPO_ROOT, WEB_DIR


def _ring(geometry, origin: tuple[float, float], digits: int = 1) -> list[list[float]]:
    coords = list(geometry.exterior.coords)
    return [[round(x - origin[0], digits), round(y - origin[1], digits)] for x, y in coords]


def _jsonable(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        value = float(value)
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return None
    return value


def build_viewer(
    buildings: gpd.GeoDataFrame,
    cells: gpd.GeoDataFrame,
    green: gpd.GeoDataFrame | None,
    streets: gpd.GeoDataFrame | None,
    *,
    out_path: Path | None = None,
    meta: dict[str, Any] | None = None,
    simplify_m: float = 0.25,
) -> Path:
    """Assemble the viewer (``index.html``) with the twin's current state embedded."""
    frame = buildings.to_crs(CRS_METRIC)
    bounds = frame.total_bounds
    origin = (float(bounds[0]), float(bounds[1]))
    typologies = (
        frame.drop_duplicates("typology").sort_values("typology")[["typology", "typology_name"]]
        if "typology" in frame.columns
        else None
    )

    cells_frame = cells.reset_index(drop=True)
    cell_ids = [str(value) for value in cells_frame["cell_id"].tolist()]
    cell_index = {cell_id: position for position, cell_id in enumerate(cell_ids)}

    records = []
    for row in frame.itertuples(index=False):
        geometry = row.geometry
        if geometry is None or geometry.is_empty:
            continue
        simplified = geometry.simplify(simplify_m, preserve_topology=True)
        if simplified.geom_type != "Polygon" or len(simplified.exterior.coords) < 4:
            simplified = geometry
        height = float(getattr(row, "height_final_m", 0.0) or 0.0)
        hei = getattr(row, "cell_hei", None)
        typology = getattr(row, "typology", None)
        typology_index = 0
        if typologies is not None and typology is not None:
            matches = np.where(typologies["typology"].to_numpy() == typology)[0]
            typology_index = int(matches[0]) if len(matches) else 0
        provenance = str(getattr(row, "height_provenance", "unknown"))
        records.append(
            {
                "id": str(getattr(row, "gers_id", "")),
                "k": str(getattr(row, "building_class", "")),
                "h": round(height, 1),
                "hei": _jsonable(hei),
                "t": typology_index,
                "tn": str(getattr(row, "typology_name", "")),
                "p": provenance.split(":")[0] if ":" in provenance else provenance,
                "s": str(getattr(row, "footprint_source", "") or ""),
                "r": _ring(simplified, origin),
                "bbox": [
                    round(geometry.bounds[0] - origin[0], 1),
                    round(geometry.bounds[1] - origin[1], 1),
                    round(geometry.bounds[2] - origin[0], 1),
                    round(geometry.bounds[3] - origin[1], 1),
                ],
                "cx": round(geometry.centroid.x - origin[0], 1),
                "cy": round(geometry.centroid.y - origin[1], 1),
                "cid": str(getattr(row, "cell_id", "")),
                "ci": cell_index.get(str(getattr(row, "cell_id", "")), -1),
            }
        )

    cell_records = []
    for position, row in enumerate(cells_frame.itertuples(index=False)):
        if row.geometry is None or row.geometry.is_empty:
            continue
        cell_records.append(
            {
                "id": str(row.cell_id),
                "r": _ring(row.geometry, origin),
                "hei": _jsonable(float(row.hei)),
                "hp": _jsonable(getattr(row, "hotspot_probability", None)),
                "i": position,
            }
        )

    green_rings = []
    if green is not None and len(green):
        for geometry in green.to_crs(CRS_METRIC).geometry:
            if geometry is None or geometry.is_empty:
                continue
            simplified = geometry.simplify(1.0, preserve_topology=True)
            if simplified.geom_type != "Polygon":
                continue
            green_rings.append(_ring(simplified, origin))

    street_lines = []
    if streets is not None and len(streets):
        for geometry in streets.to_crs(CRS_METRIC).geometry:
            if geometry is None or geometry.is_empty or geometry.geom_type != "LineString":
                continue
            street_lines.append(
                [[round(x - origin[0], 1), round(y - origin[1], 1)] for x, y in geometry.coords]
            )

    height_values = frame["height_final_m"].dropna().to_numpy(dtype=float)
    hei_values = (
        frame["cell_hei"].dropna().to_numpy(dtype=float)
        if "cell_hei" in frame
        else np.array([0, 100])
    )

    payload = {
        "bounds": [
            round(bounds[0] - origin[0], 1),
            round(bounds[1] - origin[1], 1),
            round(bounds[2] - origin[0], 1),
            round(bounds[3] - origin[1], 1),
        ],
        "buildings": records,
        "cells": cell_records,
        "green": green_rings,
        "streets": street_lines,
        "meta": {
            "buildings": len(records),
            "cells": len(cell_records),
            "generated": date.today().isoformat(),
            "height_range": [
                0.0,
                round(float(height_values.max()), 1) if len(height_values) else 12.0,
            ],
            "origin": [round(float(origin[0]), 1), round(float(origin[1]), 1)],
            "crs_metric": str(CRS_METRIC),
            "labelled": (
                int(frame["has_height_label"].sum())
                if "has_height_label" in frame.columns
                else len(records)
            ),
            "label_coverage": (
                round(100.0 * float(frame["has_height_label"].mean()), 1)
                if "has_height_label" in frame.columns
                else 100.0
            ),
            "interval": (
                round(float(frame["height_uncertainty_m"].median()), 1)
                if "height_uncertainty_m" in frame.columns
                else 0.0
            ),
            "hei_range": [
                float(np.floor(hei_values.min())) if len(hei_values) else 0.0,
                float(np.ceil(hei_values.max())) if len(hei_values) else 100.0,
            ],
            "typologies": (
                [str(row.typology_name) for row in typologies.itertuples(index=False)]
                if typologies is not None
                else []
            ),
            **(meta or {}),
        },
    }

    template_path = REPO_ROOT / "web" / "template.html"
    template = template_path.read_text(encoding="utf-8")
    target = Path(out_path) if out_path else (WEB_DIR / "index.html")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        template.replace(
            "__DATA__", json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        ),
        encoding="utf-8",
    )
    return target
