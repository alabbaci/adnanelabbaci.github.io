"""Spatial feature store: SQLite + R*Tree, with a PostGIS deployment path.

The default store is dependency-free (``sqlite3`` from the standard library) and
still uses a real spatial index: SQLite's R*Tree module backs bbox queries, the
same access pattern an OGC API Features implementation needs. For platform
deployments, ``deploy/postgis/init.sql`` provides the equivalent PostGIS schema.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import geopandas as gpd

from .config import CRS_GEOGRAPHIC

SCHEMA = """
CREATE TABLE features (
    rid      INTEGER PRIMARY KEY,
    fid      TEXT UNIQUE NOT NULL,
    collection TEXT NOT NULL,
    props    TEXT NOT NULL,
    geom     TEXT NOT NULL,
    minx REAL, miny REAL, maxx REAL, maxy REAL,
    minz REAL, maxz REAL
);
CREATE VIRTUAL TABLE features_rtree USING rtree(rid, minx, maxx, miny, maxy);
CREATE TABLE collections (
    name TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    crs TEXT,
    count INTEGER,
    updated TEXT
);
CREATE INDEX idx_features_collection ON features(collection);
"""


@dataclass
class Feature:
    fid: str
    collection: str
    properties: dict[str, Any]
    geometry: dict[str, Any]
    bbox: tuple[float, float, float, float]

    def as_geojson(self) -> dict[str, Any]:
        return {
            "type": "Feature",
            "id": self.fid,
            "geometry": self.geometry,
            "properties": self.properties,
        }


class FeatureStore:
    """A small, portable spatial store used by the API, the agent tools and tests."""

    def __init__(self, path: Path | str, connection: sqlite3.Connection) -> None:
        self.path = Path(path)
        self._conn = connection

    # -- lifecycle ---------------------------------------------------------
    @classmethod
    def create(cls, path: Path | str, *, overwrite: bool = True) -> FeatureStore:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if overwrite and path.exists():
            path.unlink()
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        connection.executescript(SCHEMA)
        connection.commit()
        return cls(path, connection)

    @classmethod
    def open(cls, path: Path | str) -> FeatureStore:
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        return cls(path, connection)

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> FeatureStore:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- writing -----------------------------------------------------------
    def add_collection(
        self,
        name: str,
        frame: gpd.GeoDataFrame,
        *,
        title: str,
        description: str,
        id_column: str | None = None,
        extra_properties: Iterable[str] | None = None,
    ) -> int:
        """Insert a GeoDataFrame as a collection; returns the feature count."""
        if frame.crs is None:
            raise ValueError("frame must define a CRS")
        frame = frame.to_crs(CRS_GEOGRAPHIC).reset_index(drop=True)
        extra = set(extra_properties or ())
        attributes = frame.drop(columns="geometry").to_dict("records")
        geometries = frame.geometry.tolist()
        rows = []
        for position, (props, geometry) in enumerate(zip(attributes, geometries, strict=True)):
            fid = (
                str(props[id_column]) if id_column and id_column in props else f"{name}.{position}"
            )
            properties = {
                key: _jsonable(value)
                for key, value in props.items()
                if key in extra or key == id_column
            }
            properties.setdefault("collection", name)
            bounds = geometry.bounds
            rows.append(
                (
                    fid,
                    name,
                    json.dumps(properties, ensure_ascii=False),
                    json.dumps(geometry.__geo_interface__),
                    bounds[0],
                    bounds[1],
                    bounds[2],
                    bounds[3],
                )
            )
        self._conn.executemany(
            "INSERT OR REPLACE INTO features (fid, collection, props, geom, minx, miny, maxx, maxy) "
            "VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )
        self._conn.execute(
            "INSERT OR REPLACE INTO features_rtree (rid, minx, maxx, miny, maxy) "
            "SELECT rid, minx, maxx, miny, maxy FROM features WHERE collection = ?",
            (name,),
        )
        self._conn.execute(
            "INSERT OR REPLACE INTO collections (name, title, description, crs, count) VALUES (?,?,?,?,?)",
            (name, title, description, CRS_GEOGRAPHIC, len(rows)),
        )
        self._conn.commit()
        return len(rows)

    # -- reading -----------------------------------------------------------
    def collections(self) -> list[dict[str, Any]]:
        cursor = self._conn.execute("SELECT * FROM collections ORDER BY name")
        return [dict(row) for row in cursor.fetchall()]

    def count(self, collection: str) -> int:
        cursor = self._conn.execute(
            "SELECT COUNT(*) AS n FROM features WHERE collection = ?", (collection,)
        )
        return int(cursor.fetchone()["n"])

    def bbox(
        self,
        collection: str,
        bbox: tuple[float, float, float, float] | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Feature]:
        """Query features, optionally filtered by an R*Tree-indexed bbox."""
        if bbox is None:
            cursor = self._conn.execute(
                "SELECT * FROM features WHERE collection = ? ORDER BY rid LIMIT ? OFFSET ?",
                (collection, limit, offset),
            )
        else:
            cursor = self._conn.execute(
                """
                SELECT f.* FROM features f
                JOIN features_rtree r ON r.rid = f.rid
                WHERE f.collection = ?
                  AND r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?
                ORDER BY f.rid LIMIT ? OFFSET ?
                """,
                (collection, bbox[0], bbox[2], bbox[1], bbox[3], limit, offset),
            )
        return [self._to_feature(row) for row in cursor.fetchall()]

    def extent(self, collection: str) -> tuple[float, float, float, float] | None:
        """Bounding box of the collection in WGS84, or ``None`` when empty."""
        cursor = self._conn.execute(
            "SELECT MIN(minx), MIN(miny), MAX(maxx), MAX(maxy) FROM features WHERE collection = ?",
            (collection,),
        )
        row = cursor.fetchone()
        if row is None or row[0] is None:
            return None
        return (float(row[0]), float(row[1]), float(row[2]), float(row[3]))

    def get(self, collection: str, fid: str) -> Feature | None:
        cursor = self._conn.execute(
            "SELECT * FROM features WHERE collection = ? AND fid = ?", (collection, fid)
        )
        row = cursor.fetchone()
        return self._to_feature(row) if row else None

    def aggregate(self, collection: str, field: str, op: str = "mean") -> float | None:
        """Aggregate a numeric property in SQL-free Python (portable and honest)."""
        features = self.bbox(collection, limit=10_000)
        values = [f.properties.get(field) for f in features]
        numbers = [float(v) for v in values if isinstance(v, (int, float)) and v == v]
        if not numbers:
            return None
        if op == "mean":
            return sum(numbers) / len(numbers)
        if op == "max":
            return max(numbers)
        if op == "min":
            return min(numbers)
        if op == "sum":
            return sum(numbers)
        raise ValueError(f"unsupported op {op!r}")

    def _to_feature(self, row: sqlite3.Row) -> Feature:
        return Feature(
            fid=row["fid"],
            collection=row["collection"],
            properties=json.loads(row["props"]),
            geometry=json.loads(row["geom"]),
            bbox=(row["minx"], row["miny"], row["maxx"], row["maxy"]),
        )


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, bool, int, float)):
        return value if not (isinstance(value, float) and value != value) else None
    if hasattr(value, "item"):
        value = value.item()
        return None if isinstance(value, float) and value != value else value
    return str(value)
