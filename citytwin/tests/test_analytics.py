"""Analytics: cell assignment, exposure bounds and hotspot logic."""

from __future__ import annotations

from citytwin.analytics import assign_buildings, compute_hei, summarise
from citytwin.config import load_weights


def test_assign_buildings_covers_every_footprint(simple_buildings, simple_cells):
    joined = assign_buildings(simple_buildings, simple_cells)
    assert len(joined) == len(simple_buildings)
    assert joined["cell_id"].notna().all()
    assert joined["cell_hei"].notna().all()


def test_assign_buildings_is_idempotent(simple_buildings, simple_cells):
    once = assign_buildings(simple_buildings, simple_cells)
    twice = assign_buildings(once, simple_cells)
    assert list(twice.columns) == list(once.columns)
    assert len(twice) == len(once)


def test_compute_hei_stays_in_range(simple_cells):
    cells = compute_hei(simple_cells.drop(columns=["hei", "hei_percentile"]), load_weights())
    assert cells["hei"].between(0, 100).all()
    assert cells["hei_percentile"].between(0, 100).all()


def test_summarise_reports_hotspots(simple_buildings, simple_cells):
    joined = assign_buildings(simple_buildings, simple_cells)
    summary = summarise(simple_cells, joined)
    assert summary["cells"] == 2
    assert summary["hotspot_threshold"] == round(float(simple_cells["hei"].quantile(0.9)), 1)
    assert summary["hotspot_cells"] >= 1
    assert 0 <= summary["green_share"] <= 1
