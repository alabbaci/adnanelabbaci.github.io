"""OGC API - Features service over the citytwin feature store.

Implements the Core conformance class (landing page, conformance, collections,
items, single feature) plus the bbox and CRS query parameters. Property
filtering is offered as a documented extension, not as OGC API - Features Part 3.

The point of this module is to show that the twin is published through
standards-based interfaces rather than as a private file format: the same
collections can be swapped onto a PostGIS backend without changing the API.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable
from datetime import UTC
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..config import BUILD_DIR, CRS_GEOGRAPHIC
from ..store import Feature, FeatureStore

DEFAULT_STORE = Path(os.environ.get("CITYTWIN_STORE", BUILD_DIR / "store" / "citytwin.sqlite"))
PROVENANCE_PATH = BUILD_DIR / "provenance.json"

CONFORMANCE = [
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
    "http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs",
    "http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/queryables",
]


def _parse_bbox(raw: str | None) -> tuple[float, float, float, float] | None:
    if raw is None:
        return None
    parts = [float(v) for v in raw.split(",")]
    if len(parts) not in (4, 6):
        raise HTTPException(status_code=400, detail="bbox must have 4 or 6 numbers")
    if len(parts) == 6:
        return (parts[0], parts[1], parts[3], parts[4])
    return (parts[0], parts[1], parts[2], parts[3])


def _property_filter(params: Iterable[tuple[str, str]]) -> dict[str, str]:
    reserved = {"bbox", "limit", "offset", "f", "datetime", "crs", "properties"}
    return {key: value for key, value in params if key not in reserved}


def _feature_json(feature: Feature) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": feature.fid,
        "geometry": feature.geometry,
        "properties": feature.properties,
        "bbox": list(feature.bbox),
    }


def create_app(store_path: Path | str | None = None) -> FastAPI:
    path = Path(store_path) if store_path else DEFAULT_STORE

    app = FastAPI(
        title="citytwin — OGC API Features",
        description=(
            "Read-only OGC API - Features access to the Dakhla digital twin: "
            "building footprints with completed heights and the 250 m heat exposure grid. "
            "Data: Overture Maps (© OpenStreetMap contributors, Microsoft), ODbL 1.0."
        ),
        version="0.5.0",
        docs_url="/docs",
        openapi_url="/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    def store() -> FeatureStore:
        if not path.exists():
            raise HTTPException(
                status_code=503,
                detail=(f"feature store not built yet — run `citytwin build` to create {path}"),
            )
        return FeatureStore.open(path)

    def base_url(request: Request) -> str:
        return str(request.base_url).rstrip("/")

    def collection_summary(
        conn: FeatureStore, row: dict[str, Any], request: Request
    ) -> dict[str, Any]:
        extent = conn.extent(row["name"])
        root = base_url(request)
        collection_extent = (
            {
                "spatial": {"bbox": [list(extent)], "crs": CRS_GEOGRAPHIC},
                "temporal": {"interval": [[None, None]]},
            }
            if extent
            else {
                "spatial": {"bbox": [], "crs": CRS_GEOGRAPHIC},
                "temporal": {"interval": [[None, None]]},
            }
        )
        return {
            "id": row["name"],
            "title": row["title"],
            "description": row["description"],
            "itemType": "feature",
            "crs": [CRS_GEOGRAPHIC],
            "storageCrs": CRS_GEOGRAPHIC,
            "extent": collection_extent,
            "links": [
                {
                    "href": f"{root}/collections/{row['name']}",
                    "rel": "self",
                    "type": "application/json",
                    "title": row["title"],
                },
                {
                    "href": f"{root}/collections/{row['name']}/items",
                    "rel": "items",
                    "type": "application/geo+json",
                    "title": "Features",
                },
                {
                    "href": f"{root}/collections/{row['name']}/queryables",
                    "rel": "http://www.opengis.net/def/rel/ogc/1.0/queryables",
                    "type": "application/schema+json",
                    "title": "Queryables",
                },
            ],
        }

    @app.get("/", tags=["OGC API"], summary="Landing page")
    def landing(request: Request) -> JSONResponse:
        root = base_url(request)
        body = {
            "title": "citytwin — Dakhla digital twin",
            "description": (
                "OGC API - Features service for the citytwin digital twin: building footprints "
                "with completed heights, LoD1 geometry and a 250 m heat exposure grid."
            ),
            "links": [
                {
                    "href": f"{root}/",
                    "rel": "self",
                    "type": "application/json",
                    "title": "This document",
                },
                {
                    "href": f"{root}/openapi.json",
                    "rel": "service-desc",
                    "type": "application/vnd.oai.openapi+json;version=3.0",
                    "title": "OpenAPI definition",
                },
                {
                    "href": f"{root}/docs",
                    "rel": "service-doc",
                    "type": "text/html",
                    "title": "Interactive API documentation",
                },
                {
                    "href": f"{root}/conformance",
                    "rel": "conformance",
                    "type": "application/json",
                    "title": "Conformance classes",
                },
                {
                    "href": f"{root}/collections",
                    "rel": "data",
                    "type": "application/json",
                    "title": "Collections",
                },
                {
                    "href": f"{root}/provenance",
                    "rel": "http://www.w3.org/ns/prov#",
                    "type": "application/json",
                    "title": "PROV-JSON provenance of the build",
                },
            ],
            "provider": {
                "name": "citytwin (research prototype)",
                "url": "https://github.com/caoqyqianyi/citytwin",
            },
            "contact": {"name": "Qianyi Cao"},
            "license": {
                "name": "MIT (software) / ODbL 1.0 (data)",
                "url": "https://opendatacommons.org/licenses/odbl/1-0/",
            },
        }
        return JSONResponse(body, media_type="application/json")

    @app.get("/conformance", tags=["OGC API"])
    def conformance() -> dict[str, Any]:
        return {"conformsTo": CONFORMANCE}

    @app.get("/collections", tags=["OGC API"])
    def collections(request: Request) -> JSONResponse:
        with store() as conn:
            rows = conn.collections()
            body = {
                "collections": [collection_summary(conn, row, request) for row in rows],
                "links": [
                    {
                        "href": f"{base_url(request)}/collections",
                        "rel": "self",
                        "type": "application/json",
                        "title": "Collections",
                    },
                    {
                        "href": f"{base_url(request)}/",
                        "rel": "root",
                        "type": "application/json",
                        "title": "Landing page",
                    },
                ],
            }
        return JSONResponse(body)

    @app.get("/collections/{collection_id}", tags=["OGC API"])
    def collection(collection_id: str, request: Request) -> JSONResponse:
        with store() as conn:
            rows = [row for row in conn.collections() if row["name"] == collection_id]
            if not rows:
                raise HTTPException(status_code=404, detail=f"unknown collection {collection_id!r}")
            body = collection_summary(conn, rows[0], request)
        return JSONResponse(body)

    @app.get("/collections/{collection_id}/items", tags=["OGC API"])
    def items(
        collection_id: str,
        request: Request,
        bbox: str | None = Query(None, description="minx,miny,maxx,maxy in WGS84"),
        limit: int = Query(10, ge=1, le=500),
        offset: int = Query(0, ge=0),
        datetime_: str | None = Query(
            None, alias="datetime", description="not populated in this dataset"
        ),
    ) -> JSONResponse:
        query_bbox = _parse_bbox(bbox)
        filters = _property_filter(request.query_params.multi_items())
        with store() as conn:
            names = {row["name"] for row in conn.collections()}
            if collection_id not in names:
                raise HTTPException(status_code=404, detail=f"unknown collection {collection_id!r}")
            candidates = conn.bbox(collection_id, bbox=query_bbox, limit=10_000)
            if filters:
                matched = [
                    feature
                    for feature in candidates
                    if all(
                        str(feature.properties.get(key)) == value for key, value in filters.items()
                    )
                ]
            else:
                matched = candidates
            page = matched[offset : offset + limit]
            root = base_url(request)

            def page_link(new_offset: int) -> str:
                params = [f"limit={limit}", f"offset={new_offset}"]
                if bbox:
                    params.append(f"bbox={bbox}")
                for key, value in filters.items():
                    params.append(f"{key}={value}")
                return f"{root}/collections/{collection_id}/items?" + "&".join(params)

            body = {
                "type": "FeatureCollection",
                "features": [_feature_json(feature) for feature in page],
                "numberMatched": len(matched),
                "numberReturned": len(page),
                "timeStamp": _timestamp(),
                "links": [
                    {
                        "href": str(request.url),
                        "rel": "self",
                        "type": "application/geo+json",
                        "title": "This page",
                    },
                    {
                        "href": f"{root}/collections/{collection_id}",
                        "rel": "collection",
                        "type": "application/json",
                        "title": "Collection",
                    },
                ]
                + (
                    [
                        {
                            "href": page_link(offset + limit),
                            "rel": "next",
                            "type": "application/geo+json",
                            "title": "Next page",
                        }
                    ]
                    if offset + limit < len(matched)
                    else []
                )
                + (
                    [
                        {
                            "href": page_link(max(0, offset - limit)),
                            "rel": "prev",
                            "type": "application/geo+json",
                            "title": "Previous page",
                        }
                    ]
                    if offset > 0
                    else []
                ),
            }
        return JSONResponse(body, media_type="application/geo+json")

    @app.get("/collections/{collection_id}/items/{feature_id}", tags=["OGC API"])
    def feature(collection_id: str, feature_id: str, request: Request) -> JSONResponse:
        with store() as conn:
            item = conn.get(collection_id, feature_id)
            if item is None:
                raise HTTPException(
                    status_code=404, detail=f"feature {feature_id!r} not found in {collection_id!r}"
                )
            body = _feature_json(item)
            body["links"] = [
                {
                    "href": str(request.url),
                    "rel": "self",
                    "type": "application/geo+json",
                    "title": "This feature",
                },
                {
                    "href": f"{base_url(request)}/collections/{collection_id}",
                    "rel": "collection",
                    "type": "application/json",
                    "title": "Collection",
                },
            ]
        return JSONResponse(body, media_type="application/geo+json")

    @app.get("/collections/{collection_id}/queryables", tags=["OGC API"])
    def queryables(collection_id: str, request: Request) -> JSONResponse:
        with store() as conn:
            sample = conn.bbox(collection_id, limit=1)
            if not sample:
                raise HTTPException(status_code=404, detail=f"empty collection {collection_id!r}")
            props = sample[0].properties
            types = {key: _json_type(value) for key, value in props.items()}
            body = {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "$id": f"{base_url(request)}/collections/{collection_id}/queryables",
                "type": "object",
                "title": f"Queryables for {collection_id}",
                "properties": {
                    key: {"type": kind, "title": key.replace("_", " ").capitalize()}
                    for key, kind in types.items()
                },
                "additionalProperties": True,
            }
        return JSONResponse(body, media_type="application/schema+json")

    @app.get("/analytics/summary", tags=["Decision support"])
    def analytics_summary(
        bbox: str | None = Query(None, description="minx,miny,maxx,maxy in WGS84"),
    ) -> dict[str, Any]:
        """Aggregate the exposure grid — the kind of call a decision-support client makes."""
        query_bbox = _parse_bbox(bbox)
        with store() as conn:
            cells = conn.bbox("cells", bbox=query_bbox, limit=10_000)
            buildings = conn.bbox("buildings", bbox=query_bbox, limit=10_000)
        hei = [
            f.properties["hei"] for f in cells if isinstance(f.properties.get("hei"), (int, float))
        ]
        heights = [
            f.properties["height_final_m"]
            for f in buildings
            if isinstance(f.properties.get("height_final_m"), (int, float))
        ]
        return {
            "bbox": list(query_bbox) if query_bbox else None,
            "cells": len(cells),
            "buildings": len(buildings),
            "mean_hei": round(sum(hei) / len(hei), 2) if hei else None,
            "max_hei": round(max(hei), 2) if hei else None,
            "mean_height_m": round(sum(heights) / len(heights), 2) if heights else None,
            "hotspot_cells": sum(
                1 for f in cells if (f.properties.get("hei") or 0) >= _hotspot_threshold(hei)
            ),
            "note": "Aggregated from the stored feature collections; no re-modelling at query time.",
        }

    @app.get("/provenance", tags=["Provenance"])
    def provenance() -> JSONResponse:
        if not PROVENANCE_PATH.exists():
            raise HTTPException(
                status_code=503, detail="provenance not recorded yet — run `citytwin build`"
            )
        return JSONResponse(json.loads(PROVENANCE_PATH.read_text(encoding="utf-8")))

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict[str, Any]:
        return {"status": "ok", "store": path.exists(), "provenance": PROVENANCE_PATH.exists()}

    return app


def _json_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, (list, dict)):
        return "object"
    return "string"


def _hotspot_threshold(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[int(0.9 * (len(ordered) - 1))]


def _timestamp() -> str:
    from datetime import datetime

    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


app = create_app()
