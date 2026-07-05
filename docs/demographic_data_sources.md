# Demographic Data for Dakhla

`scripts/03_integrate_demographics.py` runs in one of two modes.

## Default: dasymetric building-volume proxy

Morocco's Haut-Commissariat au Plan (HCP) publishes RGPH 2024 census
results down to the commune level as tables, but — unlike Italy's ISTAT,
whose census-section polygons the original Torino pipeline used — it does
not openly distribute sub-communal census *geodata* (districts de
recensement) for download.

So out of the box the script distributes Dakhla municipality's official
RGPH 2024 population (**161,723**) across the 200m grid proportionally to
**residential building volume** (footprint area × resolved height), after
excluding Overture building classes that clearly don't house people
(commercial, industrial, military, etc.). The output column is named
`population_estimate` to keep its modelled nature visible.

This is a standard dasymetric refinement and is *more* spatially detailed
than the area-weighted census-section apportionment used in Torino — but
its per-cell accuracy is unvalidated. Treat it as a plausible density
surface, not counts.

## Better: a real census or gridded-population layer

If you can obtain any of the following, save it as
`data/raw/census_sections.geojson` and re-run the script — it will switch
to area-weighted apportionment automatically:

- **HCP RGPH 2024 district-level extracts** — request via
  [hcp.ma](https://www.hcp.ma/) or the HCP regional direction for
  Dakhla-Oued Ed-Dahab. Rename the population columns or adjust
  `COLUMN_MAP` at the top of the script (`POP` → total population,
  `POP65` → population aged 65+, which enables the `elderly_share`
  vulnerability column).
- **WorldPop 100m constrained population** ([worldpop.org](https://www.worldpop.org/)) —
  vectorize the raster cells to polygons, name the value column `POP`.
- **Kontur Population** ([data.humdata.org](https://data.humdata.org/dataset/kontur-population-dataset)) —
  H3-hexagon population, same treatment.

## What the script does in census mode

It apportions each census polygon's population onto the 200m analysis grid
by area-weighted overlap (simple areal interpolation — fine for a course
project; for higher accuracy combine it with the building-volume weighting
the proxy mode already implements).
