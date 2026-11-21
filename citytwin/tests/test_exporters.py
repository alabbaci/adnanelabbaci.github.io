"""Exporters: closed CityJSON shells, a parseable GLB and a self-contained viewer."""

from __future__ import annotations

import json
import re

from citytwin.exporters import (
    buildings_to_3dtiles,
    buildings_to_cityjson,
    validate_cityjson,
    validate_glb,
)
from citytwin.exporters.viewer import build_viewer


def test_cityjson_shells_are_closed(tmp_path, simple_buildings):
    path = buildings_to_cityjson(simple_buildings, tmp_path / "city.json", aoi_name="Test area")
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["type"] == "CityJSON"
    assert document["version"] in {"1.1", "2.0"}
    assert len(document["CityObjects"]) == len(simple_buildings)
    validation = validate_cityjson(path)
    assert validation["open_shells"] == 0
    assert validation["ok"] is True
    # 6 vertices per footprint: 4 base + 4 top minus 2 shared corners
    assert validation["vertices"] == 8 * len(simple_buildings)


def test_glb_is_structurally_valid(tmp_path, simple_buildings):
    summary = buildings_to_3dtiles(simple_buildings, tmp_path / "tiles")
    validation = validate_glb(tmp_path / "tiles" / "buildings.glb")
    assert validation["ok"] is True
    assert validation["problems"] == []
    assert validation["triangles"] > 0
    assert summary["buildings"] == len(simple_buildings)
    tileset = json.loads((tmp_path / "tiles" / "tileset.json").read_text(encoding="utf-8"))
    assert tileset["asset"]["version"].startswith("1.")
    assert tileset["geometricError"] >= 0


def test_viewer_is_offline(tmp_path, simple_buildings, simple_cells, simple_green, simple_streets):
    path = build_viewer(
        simple_buildings,
        simple_cells,
        simple_green,
        simple_streets,
        out_path=tmp_path / "index.html",
        meta={"strategy": "test", "labelled": 2},
    )
    html = path.read_text(encoding="utf-8")
    assert "__DATA__" not in html
    assert '"buildings"' in html
    # no external resources: no CDN, no fonts, no tiles. Attribution anchors are
    # plain links — they cost nothing until a reader clicks them.
    assert not re.search(r'<(?:script|img|iframe|link)\b[^>]*(?:src|href)=["\']https?://', html)
    for forbidden in ("cdn.", "unpkg", "jsdelivr", "@import", "url(http"):
        assert forbidden not in html
    assert "Dakhla" in html
