"""OGC API - Features: landing, conformance, collections, items, queryables."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from citytwin.api.main import create_app
from citytwin.store import FeatureStore


@pytest.fixture
def client(tmp_path, simple_buildings, simple_cells):
    path = tmp_path / "api.sqlite"
    with FeatureStore.create(path) as store:
        store.add_collection(
            "buildings",
            simple_buildings,
            id_column="gers_id",
            title="Buildings",
            description="test buildings",
            extra_properties=["building_class", "height_final_m", "cell_id"],
        )
        store.add_collection(
            "cells",
            simple_cells,
            id_column="cell_id",
            title="Cells",
            description="test cells",
            extra_properties=["hei", "green_share"],
        )
    return TestClient(create_app(path))


def test_landing_and_conformance(client):
    landing = client.get("/").json()
    assert "links" in landing
    rels = {link["rel"] for link in landing["links"]}
    assert {"self", "service-desc", "conformance", "data"} <= rels

    conformance = client.get("/conformance").json()
    assert any("ogcapi-features-1" in item for item in conformance["conformsTo"])


def test_collections_and_extent(client):
    collections = client.get("/collections").json()["collections"]
    assert {c["id"] for c in collections} == {"buildings", "cells"}
    buildings = next(c for c in collections if c["id"] == "buildings")
    assert buildings["itemType"] == "feature"
    assert buildings["extent"]["spatial"]["bbox"][0]
    assert client.get("/collections/nope").status_code == 404


def test_items_pagination_and_matching(client):
    first = client.get("/collections/buildings/items?limit=2").json()
    assert first["type"] == "FeatureCollection"
    assert first["numberReturned"] == 2
    assert first["numberMatched"] == 4
    assert any(link["rel"] == "next" for link in first["links"])
    second = client.get("/collections/buildings/items?limit=2&offset=2").json()
    ids_first = {f["id"] for f in first["features"]}
    ids_second = {f["id"] for f in second["features"]}
    assert ids_first.isdisjoint(ids_second)
    assert any(link["rel"] == "prev" for link in second["links"])


def test_items_bbox_and_property_filter(client, simple_buildings):
    geom = simple_buildings.to_crs(4326).geometry.iloc[0]
    minx, miny, maxx, maxy = geom.bounds
    response = client.get(
        f"/collections/buildings/items?bbox={minx},{miny},{maxx},{maxy}&limit=10"
    ).json()
    assert response["numberMatched"] >= 1
    assert all(f["bbox"][0] <= maxx and f["bbox"][2] >= minx for f in response["features"])

    filtered = client.get("/collections/buildings/items?building_class=house&limit=10").json()
    assert filtered["numberMatched"] == 3
    assert all(f["properties"]["building_class"] == "house" for f in filtered["features"])


def test_single_feature_and_queryables(client):
    feature = client.get("/collections/buildings/items/1").json()
    assert feature["type"] == "Feature"
    assert feature["id"] == "1"
    assert client.get("/collections/buildings/items/999").status_code == 404

    queryables = client.get("/collections/buildings/queryables").json()
    assert "building_class" in queryables["properties"]
    assert queryables["properties"]["height_final_m"]["type"] == "number"


def test_analytics_endpoint(client):
    summary = client.get("/analytics/summary").json()
    assert summary["cells"] == 2
    assert summary["buildings"] == 4
    assert summary["mean_hei"] == pytest.approx(55.0)
    assert summary["hotspot_cells"] >= 1


def test_missing_store_is_reported(tmp_path):
    app = create_app(tmp_path / "absent.sqlite")
    response = TestClient(app).get("/collections")
    assert response.status_code == 503
    assert "citytwin build" in response.json()["detail"]
