"""Feature store: collection registry, R*Tree bbox queries, pagination, extent."""

from __future__ import annotations

from citytwin.store import FeatureStore


def test_store_roundtrip(tmp_path, simple_buildings):
    path = tmp_path / "store.sqlite"
    with FeatureStore.create(path) as store:
        assert (
            store.add_collection(
                "buildings",
                simple_buildings,
                id_column="gers_id",
                title="Buildings",
                description="test",
                extra_properties=["building_class", "height_final_m"],
            )
            == 4
        )
        collections = store.collections()
        assert collections[0]["name"] == "buildings"
        assert collections[0]["count"] == 4
        # stored in WGS84 for OGC API compatibility
        extent = store.extent("buildings")
        assert extent is not None
        assert -180 <= extent[0] < extent[2] <= 180
        assert store.count("buildings") == 4
        feature = store.get("buildings", "1")
        assert feature is not None
        assert feature.properties["building_class"] == "house"
        assert feature.geometry["type"] == "Polygon"


def test_bbox_query_and_pagination(tmp_path, simple_buildings):
    path = tmp_path / "store.sqlite"
    with FeatureStore.create(path) as store:
        store.add_collection(
            "buildings",
            simple_buildings,
            id_column="gers_id",
            title="Buildings",
            description="test",
            extra_properties=["building_class"],
        )
        # whole extent
        assert len(store.bbox("buildings", limit=10)) == 4
        # pagination
        page = store.bbox("buildings", limit=2, offset=2)
        assert len(page) == 2
        assert [f.fid for f in page] != [f.fid for f in store.bbox("buildings", limit=2)]
        # a bbox around the first building only
        lon, lat = simple_buildings.to_crs(4326).geometry.iloc[0].centroid.coords[0]
        tight = store.bbox(
            "buildings", bbox=(lon - 0.0002, lat - 0.0002, lon + 0.0002, lat + 0.0002), limit=10
        )
        assert len(tight) <= 2


def test_aggregate_ignores_non_numeric(tmp_path, simple_buildings):
    path = tmp_path / "s.sqlite"
    with FeatureStore.create(path) as store:
        store.add_collection(
            "buildings",
            simple_buildings,
            id_column="gers_id",
            title="B",
            description="t",
            extra_properties=["height_final_m"],
        )
        assert store.aggregate("buildings", "height_final_m", "mean") == 7.5
        assert store.aggregate("buildings", "missing_field", "mean") is None
