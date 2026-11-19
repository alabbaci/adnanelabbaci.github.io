# Maâmora Watch

NDVI monitoring of the Maâmora forest, the cork oak forest east of Kénitra
and Salé (Morocco). The page shows monthly Sentinel-2 greenness since
January 2019, how each month compares with normal, the dry-season canopy
trend, and mapped patches of canopy loss and gain.

**▶ Dashboard: [`index.html`](index.html)**

## What it is modelled on

The pipeline follows the pattern of Microsoft's
[AI Workflow for Planetary Computer Pro](https://techcommunity.microsoft.com/blog/microsoft-planetary-computer-blog/join-us-in-using-ai-workflow-preview-feature-in-microsoft-planetary-computer-pro/4571817),
and the change layer borrows the output shape of the
[MARS](https://labs.ai.azure.com/innovations/mars/) model.

| AI Workflow stage | Here |
|---|---|
| Inputs: area, time range, settings | Forest polygons inside a fixed window, January 2019 to today |
| Retrieve catalogued imagery | List the Sentinel-2 L2A scenes of granules 29SQT and 29SQU, screen them for cloud over the forest |
| Partition the area | 2 km cells, each with its own monthly series |
| Inference | Cloud-masked NDVI composites, anomalies, trend, change detection |
| Catalogue outputs as STAC items | `data/stac/collection.json` plus one item per month and one for the change layer |
| MARS output: vector features with category and confidence | `data/change.geojson`: polygons tagged `canopy_loss` or `canopy_gain` with a confidence |

**MARS itself is not run.** It extracts buildings, roads and railways and
does not measure vegetation, and AI Workflow is a private preview that needs
an Azure subscription with GPU quota. The analysis here is the NDVI index
and plain statistics on open data, with no API key.

## Method

- **NDVI** = (B08 − B04) / (B08 + B04). Each month takes up to three of the
  clearest passes, masks cloud, shadow and snow with the scene
  classification band, and keeps the highest NDVI per pixel. Taking several
  passes matters: a pass the classification calls clear can still be hazy.
- **Anomaly**: a month minus the mean of the same calendar month over
  2019–2023.
- **Trend** and **change** use July–September only. The grass layer is dry
  then, so NDVI mostly reflects tree canopy.
- **Change polygons**: patches of at least 3 ha where summer NDVI moved by
  0.12 or more between the median of the first three summers and the latest
  one. Confidence compares the movement with the spread of change across the
  forest and is cut by up to 40% where the previous summer does not show the
  change too.

Rasters are 8 bit PNGs on a Web Mercator grid of about 70 m (0 = no data,
1–255 = NDVI −0.2 to 1.0). The page decodes and colours them in the browser,
which is what lets it difference any two months.

## Limits

- NDVI measures greenness, not tree health or species. A loss polygon can be
  a eucalyptus harvest, a fire, dieback, clearing or drought stress.
- The forest outline is OpenStreetMap data via Overture Maps, not the
  official forestry boundary, and includes eucalyptus, pine and acacia
  plantations.
- The "normal" covers five years, which is short and includes dry years.
- Nothing has been checked on the ground.

## Run it

```bash
pip install -r maamora/pipeline/requirements.txt
python maamora/pipeline/run_workflow.py
```

Months already in `data/ndvi/` are reused and only the last two are rebuilt
(`MAAMORA_REFRESH` changes that). A full rebuild from 2019 reads about 300
scenes and takes around 40 minutes.
`.github/workflows/maamora-ndvi.yml` runs it on Mondays and Thursdays and
commits the result to `main`.

## Sources

- Copernicus Sentinel-2 L2A, read from the
  [Element 84 COG archive on AWS](https://registry.opendata.aws/sentinel-2-l2a-cogs/)
- [Overture Maps](https://overturemaps.org/) land polygons (OpenStreetMap contributors)
- Basemaps: CARTO, Esri World Imagery
