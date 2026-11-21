# Model card — building height completion

**Study area:** Dakhla · **Regenerate with:** `citytwin height --benchmark`

## What this module does

831 of 3106 footprints (26.8%) carry a
height label. The rest need a height so that a LoD1 city model can be generated.
Two strategies are implemented and compared; the shipped default is **rule**.

| Strategy | Definition |
|---|---|
| `rule` (default) | Smoothed per-`building_class` median, snapped to the 3 m storey lattice |
| `model` | Random forest on morphology + fold-safe class-median encoding |

Target: height_m = Overture `height` when present, else `num_floors` * 3.0 m · Source: Overture Maps (© OpenStreetMap
contributors, Microsoft ML Buildings), ODbL 1.0.

## Blocked cross-validation (300 m spatial blocks, 5 folds)

| Strategy | MAE (m) | RMSE (m) | R² | 80% coverage | Interval width |
|---|---|---|---|---|---|
| **rule (shipped)** | **0.36** | **1.59** | **-0.05** | 0.939 | ±3.0 m |
| model (benchmark) | 0.36 | 1.59 | -0.05 | 0.939 | ±3.0 m |
| model, random folds (reference only) | 0.36 | 1.57 | -0.018 | — | — |

ΔMAE (model − rule): **0.0 m**. The learned strategy is only adopted when it reduces blocked MAE; otherwise the rule is shipped because it is simpler and fully explainable.

The two strategies are indistinguishable under blocked cross-validation (identical MAE), so the rule is shipped: it has no fitted parameters beyond a per-class median and is fully explainable. Random-fold validation gives MAE 0.36 m against 0.36 m with blocked folds; blocked scores are the ones quoted because they are the defensible design for spatial data.

### Read these scores with the label set in mind

94% of the labelled footprints fall in the one-to-two-storey class, so a
constant prediction is already nearly unbeatable: R² close to zero for *both* strategies
says that neither explains the little variance there is. The MAE therefore measures how
homogeneous the labels are, not how accurate an imputed height is on an unlabelled
footprint. The labels are OSM floor counts concentrated in a few hand-mapped residential
neighbourhoods; the unlabelled footprints are mostly Microsoft ML detections elsewhere in
the city, which the cross-validation cannot reach.

### Rule calibration table

| Building class | Estimated height (m) |
|---|---|
| `commercial` | 5.50 |
| `hotel` | 8.00 |
| `other` | 6.00 |
| `public` | 6.00 |
| `residential` | 6.00 |
| `retail` | 7.00 |

### Learned model per fold

| Fold | Test | MAE | RMSE | R² | Coverage@80 |
|---|---|---|---|---|---|
| 0 | 167 | 0.41 | 1.87 | -0.051 | 0.93 |
| 1 | 166 | 0.14 | 0.99 | -0.012 | 0.98 |
| 2 | 166 | 0.29 | 1.23 | -0.044 | 0.94 |
| 3 | 166 | 0.89 | 2.52 | -0.141 | 0.86 |
| 4 | 166 | 0.07 | 0.57 | -0.016 | 0.98 |

### Learned model importance (ΔMAE, metres)

| Feature | Importance |
|---|---|
| `n_vertices` | 0.01 |
| `area_m2` | 0.01 |
| `perimeter_m` | 0.01 |
| `compactness` | 0.01 |
| `mean_neighbour_area_m2` | 0.01 |
| `dist_tree_m` | 0.00 |

## Uncertainty

Every imputed footprint carries an interval of ±3.0 m, stored as
`height_lo_final_m` / `height_hi_final_m` and propagated by Monte Carlo into the
exposure index (`docs/uncertainty.md`). The raw 80% conformal quantile of the rule is
±0.0 m; the shipped half-width is floored at one storey
(3 m) because floor-count labels are whole storeys and an imputed
height is never known to better than that. With the floor, 96%
of the out-of-fold labels fall inside the interval.

## What this benchmark shows

Footprint morphology carries almost no height signal in a homogeneous low-rise city
with a narrow label set. That is a property of the data, not a tuning failure, and it
is why the twin reports intervals, gives height a small weight in the exposure index
(`configs/exposure_weights.json`) and shows how unstable the hotspot set is under
height redraws. A photogrammetric or LiDAR DSM, or building heights from a
stereo-satellite product, would change this conclusion; the benchmark can be re-run
with any label source.

## Limitations

1. Small, clustered label set: almost all labels are two-storey residential blocks mapped in OSM.
2. Many OSM footprints are whole blocks rather than single buildings; ML footprints are single roofs.
3. Flat-roof LoD1 only — no roof shape, setbacks or building parts.
4. Floor counts are mapped inconsistently (roof terraces, mezzanines); 3 m/storey is an assumption.
5. Static heights: no construction year, no vertical extension over time.

## Operational notes

Each geometry keeps `height_provenance` (`height_tag`, `levels`, `rule:<version>`,
`model:<version>`). The provenance document records the strategy, the quantile and
the label hash, so an auditor can reproduce every interval.
