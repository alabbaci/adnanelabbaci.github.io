# Dakhla Heat Pipeline — ArcGIS Pro (arcpy) route

This folder reproduces the **same** 3D heat-trap & pedestrian-exposure
analysis as the open-source `../scripts` pipeline, but rebuilt on **ArcGIS
Pro geoprocessing** (`arcpy`). Same inputs, same question, same three
stages — different engine:

| Stage | GeoPandas route (`../scripts`) | ArcGIS Pro route (this folder) |
|---|---|---|
| 1. Geometry | Overture → GeoJSON via GeoPandas | Overture / GeoJSON → File GDB feature classes |
| 2. Heat grid | `numpy` fishnet + `gpd.overlay` | `CreateFishnet` + `TabulateIntersection` |
| 3. Demographics | `gpd.overlay` area/volume weighting | `Intersect` / `Statistics` / `TabulateIntersection` |
| Output | `data/processed/*.geojson` | `dakhla.gdb` feature classes **+** `*_arcgis.geojson` |
| Viz | deck.gl (`../index.html`) / Kepler.gl | ArcGIS Pro **Local Scene** (3D) |

Everything writes into `arcgis_pro/workspace/dakhla.gdb` (git-ignored) and
also exports a GeoJSON per step into `../data/processed/` so you can diff the
two routes.

## Requirements

- **ArcGIS Pro 3.x** with a Desktop Basic (or higher) license — `arcpy`
  ships only with ArcGIS Pro, so these scripts cannot run in a plain Python
  install.
- Run with ArcGIS Pro's Python. Options:
  - the **Python window** inside ArcGIS Pro, or
  - the **Python Command Prompt** shipped with Pro, or
  - `propy` (the `arcgispro-py3` conda env launcher), e.g.
    `"C:\Program Files\ArcGIS\Pro\bin\Python\Scripts\propy.bat"`.
- For the live-Overture source (step 1, optional): install `pyarrow`,
  `s3fs`, and `shapely` into a **cloned** `arcgis-py3` env:
  ```
  conda create --clone arcgispro-py3 --name dakhla
  conda activate dakhla
  pip install pyarrow s3fs shapely
  ```
  The default `source="geojson"` needs none of this — it imports the
  committed GeoJSONs and runs on a stock Pro install.

## Run it (command line)

From the repo root, in an ArcGIS Pro Python shell:

```bash
propy arcgis_pro/01_import_overture_geometry.py            # source=geojson (default)
propy arcgis_pro/01_import_overture_geometry.py --source overture   # live fetch
propy arcgis_pro/02_generate_heat_grid.py
propy arcgis_pro/03_integrate_demographics.py
```

## Run it (Geoprocessing pane)

Add **`DakhlaHeatPipeline.pyt`** as a toolbox (Catalog → Toolboxes → Add
Toolbox), then run the three tools in order:

1. **Import Overture Geometry** (pick `geojson` or `overture`)
2. **Generate Heat Grid**
3. **Integrate Demographics**

## Outputs

In `workspace/dakhla.gdb`:

- `buildings_3d` — footprints with `calculated_height` (m)
- `pedestrian_network` — walkable segments
- `heat_grid` — 200 m cells with `urban_density`, `temperature_proxy`
- `demographics_grid` — cells with `population_estimate` (+ `elderly_share`,
  `population_count` in census mode)

Plus `../data/processed/dakhla_heat_grid_arcgis.geojson` and
`dakhla_demographics_grid_arcgis.geojson`.

## Build the 3D scene (mirrors the deck.gl view)

1. **Insert → New Map → New Local Scene.**
2. Add `buildings_3d`, `heat_grid`, `demographics_grid`, `pedestrian_network`
   from `dakhla.gdb`.
3. **Buildings — extrude by height.** Select `buildings_3d` → *Appearance →
   Extrusion → Base Height*, expression `$feature.calculated_height` (or the
   `calculated_height` field), type **Max**. To match the deck.gl scene's
   emphasis, multiply by ~4. Symbolize a single charcoal fill.
4. **Heat grid — temperature ramp.** Symbolize `heat_grid` with *Graduated
   Colors* on `temperature_proxy` (yellow → deep red), ~60% transparency so
   the streets read underneath.
5. **Population columns.** Symbolize `demographics_grid` with an *Extrusion*
   on `population_estimate` (Type = **Absolute Height**, scaled so the
   tallest column is legible), or convert cell centroids to points and use a
   3D column symbol.
6. **Network.** Draw `pedestrian_network` as a thin cyan line over the base.
7. Set the scene's basemap and elevation surface as you like, then navigate
   to street level in the old-town fabric to see the heat-trap canyons.

The analytical question is unchanged: *are Dakhla's residents forced to
navigate the densest, most heat-prone blocks during their daily walks?* —
now answerable inside ArcGIS Pro.

## Caveats

Same as the parent project (see `../README.md`): `temperature_proxy` is a
density-based **proxy**, not measured temperature; `population_estimate` is a
**model**, not counts; Overture building heights for Dakhla are sparse, so
most footprints fall back to the 4.5 m low-rise default.
