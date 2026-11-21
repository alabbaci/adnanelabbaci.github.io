# Uncertainty: from missing heights to decision stability

## The problem

831 of 3 106 footprints carry a height label (26.8%). A LoD1 model needs a height for
every footprint, and a heat-exposure index built on those heights needs to know how
much of its ranking depends on guesswork.

In Dakhla the label set is not just small, it is narrow. Every label comes from an
OpenStreetMap floor count (829) or height tag (2); none of the 1 923 Microsoft ML
footprints has one. And 780 of the 831 labels say exactly two storeys:

| Storeys | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Labelled footprints | 2 | 780 | 12 | 30 | 3 | 3 | 1 |

Three layers handle this:

1. **A calibrated rule** for the point estimate.
2. **Intervals** for each imputed height, with a one-storey floor.
3. **Monte Carlo propagation** into the exposure index and the hotspot decision.

## 1. Point estimate

`rule_table()` computes a smoothed median per `building_class`:

```
h_class = (median_class * n_class + K * median_global) / (n_class + K),  K = 5
```

then snaps to the 3 m storey lattice. Evaluation uses 5-fold **blocked** spatial CV
(300 m blocks), so a building is never validated against its own neighbours.

| Metric | Value |
|---|---|
| MAE | 0.36 m |
| RMSE | 1.59 m |
| R² | −0.05 |
| Bias | −0.35 m |
| Raw 80% conformal quantile | ±0.0 m |
| Shipped interval half-width | ±3.0 m (one-storey floor) |
| Out-of-fold coverage of the shipped interval | 0.955 |

The learned benchmark (random forest, morphology + fold-safe class-median encoding)
reaches exactly the same scores under the same folds, because after snapping to the
storey lattice it also predicts 6 m almost everywhere. Neither strategy explains any
variance (R² ≈ 0): **the 0.36 m MAE measures how homogeneous the labels are, not how
accurate an imputed height is.** The rule is shipped because it is the simpler of two
indistinguishable options (ADR 0001).

## 2. Intervals

For each fold, residuals of the held-out labels are collected; the 80th percentile of
the *other* folds' residuals gives the interval half-width for that fold. With 94% of
the labels at exactly 6 m, that quantile is zero: taken literally, the conformal
procedure says every imputed height is known exactly. That is an artefact of whole-storey
labels drawn from a few uniform neighbourhoods, and it would make the Monte Carlo step
below a no-op.

The half-width is therefore floored at one storey, `MIN_INTERVAL_M = 3.0 m`
(`config.py`, ADR 0004). An imputed height is never claimed to better than one storey
either way: a "6 m" footprint may be a single-storey house or a three-storey block. The
floor is a stated assumption, not a calibrated quantity, and it is conservative for the
labelled neighbourhoods (coverage 0.955 against a nominal 0.80).

Every footprint carries:

```
height_final_m, height_lo_final_m, height_hi_final_m, height_uncertainty_m, height_provenance
```

Observed heights have zero-width intervals; imputed heights carry
`rule:class-median-0.5.0` as provenance.

## 3. Monte Carlo propagation

```
for draw in 1..n:
    h_i ~ Uniform(lo_i, hi_i)         for imputed footprints
    h_i  = observed                    for labelled footprints
    recompute cell means → HEI → hotspot set (≥ p90)
    record jaccard(draw hotspot set, observed hotspot set)
```

Results at n = 200:

| Quantity | Value |
|---|---|
| Mean Jaccard overlap with observed hotspot set | 0.50 |
| 5th percentile Jaccard | 0.38 |
| Cells hot in ≥ 80% of draws | 11 of 199 |
| Median 80% interval width of the HEI | ≈ 10 index points |

**Interpretation.** The hotspot map is a screening product, not a finding. 20 cells
cross the 90th-percentile threshold in the observed-height map; only the 11 that
survive 80% of draws should be quoted as hotspots, and the other nine are conditional
on the height guess. Height carries a weight of only 0.15 in the Dakhla index
(ADR 0004), and it still moves half of the hotspot set. The fix is data, not
modelling: a photogrammetric or stereo-satellite DSM would collapse the intervals and
make the hotspot set identifiable.

This is reported, not hidden: `docs/metrics.json` stores the numbers, the API exposes
`hotspot_probability` per cell, the viewer outlines only cells that pass 0.8, and the
agent answer repeats the caveat.

## 4. Weight sensitivity (a different uncertainty)

The index is a weighted sum of four normalised components. Perturbing the weights
(500 Dirichlet draws around the documented defaults) gives:

| Quantity | Value |
|---|---|
| Median Spearman ρ of cell ranking | 0.938 |
| 5th percentile ρ | 0.692 |
| Median hotspot Jaccard | 0.60 |
| 5th percentile Jaccard | 0.25 |

So the overall *ranking* is fairly robust to the choice of weights, but the
*membership* of the top decile is not: a typical re-weighting keeps only about
three-quarters of the hotspot cells. Both statements belong in a decision memo.

## What the index does not see

- **The sea breeze.** Dakhla sits between the Atlantic and the lagoon, and distance to
  either shore is probably the strongest control on street-level heat. It is not a
  component of the index.
- **Vegetation that is not mapped.** The green layer is 19 polygons and 5 tree points,
  under 1% of the gridded area. Sports pitches and recreation grounds are excluded on
  purpose (bare sand or artificial turf).
- **Footprint granularity.** OSM footprints are often whole blocks (median 1 035 m²);
  ML footprints are single roofs (median 96 m²). Built-up share is comparable across
  the two, building counts are not.

## What would change the conclusion

1. A DSM or measured heights outside the labelled neighbourhoods — the dominant term.
2. A satellite land-surface-temperature layer to validate the index against, and a
   coast-distance or wind-exposure component.
3. A canopy layer from imagery instead of mapped parks.
