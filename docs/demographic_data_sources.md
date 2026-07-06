# Demographic Data for Dakhla (HCP)

`scripts/03_integrate_demographics.py` expects a census-district polygon
layer for Dakhla. Unlike Italy's ISTAT (used by the Torino original),
Morocco's **HCP — Haut-Commissariat au Plan** does not openly publish
district-level ("district de recensement") census geodata as a bulk
download, so this pipeline step is optional and skips gracefully when the
layer is absent.

## Where to get it

- **RGPH 2024** (Recensement Général de la Population et de l'Habitat)
  results are published by HCP at https://www.hcp.ma/ — commune-level
  tables (Dakhla municipality, Dakhla-Oued Ed-Dahab region) are available
  as spreadsheets; district-level geodata generally requires a request to
  HCP's regional directorate.
- Commune boundary geometry can be sourced from OSM admin boundaries or
  from the [geoBoundaries](https://www.geoboundaries.org/) ADM3 layer for
  Morocco/Western Sahara, then joined to HCP's published commune tables.
- Variables of interest for this project:
  - total resident population
  - population aged 60+ (HCP's standard age break; the pipeline treats it
    as the vulnerability column)

## Preparing the file

1. Join the census variable table to the district/commune boundaries (by
   district code) in QGIS or GeoPandas if they don't come pre-joined.
2. Reproject/export to GeoJSON (EPSG:4326).
3. Save as `data/raw/hcp_census_districts.geojson`.
4. Update `COLUMN_MAP` at the top of `03_integrate_demographics.py` to
   match your extract's column names (defaults: `POP_TOTAL`,
   `POP_60_PLUS`).

## What the script does

It apportions each census district's population onto the 200 m analysis
grid by area-weighted overlap (simple areal interpolation). With only
commune-level granularity the result will be coarse — dasymetric weighting
by building footprint area (which you already have from step 1) is the
recommended refinement.
