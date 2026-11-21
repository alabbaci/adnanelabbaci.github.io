# AGENTS.md

Guidance for coding agents working in this repository. Human-facing
documentation lives in `README.md` and in each project's own `README.md`.

## What this repository is

A GitHub Pages site made of several independent geospatial projects. Each one
is a static, no-build web page backed by a small Python pipeline that writes
the data the page reads.

| Path | Project | Page | Pipeline |
|---|---|---|---|
| `/` (`index.html`, `scripts/`, `data/processed/`) | Dakhla 3D heat traps and pedestrian exposure | deck.gl | `scripts/01_…` → `02_…` → `03_…` |
| `energy/` | Morocco load, PV and wind forecasts | static dashboard | `energy/pipeline/run_daily.py` |
| `ourika/` | Ourika watershed dashboard | MapLibre | `ourika/pipeline/` |
| `toubkal/` | One week in Toubkal National Park | Three.js | `toubkal/pipeline/` |
| `weather/` + `weather-source/` | Africa Weather Explorer | static app | `weather-source/sweep` (uv) |
| `citytwin/` | Auditable digital twin of Dakhla | viewer + OGC API | `citytwin` Python package |
| `vendor/` | Pinned third-party JS (deck.gl, MapLibre, Three.js) | | |

## Setup and commands

Run commands from the repository root unless noted. Each project has its own
dependencies; install only what the task needs.

```bash
# Root Dakhla heat pipeline (run in order; each step reads the previous output)
pip install -r requirements.txt
python scripts/01_fetch_overture_geometry.py
python scripts/02_generate_heat_grid.py
python scripts/03_integrate_demographics.py

# Energy forecasts (first run downloads about 3 years of weather)
pip install -r energy/requirements.txt
python energy/pipeline/run_daily.py

# Ourika
pip install -r ourika/pipeline/requirements.txt
python ourika/pipeline/01_delineate_watershed.py
python ourika/pipeline/02_fetch_overture_context.py

# Toubkal
pip install -r toubkal/pipeline/requirements.txt
python toubkal/pipeline/01_build_scene.py
python toubkal/pipeline/02_snapshot.py      # optional: refresh the fallback week

# Africa weather (from weather-source/; exit code 3 means already up to date)
uv sync --python 3.12 --frozen
uv run python -m sweep --no-ai --out ../weather/data

# citytwin (from citytwin/)
make install      # editable install with dev extras
make test lint    # pytest + ruff
make build        # full pipeline
make verify       # re-hash artefacts, validate CityJSON and GLB
```

Preview any page with `python -m http.server` from the repository root, then
open `http://localhost:8000/<project>/`. Pages must be served over HTTP;
opening the HTML files directly from disk does not work.

## Testing

- `citytwin/` is the only project with a test suite. Run `make test lint`
  there before committing changes to it, and add or update tests for the code
  you change.
- The other projects have no tests. Verify a change by running the affected
  pipeline step and loading the page in a browser; check the console for
  errors and confirm the data layers render.

## Conventions

- **No build step.** Pages are plain HTML, CSS and JavaScript. Do not add
  bundlers, frameworks or `package.json`.
- **No CDN scripts.** Third-party libraries are vendored under `vendor/` with
  the version in the filename. To upgrade one, add the new file and update
  every reference.
- **Keep projects independent.** Don't share code or data across project
  folders; each must work on its own.
- **Generated data is committed** so the site works without running anything
  (`data/processed/`, `*/data/`). Regenerate it with the pipeline rather than
  editing it by hand, and commit the output together with the code that
  produced it.
- **Caches are not committed**: `data/raw/`, `energy/.cache/`,
  `ourika/pipeline/.cache/`, `toubkal/pipeline/.cache/`.
- **Label modelled values honestly.** `temperature_proxy` is a density proxy,
  not a measurement; `population_estimate` is a model, not a count. Keep such
  caveats visible in the UI and the docs when touching them.
- Pipelines use only free, keyless data sources (Overture Maps on S3,
  Open-Meteo, public DEM tiles). Don't introduce API keys or paid services.
- A new top-level project needs a line in the banner at the top of the root
  `README.md` and its own `README.md`.

## Deployment and automation

- `.github/workflows/africa-weather.yml` refreshes the Africa forecast and
  deploys the whole site to GitHub Pages, twice daily and on pushes touching
  `weather/`, `weather-source/`, `ourika/`, `toubkal/` or `vendor/`. It
  asserts that specific files exist before publishing; if you rename or move
  a page or data file, update those checks and the `rsync` excludes.
- `.github/workflows/energy-forecast.yml` runs daily and commits
  `energy/data/forecast.json` and `energy/data/analytics.json` straight to
  `main`. Never edit those two files by hand, and expect `main` to move
  under you; rebase rather than force-push.
- Files under `*/pipeline/` and `weather-source/` are excluded from the
  published site. Anything else in the repository is public.

## Commits and pull requests

- Prefix the subject with the project when the change is scoped to one:
  `energy: …`, `citytwin: …`. Otherwise use a short imperative subject.
- Keep each pull request to one project where possible.
- Don't commit secrets, caches or large exports (`kepler_gl.html`,
  `kepler_config.json`).
