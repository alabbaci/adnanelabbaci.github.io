# Upgrading the Heat Proxy to Real Microclimate Data

`scripts/02_generate_heat_grid.py` ships with a density-based
`temperature_proxy` (26 °C coastal-desert baseline + up to 6.5 °C from
building density) so the pipeline runs end-to-end without external imagery.
For a research-grade version, replace that column with one of the following.

## Option A — Land Surface Temperature (satellite)

- **Landsat 8/9 TIRS** (100 m, 16-day revisit) or **Sentinel-3 SLSTR**
  (1 km, daily) via [USGS EarthExplorer](https://earthexplorer.usgs.gov/) or
  [Copernicus Browser](https://browser.dataspace.copernicus.eu/).
- Dakhla's climate advantage for this: cloud-free scenes are abundant
  year-round, so you can composite several summer acquisitions instead of
  hunting for a single clear day.
- Prefer late-summer scenes (August–October) when the *sharqi* easterly
  wind episodes push inland desert air over the peninsula — that is when
  the built fabric's heat retention matters most.
- Convert thermal band DN → brightness temperature → LST (mono-window or
  split-window algorithm depending on sensor).
- Resample/zonal-mean the LST raster onto the same 200 m grid used in
  `02_generate_heat_grid.py`, replacing `temperature_proxy`.

## Option B — Mean Radiant Temperature simulation (street-level)

- [SOLWEIG](https://umep-docs.readthedocs.io/) (part of the UMEP QGIS
  plugin) simulates MRT at street level using a digital surface model built
  from your building heights plus land cover.
- Best run on a single neighborhood (e.g. the dense old town at the
  peninsula's southwestern tip) rather than the whole study area.
- Caveat: since ~80% of Dakhla's building heights in this dataset fall back
  to the 4.5 m default, consider refining heights (field survey, or a DSM
  from stereo imagery) before investing in an MRT run — the simulation is
  only as good as the 3D model underneath it.
- Output a raster or point grid of MRT, then join it to the same grid
  schema (`grid_id`, `geometry`, `temperature_proxy`) so it drops into the
  existing visualization config.
