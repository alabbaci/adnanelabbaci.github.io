# ADR 0001 — The rule-based height model ships; the learned one is a benchmark

**Status:** accepted · **Date:** 2026-11-21 (Dakhla build; the decision is inherited
from the upstream Esch-sur-Alzette project and re-tested here)

## Context

2 275 of 3 106 footprints have no height or floor count. We need a LoD1 model and an
exposure index, so imputation is unavoidable. The obvious choice is a random-forest
regressor on morphology and context features; the less glamorous one is a smoothed
per-class median snapped to the storey lattice.

## Decision

Ship the rule. Keep the learned model as a benchmark under the same folds, publish the
comparison in `docs/model_card.md`, and keep the selection criterion explicit: MAE
under 300 m blocked cross-validation, with explainability as the tie-breaker.

## Evidence (831 labelled buildings, 5 blocked folds)

| Strategy | MAE | RMSE | R² | Bias |
|---|---|---|---|---|
| **Rule: smoothed class median → 3 m lattice (shipped)** | **0.36 m** | 1.59 | −0.05 | −0.35 |
| Random forest, morphology + fold-safe class medians | 0.36 m | 1.59 | −0.05 | −0.35 |
| Random forest, random folds (reference only) | 0.36 m | 1.57 | −0.02 | −0.34 |

## Why this is a tie, and what the tie means

- 780 of the 831 labels are exactly two storeys (6.0 m). Any sensible predictor,
  snapped to the storey lattice, answers "6 m" almost everywhere, so both strategies
  produce the same predictions and the same scores.
- R² is slightly negative for both: neither explains the variance that exists (the 51
  taller or lower buildings). The forest's most important feature moves MAE by 0.013 m.
- The tie-breaker decides: the rule is a six-row table a reviewer can read.
- The scores say little about the 2 275 imputed footprints. All labels are OSM floor
  counts from a few hand-mapped residential neighbourhoods; 1 923 of the unlabelled
  footprints are Microsoft ML detections elsewhere in the city. Blocked folds protect
  against neighbour leakage, not against that shift.

## Consequences

- The default output is explainable: a reviewer can read the class table and reproduce
  a height by hand.
- The model and its fold table stay in the repository, so the claim "the model does not
  win" is checkable and not a matter of taste.
- Because the raw conformal quantile collapses to zero on these labels, the interval is
  floored at one storey and height gets a small weight in the index (ADR 0004).
- A DSM is the next real improvement; `benchmark_heights` already exists to decide
  whether it beats the rule, and the criterion is already written down.
