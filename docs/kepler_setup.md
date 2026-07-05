# Composing the 3D Scene in Kepler.gl

> **Shortcut:** this repo also ships a ready-made interactive scene at
> [`index.html`](../index.html) (deck.gl, no upload needed) — served
> automatically by GitHub Pages. The steps below are for recreating the
> scene in Kepler.gl, which gives you more styling control.

This is the manual styling pass once you have the GeoJSONs from the
`scripts/` pipeline:

- `dakhla_buildings_3d.geojson`
- `dakhla_pedestrian_network.geojson`
- `dakhla_heat_grid.geojson`
- (optional) `dakhla_demographics_grid.geojson`

## 1. Load the canvas

1. Go to [kepler.gl/demo](https://kepler.gl/demo).
2. Drag and drop the GeoJSON files into the browser window at the same time.

## 2. Layer 1 — Heat proxy (the base)

- Expand `dakhla_heat_grid`.
- Color by `temperature_proxy`.
- Use a diverging palette (deep blue → bright red/orange).
- Set layer opacity to ~0.4–0.5 so it reads as a glow painted on the ground
  rather than a solid mask.

## 3. Layer 2 — 3D buildings (the structure)

- Expand `dakhla_buildings_3d`.
- Click the 3D map icon (top right) to enable tilt.
- Toggle **Height** on, set the height field to `calculated_height`.
- Dakhla is low-rise (mostly 1–2 storeys), so set a **height multiplier of
  3–5×** — at 1× the extrusion is barely visible at city scale.
- Set fill color to a uniform dark gray/charcoal for contrast against the
  heat layer below — this is what makes the dense old-town blocks pop
  against the open desert lots.
- Right-click + drag to tilt the camera and look down the street canyons.

## 4. Layer 3 — Pedestrian network (the human element)

- Expand `dakhla_pedestrian_network`.
- Color: stark white or neon cyan.
- Reduce stroke width so it reads as delicate webbing threaded between the
  buildings — this is where people actually walk through the heat traps.

## 5. Optional Layer — Demographics

- Add `dakhla_demographics_grid` as a **Hexbin** or **Grid** layer.
- Aggregate by `population_estimate` (or `elderly_share` if you supplied a
  real census layer — see `docs/demographic_data_sources.md`).
- This is the layer that lets you actually answer the project's core
  question: are the most vulnerable residents walking through the worst
  heat traps?

## 6. Save your work

Kepler's exported `kepler_gl.html` and a saved `kepler_config.json` can be
large once datasets are embedded (Dakhla's are ~10–20MB — far lighter than
a Torino-sized city, but still worth keeping out of git history). To share
them:

- Use [Git LFS](https://git-lfs.github.com/) if you want them versioned, or
- Export just the JSON **config** (Kepler → Share → Export Map → Config
  Only) and store the data files separately, or
- Host the exported HTML on GitHub Pages / Netlify and link it from the
  README instead of committing the file — this repo's `index.html` already
  plays that role.
