"""Overture Maps ingestion: fetch, parse and normalise vector layers.

The importer reads the Overture Maps GeoParquet release on S3 (anonymous access,
bbox-filtered), so no Overpass server or OSM API quota is involved. Overture
conflates OpenStreetMap footprints with Microsoft ML Buildings, which matters in
Dakhla: hand-mapped OSM coverage is thin, and two thirds of the footprints here
exist only as ML detections. Outputs are GeoJSON in WGS84, which is what a
downstream OGC API or STAC catalogue expects.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd
import shapely
from shapely.geometry import box

from ..config import AOI, CRS_GEOGRAPHIC, OVERTURE_RELEASE, RAW_DIR, STOREY_HEIGHT_M

S3_BUCKET = "overturemaps-us-west-2"

#: (theme, type) of every Overture collection the twin reads, and the columns kept.
SOURCES: dict[str, tuple[str, str, list[str]]] = {
    "building": (
        "buildings",
        "building",
        ["id", "geometry", "height", "num_floors", "class", "subtype", "names", "sources"],
    ),
    "segment": ("transportation", "segment", ["id", "geometry", "class", "subtype", "names"]),
    "land_use": ("base", "land_use", ["id", "geometry", "class", "subtype", "names"]),
    "land": ("base", "land", ["id", "geometry", "class", "subtype", "names"]),
}

#: Vegetated classes. Sports pitches and recreation grounds are deliberately left
#: out: in Dakhla they are bare sand or artificial turf and give no shade.
GREEN_LAND_USE = {
    "park",
    "garden",
    "grass",
    "meadow",
    "orchard",
    "playground",
    "village_green",
    "flowerbed",
    "forest",
    "plant_nursery",
}
GREEN_LAND = {"wood", "forest", "scrub", "grass", "grassland", "heath", "tree_row"}
STREET_CLASSES = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "pedestrian",
    "service",
    "footway",
    "cycleway",
    "path",
    "track",
}


@dataclass
class Layers:
    buildings: gpd.GeoDataFrame
    green: gpd.GeoDataFrame
    trees: gpd.GeoDataFrame
    streets: gpd.GeoDataFrame
    metadata: dict[str, Any] = field(default_factory=dict)


def raw_paths(aoi: AOI, raw_dir: Path | None = None) -> dict[str, Path]:
    base = Path(raw_dir) if raw_dir else RAW_DIR
    paths = {name: base / f"overture_{aoi.slug}_{name}.parquet" for name in SOURCES}
    paths["manifest"] = base / f"overture_{aoi.slug}_manifest.json"
    return paths


def fetch_overture(
    aoi: AOI,
    raw_dir: Path | None = None,
    *,
    release: str = OVERTURE_RELEASE,
    refresh: bool = False,
) -> dict[str, Path]:
    """Download the Overture extract for ``aoi``; cached unless absent or ``refresh``.

    One GeoParquet file per collection is written under ``data/raw`` together with
    a manifest naming the release, so every later step runs offline.
    """
    paths = raw_paths(aoi, raw_dir)
    cached = all(path.exists() and path.stat().st_size > 0 for path in paths.values())
    if cached and not refresh:
        manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
        if manifest.get("release") == release and manifest.get("bbox_wgs84") == list(aoi.bbox):
            return paths

    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import pyarrow.parquet as pq
    import s3fs

    paths["manifest"].parent.mkdir(parents=True, exist_ok=True)
    xmin, ymin, xmax, ymax = aoi.bbox
    bbox_filter = (
        (pc.field("bbox", "xmin") < xmax)
        & (pc.field("bbox", "xmax") > xmin)
        & (pc.field("bbox", "ymin") < ymax)
        & (pc.field("bbox", "ymax") > ymin)
    )
    filesystem = s3fs.S3FileSystem(anon=True)
    rows: dict[str, int] = {}
    try:
        for name, (theme, type_, columns) in SOURCES.items():
            dataset = ds.dataset(
                f"{S3_BUCKET}/release/{release}/theme={theme}/type={type_}/",
                filesystem=filesystem,
                format="parquet",
            )
            table = dataset.to_table(filter=bbox_filter, columns=columns)
            pq.write_table(table, paths[name])
            rows[name] = table.num_rows
    except Exception as exc:
        raise RuntimeError(
            f"could not fetch Overture release {release} for {aoi.name}: {exc}"
        ) from exc
    paths["manifest"].write_text(
        json.dumps(
            {
                "release": release,
                "bbox_wgs84": list(aoi.bbox),
                "source": f"s3://{S3_BUCKET}/release/{release}/",
                "rows": rows,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return paths


def _parse_height(height: Any, floors: Any) -> tuple[float, str]:
    """Return (height_m, source) following the documented attribute priority."""
    if height is not None and pd.notna(height) and 0 < float(height) < 300:
        return float(height), "height_tag"
    if floors is not None and pd.notna(floors) and 0 < float(floors) < 60:
        return float(floors) * STOREY_HEIGHT_M, "levels"
    return float("nan"), "missing"


def _primary_name(names: Any) -> str | None:
    if isinstance(names, dict):
        return names.get("primary")
    return None


def _footprint_source(sources: Any) -> str:
    """Dataset that contributed the geometry (first entry of Overture ``sources``)."""
    if sources is None or len(sources) == 0:
        return "unknown"
    return str(sources[0].get("dataset") or "unknown")


def _read(path: Path, aoi: AOI) -> gpd.GeoDataFrame:
    """Read one cached collection; keep features whose representative point is in the AOI."""
    frame = pd.read_parquet(path).rename(columns={"class": "cls"})
    geometry = shapely.from_wkb(frame.pop("geometry"))
    gdf = gpd.GeoDataFrame(frame, geometry=geometry, crs=CRS_GEOGRAPHIC)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    inside = gdf.geometry.representative_point().within(box(*aoi.bbox))
    return gdf[inside].reset_index(drop=True)


def _largest_polygon(geometry):
    """Reduce any areal geometry to a single valid Polygon (or ``None``)."""
    if geometry is None or geometry.is_empty:
        return None
    if not geometry.is_valid:
        geometry = geometry.buffer(0)
    if geometry.geom_type == "MultiPolygon":
        geometry = max(geometry.geoms, key=lambda part: part.area)
    if geometry.geom_type != "Polygon" or geometry.is_empty:
        return None
    return geometry


def _frame(rows: list[dict[str, Any]]) -> gpd.GeoDataFrame:
    if not rows:
        return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs=CRS_GEOGRAPHIC)
    frame = gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_GEOGRAPHIC)
    return frame[frame.geometry.notna() & ~frame.geometry.is_empty].reset_index(drop=True)


def parse_overture(paths: dict[str, Path], aoi: AOI) -> Layers:
    """Parse the cached Overture extract into normalised GeoDataFrames."""
    manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))

    building_rows: list[dict[str, Any]] = []
    for row in _read(paths["building"], aoi).itertuples(index=False):
        polygon = _largest_polygon(row.geometry)
        if polygon is None or polygon.area <= 0:
            continue
        height, height_source = _parse_height(row.height, row.num_floors)
        building_type = row.cls or row.subtype or "yes"
        building_rows.append(
            {
                "gers_id": str(row.id),
                "building_type": str(building_type),
                "height_m": height,
                "height_source": height_source,
                "levels": None if pd.isna(row.num_floors) else float(row.num_floors),
                "name": _primary_name(row.names),
                "footprint_source": _footprint_source(row.sources),
                "geometry": polygon,
            }
        )

    green_rows: list[dict[str, Any]] = []
    tree_rows: list[dict[str, Any]] = []
    for layer, classes in (("land_use", GREEN_LAND_USE), ("land", GREEN_LAND)):
        for row in _read(paths[layer], aoi).itertuples(index=False):
            cls = row.cls
            if cls == "tree" and row.geometry.geom_type == "Point":
                tree_rows.append(
                    {
                        "gers_id": str(row.id),
                        "name": _primary_name(row.names),
                        "geometry": row.geometry,
                    }
                )
                continue
            if cls not in classes:
                continue
            polygon = _largest_polygon(row.geometry)
            if polygon is None or polygon.area <= 0:
                continue
            green_rows.append(
                {
                    "gers_id": str(row.id),
                    "green_type": str(cls),
                    "name": _primary_name(row.names),
                    "geometry": polygon,
                }
            )

    street_rows: list[dict[str, Any]] = []
    for row in _read(paths["segment"], aoi).itertuples(index=False):
        cls = row.cls
        if row.subtype != "road" or cls not in STREET_CLASSES:
            continue
        parts = (
            row.geometry.geoms if row.geometry.geom_type == "MultiLineString" else [row.geometry]
        )
        for part in parts:
            if part.geom_type == "LineString" and len(part.coords) >= 2:
                street_rows.append(
                    {
                        "gers_id": str(row.id),
                        "highway": str(cls),
                        "name": _primary_name(row.names),
                        "geometry": part,
                    }
                )

    buildings = _frame(building_rows)
    green = _frame(green_rows)
    trees = _frame(tree_rows)
    streets = _frame(street_rows)

    by_source = buildings["footprint_source"].value_counts().to_dict() if len(buildings) else {}
    metadata = {
        "aoi": aoi.name,
        "aoi_slug": aoi.slug,
        "bbox_wgs84": list(aoi.bbox),
        "source": manifest["source"],
        "release": manifest["release"],
        "source_name": "Overture Maps Foundation (OpenStreetMap + Microsoft ML Buildings)",
        "license": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors, Microsoft, Overture Maps Foundation",
        "counts": {
            "buildings": len(buildings),
            "buildings_with_height": int((buildings["height_source"] != "missing").sum())
            if len(buildings)
            else 0,
            "buildings_by_source": {str(k): int(v) for k, v in by_source.items()},
            "green_polygons": len(green),
            "trees": len(trees),
            "streets": len(streets),
        },
    }
    return Layers(buildings=buildings, green=green, trees=trees, streets=streets, metadata=metadata)


def write_layers(layers: Layers, out_dir: Path) -> dict[str, Path]:
    """Write the normalised layers plus a metadata sidecar, return the paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for name in ("buildings", "green", "trees", "streets"):
        frame: gpd.GeoDataFrame = getattr(layers, name)
        target = out_dir / f"{name}.geojson"
        frame.to_file(target, driver="GeoJSON")
        paths[name] = target
    meta_path = out_dir / "layers_metadata.json"
    meta_path.write_text(json.dumps(layers.metadata, indent=2), encoding="utf-8")
    paths["metadata"] = meta_path
    return paths


def read_layers(out_dir: Path) -> Layers:
    """Read normalised layers written by :func:`write_layers`."""
    readers = {
        name: gpd.read_file(out_dir / f"{name}.geojson")
        for name in ("buildings", "green", "trees", "streets")
    }
    metadata = json.loads((out_dir / "layers_metadata.json").read_text(encoding="utf-8"))
    buildings = readers["buildings"]
    if "height_m" in buildings:
        buildings["height_m"] = pd.to_numeric(buildings["height_m"], errors="coerce")
    return Layers(
        buildings=buildings,
        green=readers["green"],
        trees=readers["trees"],
        streets=readers["streets"],
        metadata=metadata,
    )
