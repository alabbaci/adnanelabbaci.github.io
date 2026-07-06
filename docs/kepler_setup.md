# Composing the 3D Scene in Kepler.gl

The committed `index.html` (deck.gl) already renders the full scene, but the
GeoJSONs also drop straight into Kepler.gl if you prefer an interactive
styling environment:

- `dakhla_buildings_3d.geojson`
- `dakhla_pedestrian_network.geojson`
- `dakhla_heat_grid.geojson`
- (optional) `dakhla_demographics_grid.geojson`

## 1. Load the canvas

1. Go to [kepler.gl/demo](https://kepler.gl/demo).
2. Drag and drop the GeoJSON files into the browser window at the same time.

## 2. Layer 1 — Heat proxy (the base)

- Expand `dakhla_heat_grid`.
- Color by `temperature_proxy` (range in this dataset: ~26.1–32.5 °C).
- Use a sequential warm palette (dark purple → orange → pale yellow).
- Set layer opacity to ~0.4–0.5 so it reads as a glow painted on the ground
  rather than a solid mask.

## 3. Layer 2 — 3D buildings (the structure)

- Expand `dakhla_buildings_3d`.
- Click the 3D map icon (top right) to enable tilt.
- Toggle **Height** on, set the height field to `calculated_height`.
- Because Dakhla is low-rise (median 4.5 m), set the height multiplier to
  ~3× so the canyon geometry stays legible at city scale.
- Set fill color to a uniform dark gray/charcoal for contrast against the
  heat layer below.

## 4. Layer 3 — Pedestrian network (the human element)

- Expand `dakhla_pedestrian_network`.
- Color: stark white or neon cyan.
- Reduce stroke width so it reads as delicate webbing threaded between the
  buildings — this is where people actually walk through the heat traps.

## 5. Optional Layer — Demographics

- Add `dakhla_demographics_grid` as a **Hexbin** or **Grid** layer
  (requires running step 3 with an HCP census layer, see
  `demographic_data_sources.md`).
- Aggregate by `population_count` or `elderly_share`.

## 6. Save your work

Kepler's exported `kepler_gl.html` and a saved `kepler_config.json` can be
large once datasets are embedded. Export just the JSON **config**
(Kepler → Share → Export Map → Config Only) and keep the data files in
`data/processed/`, or rely on the committed `index.html` which serves the
same scene from GitHub Pages with no manual styling session.
