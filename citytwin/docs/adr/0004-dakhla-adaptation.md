# ADR 0004 — Adapting the twin to Dakhla: Overture source, index weights, interval floor

**Status:** accepted · **Date:** 2026-11-21

## Context

The toolkit was written for Esch-sur-Alzette, a densely mapped European town read from
the OSM API. Dakhla differs in three ways that the code had to acknowledge rather than
paper over.

## Decisions

### 1. Read Overture Maps instead of the OSM API

OSM alone has 1 183 footprints in the study area. Overture conflates them with
Microsoft ML Buildings and gives 3 106. `ingest/overture.py` reads the pinned release
(`2026-11-18.0`) from the public S3 bucket and returns the same `Layers` object the
rest of the pipeline expects; each building keeps its GERS identifier (`gers_id`) and a
`footprint_source` attribute. Everything is ODbL 1.0.

Consequence: the two sources differ in granularity. OSM footprints are frequently
whole blocks, ML footprints single roofs. The typology picks this up as its first
cluster ("block-scale footprints"), which is a property of the mapping as much as of
the city.

### 2. Height weighs 0.15 in the exposure index, built-up share 0.35

Upstream weights were height 0.35, lack of green 0.30, distance to green 0.20,
built-up share 0.15. In Dakhla 98% of footprints end up at 6 m, so the height component
is close to a tie-breaking noise term, while built-up share (0–58% per cell) is the
component that actually separates the compact districts from the open periphery. The
two weights are swapped in `configs/exposure_weights.json`.

Consequence: under height redraws the hotspot Jaccard rises from 0.20 (upstream
weights) to 0.50, and 11 cells rather than 6 are robust at 80%. The index is still a
relative screening score, not a temperature.

### 3. The imputed-height interval is floored at one storey

Floor-count labels are whole storeys and 94% of them are identical, so the 80%
conformal quantile is 0.0 m. `MIN_INTERVAL_M = 3.0 m` floors the half-width; both the
raw quantile and the floor are recorded in the provenance and the model card.

### 4. Smaller things

- Metric CRS is EPSG:32628 (WGS 84 / UTM 28N); the equal-area check uses EPSG:6933.
- Pitches and recreation grounds are not counted as green.
- The number of typology clusters is the smallest k within 0.02 silhouette of the
  best, and cluster labels compare density with the study-area mean instead of fixed
  thresholds.
- The viewer zooms to 12× about a shared focus and pans in plan: the study area is
  about 5 km × 6.5 km, against 1 km × 1.1 km upstream.

## Not done

A coast-distance or wind-exposure component, which Dakhla's setting argues for, and
validation against satellite land-surface temperature. Both are listed in
`docs/uncertainty.md`.
