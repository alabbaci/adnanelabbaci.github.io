"""CityJSON 1.1 export: LoD1 solids with attributes and a closed-shell self-check.

CityJSON is the interoperable exchange format for 3D city models in Europe; a
digital twin platform must be able to emit it from the same feature store that
serves 2D queries. Each building becomes a ``Solid`` with a ground, wall and roof
surface, keeping height provenance and uncertainty as attributes so a downstream
consumer knows which geometries are observed and which are inferred.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np

CITYJSON_CRS = "https://www.opengis.net/def/crs/EPSG/0/4326"


def _ring(coords: list[tuple[float, float]], z: float) -> list[list[float]]:
    """Drop the repeated closing vertex; CityJSON rings are implicit."""
    if coords[0] == coords[-1]:
        coords = coords[:-1]
    return [[round(x, 6), round(y, 6), round(z, 3)] for x, y in coords]


def buildings_to_cityjson(
    buildings: gpd.GeoDataFrame,
    out_path: Path,
    *,
    aoi_name: str,
    attributes: tuple[str, ...] = (
        "gers_id",
        "building_class",
        "area_m2",
        "height_final_m",
        "height_provenance",
        "height_uncertainty_m",
        "cell_hei",
        "typology",
    ),
    simplify_tolerance: float = 0.0,
) -> Path:
    """Write a CityJSON 1.1 file with one LoD1 Solid per building."""
    frame = buildings.to_crs("EPSG:4326")
    vertices: list[list[float]] = []
    index: dict[tuple[float, float, float], int] = {}

    def vertex(x: float, y: float, z: float) -> int:
        key = (round(x, 6), round(y, 6), round(z, 3))
        if key not in index:
            index[key] = len(vertices)
            vertices.append([key[0], key[1], key[2]])
        return index[key]

    city_objects: dict[str, Any] = {}
    count = 0
    for row in frame.itertuples(index=False):
        geometry = row.geometry
        if geometry is None or geometry.is_empty or geometry.geom_type != "Polygon":
            continue
        coords = list(geometry.exterior.coords)
        if simplify_tolerance > 0:
            simplified = geometry.simplify(simplify_tolerance, preserve_topology=True)
            if simplified.geom_type == "Polygon" and len(simplified.exterior.coords) >= 4:
                coords = list(simplified.exterior.coords)
        height = float(getattr(row, "height_final_m", 0.0) or 0.0)
        if not np.isfinite(height) or height <= 0:
            continue
        height = max(height, 2.0)

        base = _ring(coords, 0.0)
        top = _ring(coords, height)
        if len(base) < 3:
            continue
        n = len(base)
        base_ids = [vertex(*point) for point in base]
        top_ids = [vertex(*point) for point in top]

        ground = [list(reversed(base_ids))]
        roof = [list(top_ids)]
        walls = [
            [[base_ids[i], base_ids[(i + 1) % n], top_ids[(i + 1) % n], top_ids[i]]]
            for i in range(n)
        ]

        boundaries = [[ground + walls + roof]]
        surface_types = (
            [{"type": "GroundSurface"}]
            + [{"type": "WallSurface"} for _ in range(n)]
            + [{"type": "RoofSurface"}]
        )
        values = [[0] + [1] * n + [len(surface_types) - 1]]

        fid = f"bldg-{count + 1}"
        building_attributes: dict[str, Any] = {}
        for name in attributes:
            if not hasattr(row, name):
                continue
            value = getattr(row, name)
            if isinstance(value, (np.integer,)):
                value = int(value)
            elif isinstance(value, (np.floating,)):
                value = float(value)
            elif value != value:  # NaN
                value = None
            building_attributes[name] = value
        building_attributes["storeys_estimated"] = round(height / 3.0, 1)

        city_objects[fid] = {
            "type": "Building",
            "attributes": building_attributes,
            "geometry": [
                {
                    "type": "Solid",
                    "lod": "1.0",
                    "boundaries": boundaries,
                    "semantics": {"surfaces": surface_types, "values": values},
                }
            ],
        }
        count += 1

    document = {
        "type": "CityJSON",
        "version": "1.1",
        "metadata": {
            "title": f"citytwin LoD1 model — {aoi_name}",
            "referenceSystem": CITYJSON_CRS,
            "identifier": "citytwin",
        },
        "transform": {"scale": [1.0, 1.0, 1.0], "translate": [0.0, 0.0, 0.0]},
        "CityObjects": city_objects,
        "vertices": vertices,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    return out_path


def _collect_rings(node: Any) -> list[list[int]]:
    """Walk a CityJSON boundary node down to its rings of vertex indices."""
    if isinstance(node, list) and node and all(isinstance(v, int) for v in node):
        return [node]
    rings: list[list[int]] = []
    if isinstance(node, list):
        for child in node:
            rings.extend(_collect_rings(child))
    return rings


def validate_cityjson(path: Path) -> dict[str, Any]:
    """Structural self-check: closed shells, index integrity, sane heights.

    This is not a replacement for the official cjval validator; it catches the
    failure modes that actually break downstream consumers (open shells, dangling
    indices, degenerate rings).
    """
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    vertices = document.get("vertices", [])
    problems: list[str] = []
    checked = 0
    open_shells = 0

    for object_id, city_object in document.get("CityObjects", {}).items():
        for geometry in city_object.get("geometry", []):
            if geometry.get("type") != "Solid":
                continue
            checked += 1
            for shell in geometry["boundaries"]:
                edges: dict[frozenset[int], int] = {}
                rings = _collect_rings(shell)
                if not rings:
                    problems.append(f"{object_id}: solid without rings")
                    open_shells += 1
                    continue
                for ring in rings:
                    if len(ring) < 3:
                        problems.append(f"{object_id}: ring with fewer than 3 vertices")
                    for index in ring:
                        if not isinstance(index, int) or index < 0 or index >= len(vertices):
                            problems.append(f"{object_id}: vertex index {index!r} out of range")
                    for position in range(len(ring)):
                        a, b = ring[position], ring[(position + 1) % len(ring)]
                        if a == b:
                            continue
                        edges[frozenset((a, b))] = edges.get(frozenset((a, b)), 0) + 1
                # a closed shell uses every edge exactly twice, no more, no less
                if not edges or any(count != 2 for count in edges.values()):
                    open_shells += 1
                    problems.append(f"{object_id}: shell is not closed")

    heights = [
        obj["attributes"].get("height_final_m") for obj in document.get("CityObjects", {}).values()
    ]
    valid_heights = [h for h in heights if isinstance(h, (int, float))]
    return {
        "file": str(path),
        "buildings": len(document.get("CityObjects", {})),
        "vertices": len(vertices),
        "solids_checked": checked,
        "open_shells": open_shells,
        "height_min": round(min(valid_heights), 2) if valid_heights else None,
        "height_max": round(max(valid_heights), 2) if valid_heights else None,
        "ok": not problems,
        "problems": problems[:20],
    }
