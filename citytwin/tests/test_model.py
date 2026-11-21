"""Height completion: storey snapping, smoothing and the rule application."""

from __future__ import annotations

import numpy as np
import pytest

from citytwin.config import STOREY_HEIGHT_M
from citytwin.model import apply_rule, rule_table, snap_to_storey


def test_snap_to_storey():
    values = np.array([5.5, 6.4, 9.7, 11.9])
    snapped = snap_to_storey(values)
    assert np.allclose(snapped % STOREY_HEIGHT_M, 0)
    assert snapped.tolist() == [6.0, 6.0, 9.0, 12.0]


def test_rule_table_smooths_small_classes(simple_buildings):
    table = rule_table(simple_buildings)
    assert table["n_labelled"] == 2
    # one 6 m house label is shrunk towards the global median; it must not stay at 6
    assert 6.0 < table["table"]["house"] < 10.0
    assert table["table"]["apartments"] > table["table"]["house"]


def test_apply_rule_keeps_observed_heights(simple_buildings):
    table = rule_table(simple_buildings)
    result = apply_rule(simple_buildings, table, quantile_m=3.0)
    assert result["height_final_m"].notna().all()
    observed = result[result["has_height_label"]]
    assert (observed["height_final_m"] == observed["height_observed_m"]).all()
    assert (result["height_uncertainty_m"] >= 0).all()
    assert set(result["height_provenance"]) >= {"height_tag", "levels"}


def test_apply_rule_never_returns_negative_intervals(simple_buildings):
    table = rule_table(simple_buildings)
    result = apply_rule(simple_buildings, table, quantile_m=9.0)
    assert (result["height_lo_final_m"] >= 0).all()
    assert (result["height_hi_final_m"] >= result["height_lo_final_m"]).all()


def test_rule_table_requires_labels(simple_buildings):
    frame = simple_buildings.assign(has_height_label=False)
    with pytest.raises((ValueError, KeyError)):
        rule_table(frame)
