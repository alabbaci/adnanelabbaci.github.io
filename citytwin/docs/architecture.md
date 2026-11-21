# Architecture

## Design in one paragraph

`citytwin` is a pipeline with a published edge: a reproducible build produces a feature
store, three standard artefacts and a provenance record; the API, the viewer and the
agent all read from those artefacts rather than from the source data. Nothing is
computed twice, and no consumer re-implements the model.

## Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `config.py` | Study area, CRS, grid size, exposure weights, paths | — |
| `ingest/overture.py` | Fetch the Overture GeoParquet extract (S3, bbox-filtered), normalise buildings/green/trees/streets | `pyarrow`, `s3fs`, GeoPandas |
| `features.py` | Morphology (area, compactness, aspect), context (neighbours, distance to centre/green/road), CV blocks | `geo.py` |
| `model.py` | Rule calibration, conformal intervals, RF benchmark, model card | scikit-learn |
| `analytics.py` | 250 m grid, HEI, weight sensitivity, Monte Carlo height propagation | `geo.py`, `config.py` |
| `typology.py` | KMeans on form/context, stability (ARI), exposure by type | scikit-learn |
| `store.py` | SQLite + R\*Tree feature store, collection registry | stdlib `sqlite3` |
| `provenance.py` | PROV-JSON writer, sha256 registry, verifier | stdlib |
| `exporters/` | CityJSON 1.1, 3D Tiles 1.1 (own GLB encoder), viewer, SVG charts | — |
| `pipeline.py` | Orchestration and artefact layout | all of the above |
| `api/main.py` | OGC API Features + analytics endpoint | FastAPI |
| `agent/` | Tools, planner, runner, MCP server, evaluation | store, metrics |
| `cli.py` | Command surface | everything |

## Data flow

```
data/raw/overture_dakhla_*.parquet  (cached extract + release manifest, not committed)
        │  parse_overture
data/processed/*.geojson         (normalised layers, provenance-hashed)
        │  build_features + calibrate_rule + apply_rule
        │  build_typology
        │  build_cells → compute_hei → assign_buildings → Monte Carlo
build/store/citytwin.sqlite      (collections: buildings, cells, green)
        │
        ├── build/cityjson/dakhla_lod1.city.json
        ├── build/3dtiles/{tileset.json,buildings.glb}
        ├── index.html
        └── docs/{metrics.json,model_card.md,agent_eval.md,assets/*}
```

## Why this shape

**One build, three consumers.** The API, viewer and agent share the store; none of them
re-runs the model. A reviewer can therefore compare an agent answer with the viewer
without wondering whether the numbers came from the same run.

**The store is the contract.** Collections carry a stable identifier (`cell_id`,
`gers_id`), a CRS, and a documented property list. Swapping SQLite for PostGIS changes
`store.py` and one DSN, not the API or the agent (see `deploy/postgis/init.sql` and
ADR 0002).

**Provenance is generated, not narrated.** Every file written by the pipeline is
hashed and linked to the activity that produced it. `citytwin verify` re-hashes them,
so a stale artefact is detected rather than believed.

**The viewer is a build artefact.** `web/template.html` is a template; the pipeline
injects a compact JSON payload (local metre coordinates, one decimal) and writes
`index.html` at the project root, where GitHub Pages serves it. That keeps the demo honest — it cannot drift from the data — and
keeps it portable: one file, no CDN, no tile server, no API key.

## Failure modes and guards

| Risk | Guard |
|---|---|
| Source drift or network loss | The Overture release is pinned in `config.py`; the extract is cached with a manifest; `--refresh` is explicit |
| Degenerate height intervals | Floor-count labels can collapse the conformal quantile to zero; the half-width is floored at one storey (ADR 0004) |
| Silent geometry failures | CityJSON self-check counts open shells; the build fails loudly in `verify` |
| Optimistic validation | All height metrics use blocked spatial CV, never random folds |
| Cluster over-interpretation | Typology reports silhouette and ARI, and excludes the imputed height |
| Agent hallucinating numbers | Tools are the only numeric source; answers cite evidence; eval asserts groundedness |
| False conformance claims | `docs/standards.md` lists what is implemented and what is not |

## Extension points

- **Another city**: add an `AOI` to `config.AOIS`; the grid, CRS and API follow.
- **Another data source**: implement `ingest/<source>.py` returning a `Layers` object.
- **A real height model**: swap `train_height_model` for a DSM lookup; the benchmark
  decides whether it replaces the rule.
- **A real tile server**: feed `build/3dtiles` to Cesium ion or py3dtiles; the tileset
  is already spec-shaped.
