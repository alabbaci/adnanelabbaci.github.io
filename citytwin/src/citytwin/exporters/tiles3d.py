"""3D Tiles 1.1 export: glTF (GLB) content in ECEF plus a tileset.json.

3D Tiles 1.1 allows glTF content directly, so no b3dm container is needed. We
build one tile with per-vertex colour and a ``_BATCHID`` attribute, and a
``region`` bounding volume in radians. Positions are converted to EPSG:4978
(geocentric) because that is the coordinate frame 3D Tiles renderers expect.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
from pyproj import Transformer
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon

from ..config import CRS_ECEF, CRS_GEOGRAPHIC

#: Colour ramp (blue -> yellow -> red), used for heights and exposure alike.
RAMP = (
    (0.17, 0.48, 0.71),
    (0.55, 0.75, 0.53),
    (1.00, 0.89, 0.44),
    (0.84, 0.31, 0.26),
)


def _ramp(values: np.ndarray, vmin: float, vmax: float) -> np.ndarray:
    if vmax <= vmin:
        vmax = vmin + 1.0
    t = np.clip((np.asarray(values, dtype=float) - vmin) / (vmax - vmin), 0, 1) * (len(RAMP) - 1)
    low = np.floor(t).astype(int).clip(0, len(RAMP) - 2)
    high = low + 1
    weight = (t - low)[:, None]
    colors = np.array(RAMP)[low] * (1 - weight) + np.array(RAMP)[high] * weight
    return (np.clip(colors, 0, 1) * 255).astype(np.uint8)


def _triangulate(polygon: Polygon) -> list[list[tuple[float, float]]]:
    """Constrained triangulation of a footprint (handles concave shapes)."""
    triangles = constrained_delaunay_triangles(polygon)
    result = []
    for triangle in triangles.geoms:
        coords = list(triangle.exterior.coords)[:3]
        result.append([(float(x), float(y)) for x, y in coords])
    return result


def _glb_bytes(positions: np.ndarray, colors: np.ndarray, batch_ids: np.ndarray) -> bytes:
    """Assemble a minimal, spec-compliant binary glTF 2.0 container."""
    position_view = positions.astype("<f4").tobytes()
    color_view = colors.astype("<u1").tobytes()
    batch_view = batch_ids.astype("<u2").tobytes()

    def pad(data: bytes) -> bytes:
        return data + b"\x00" * ((4 - len(data) % 4) % 4)

    position_view, color_view, batch_view = map(pad, (position_view, color_view, batch_view))
    offsets = np.cumsum([0, len(position_view), len(color_view)])
    blob = position_view + color_view + batch_view

    n_vertices = len(positions)
    accessors = [
        {
            "bufferView": 0,
            "componentType": 5126,
            "count": n_vertices,
            "type": "VEC3",
            "min": [float(positions[:, i].min()) for i in range(3)],
            "max": [float(positions[:, i].max()) for i in range(3)],
        },
        {
            "bufferView": 1,
            "componentType": 5121,
            "count": n_vertices,
            "type": "VEC4",
            "normalized": True,
        },
        {
            "bufferView": 2,
            "componentType": 5123,
            "count": n_vertices,
            "type": "SCALAR",
        },
    ]
    document: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "citytwin"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "buildings"}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "COLOR_0": 1, "_BATCHID": 2},
                        "mode": 4,
                        "material": 0,
                    }
                ]
            }
        ],
        "materials": [
            {
                "pbrMetallicRoughness": {
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.9,
                },
                "doubleSided": True,
                "name": "citytwin-buildings",
            }
        ],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": int(offsets[0]),
                "byteLength": len(position_view),
                "target": 34962,
            },
            {
                "buffer": 0,
                "byteOffset": int(offsets[1]),
                "byteLength": len(color_view),
                "target": 34962,
            },
            {
                "buffer": 0,
                "byteOffset": int(offsets[2]),
                "byteLength": len(batch_view),
                "target": 34962,
            },
        ],
        "buffers": [{"byteLength": len(blob)}],
        "accessors": accessors,
    }

    json_chunk = json.dumps(document, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    total = 12 + 8 + len(json_chunk) + 8 + len(blob)
    header = struct.pack("<III", 0x46546C67, 2, total)
    chunk_json = struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    chunk_bin = struct.pack("<II", len(blob), 0x004E4942) + blob
    return header + chunk_json + chunk_bin


def buildings_to_3dtiles(
    buildings: gpd.GeoDataFrame,
    out_dir: Path,
    *,
    color_field: str = "height_final_m",
    max_buildings: int | None = None,
) -> dict[str, Any]:
    """Write ``buildings.glb`` and ``tileset.json``; return a summary."""
    frame = buildings.to_crs(CRS_GEOGRAPHIC)
    if max_buildings:
        frame = frame.head(max_buildings)
    transformer = Transformer.from_crs(CRS_GEOGRAPHIC, CRS_ECEF, always_xy=True)

    positions: list[tuple[float, float, float]] = []
    batch_ids: list[int] = []
    heights: list[float] = []
    color_values: list[float] = []
    triangles = 0
    skipped = 0

    for row in frame.itertuples(index=False):
        geometry = row.geometry
        if geometry is None or geometry.is_empty or geometry.geom_type != "Polygon":
            skipped += 1
            continue
        height = float(getattr(row, "height_final_m", 0.0) or 0.0)
        if not np.isfinite(height) or height <= 0:
            skipped += 1
            continue
        roof_triangles = _triangulate(geometry)
        if not roof_triangles:
            skipped += 1
            continue
        batch = len(heights)
        heights.append(height)
        field_value = getattr(row, color_field, None) if color_field in frame.columns else None
        color_values.append(float(field_value) if isinstance(field_value, (int, float)) else height)

        def emit(
            points: list[tuple[float, float]], z: float, order: list[int], _batch: int = batch
        ) -> None:
            for index in order:
                lon, lat = points[index]
                x, y, zz = transformer.transform(lon, lat, z)
                positions.append((x, y, zz))
                batch_ids.append(_batch)

        # roof
        for triangle in roof_triangles:
            emit(triangle, height, [0, 1, 2])
            triangles += 1
        # ground (reverse winding so the normal points down)
        for triangle in roof_triangles:
            emit(triangle, 0.0, [2, 1, 0])
            triangles += 1
        # walls: each edge becomes a quad split into two triangles
        ring = list(geometry.exterior.coords)
        if ring[0] == ring[-1]:
            ring = ring[:-1]
        for i in range(len(ring)):
            a = ring[i]
            b = ring[(i + 1) % len(ring)]
            bottom = [
                transformer.transform(a[0], a[1], 0.0),
                transformer.transform(b[0], b[1], 0.0),
            ]
            top = [
                transformer.transform(a[0], a[1], height),
                transformer.transform(b[0], b[1], height),
            ]
            quad_vertices = [bottom[0], bottom[1], top[1], top[0]]
            for order in ([0, 1, 2], [0, 2, 3]):
                for index in order:
                    positions.append(quad_vertices[index])
                    batch_ids.append(batch)
                triangles += 1

    if not positions:
        raise RuntimeError("no valid footprints to export")

    positions_array = np.asarray(positions, dtype=np.float64)
    batch_array = np.asarray(batch_ids, dtype=np.uint16)
    heights_array = np.asarray(heights, dtype=float)
    values = np.asarray(color_values, dtype=float)

    colors_per_building = _ramp(
        values,
        float(np.min(values)),
        float(np.max(values)) if len(values) > 1 else float(np.min(values)) + 1,
    )
    vertex_colors = np.zeros((len(positions_array), 4), dtype=np.uint8)
    for batch, color in enumerate(colors_per_building):
        vertex_colors[batch_array == batch, :3] = color
    vertex_colors[:, 3] = 255

    out_dir.mkdir(parents=True, exist_ok=True)
    glb_path = out_dir / "buildings.glb"
    glb_path.write_bytes(_glb_bytes(positions_array, vertex_colors, batch_array))

    bounds = frame.total_bounds  # minx, miny, maxx, maxy in degrees
    region = [
        float(np.deg2rad(bounds[0])),
        float(np.deg2rad(bounds[1])),
        float(np.deg2rad(bounds[2])),
        float(np.deg2rad(bounds[3])),
        float(np.nanmin(values)) if np.isfinite(values).any() else 0.0,
        float(np.nanmax(heights_array)) + 2.0,
    ]
    tileset = {
        "asset": {"version": "1.1", "generator": "citytwin"},
        "geometricError": 0.0,
        "root": {
            "boundingVolume": {"region": region},
            "geometricError": 0.0,
            "refine": "ADD",
            "content": {"uri": "buildings.glb"},
        },
    }
    tileset_path = out_dir / "tileset.json"
    tileset_path.write_text(json.dumps(tileset, indent=2), encoding="utf-8")

    return {
        "tileset": str(tileset_path),
        "content": str(glb_path),
        "buildings": len(heights),
        "skipped": int(skipped),
        "triangles": int(triangles),
        "vertices": len(positions_array),
        "bytes": glb_path.stat().st_size,
        "region": region,
    }


def validate_glb(path: Path) -> dict[str, Any]:
    """Parse the GLB container and check the structural invariants."""
    data = Path(path).read_bytes()
    magic, version, length = struct.unpack("<III", data[:12])
    problems: list[str] = []
    if magic != 0x46546C67:
        problems.append("bad magic")
    if version != 2:
        problems.append(f"unexpected glTF version {version}")
    if length != len(data):
        problems.append("declared length does not match file size")

    json_length, json_type = struct.unpack("<II", data[12:20])
    if json_type != 0x4E4F534A:
        problems.append("first chunk is not JSON")
    document = json.loads(data[20 : 20 + json_length])

    bin_offset = 20 + json_length
    bin_length, bin_type = struct.unpack("<II", data[bin_offset : bin_offset + 8])
    if bin_type != 0x004E4942:
        problems.append("second chunk is not BIN")

    accessors = document.get("accessors", [])
    buffer_length = document["buffers"][0]["byteLength"]
    if sum(view["byteLength"] for view in document["bufferViews"]) > bin_length:
        problems.append("bufferViews exceed the BIN chunk")
    counts = {accessor["count"] for accessor in accessors}
    if len(counts) != 1:
        problems.append(f"accessors disagree on vertex count: {counts}")

    return {
        "file": str(path),
        "glb_version": version,
        "bytes": len(data),
        "bin_chunk_bytes": bin_length,
        "buffer_bytes": buffer_length,
        "vertices": sorted(counts)[0] if counts else 0,
        "triangles": (sorted(counts)[0] // 3) if counts else 0,
        "ok": not problems,
        "problems": problems,
    }
