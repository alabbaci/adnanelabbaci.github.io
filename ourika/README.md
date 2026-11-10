# Ourika Watch

Live situational awareness for the **Ourika watershed** in Morocco's High
Atlas: flash-flood watch, rain and snow forecasts, river discharge,
earthquakes and daily satellite imagery on one 3D terrain map.

**▶ Dashboard: [`index.html`](index.html)** — served by GitHub Pages at
`/ourika/`.

Adapted from [simplifaisoul/osiris](https://github.com/simplifaisoul/osiris),
an open-source global intelligence dashboard (Next.js, MapLibre GL, MIT).
OSIRIS watches the whole planet through server-side API routes. This version
keeps the idea — toggleable live layers over a GPU-rendered map, a heads-up
display, a click-through intel panel — and rebuilds it for one basin, as a
static site with no server, no build step and no API keys.

## Why the Ourika

The Ourika drains the north face of the High Atlas towards Marrakech. Above
the Aghbalou gauge the basin is small, steep and fast: the delineation here
gives 501.7 km² between 993 m and 4,000 m, with a 50 km main stem falling
at 5.4 % on average. Storm rain reaches the valley floor, where the
villages, the road and the summer visitors are, within an hour or two. The
flash flood of 17 August 1995 is the reference disaster for the valley.

## What is on the map

| Layer | Source | Live? |
|---|---|---|
| Watershed boundary, 12 sub-basins, river network, long profile, hypsometry | Copernicus GLO-30 DEM, D8 routing (`pipeline/01`) | static |
| Villages, roads, points of interest, buildings near channels | Overture Maps (`pipeline/02`) | static |
| Flash-flood watch, rain, snow depth, freezing level, wind | [Open-Meteo](https://open-meteo.com) forecast, one point per sub-basin at its mean elevation | every 15 min |
| River discharge at Aghbalou | GloFAS via Open-Meteo Flood API | every 3 h |
| Earthquakes (365 days, M 2.5+) and historic M 5+ within 300 km | USGS FDSN catalogue | every 5 min |
| Snow cover and true-colour imagery | NASA GIBS (MODIS Terra), date stepper | daily |
| 3D terrain and relief shading | Mapzen terrarium tiles on AWS | — |

Click a sub-basin for its forecast, exposure and villages. Click anywhere
else (or right-click) for a point forecast. Sub-basins can be coloured by
watch level, 24 h rain, 72 h rain or snow depth.

## Watch levels

Each sub-basin is screened on forecast rain over the next 48 hours; the
level is the highest any rule reaches.

| Level | 1 h | 3 h | 24 h |
|---|---|---|---|
| WATCH | ≥ 5 mm | ≥ 10 mm | ≥ 20 mm |
| ALERT | ≥ 10 mm | ≥ 20 mm | ≥ 40 mm |
| SEVERE | ≥ 20 mm | ≥ 35 mm | ≥ 70 mm |

These are screening thresholds for steep terrain, set in `LEVELS` at the top
of `app.js`. They are **not calibrated against gauges and not an official
warning**. For decisions, follow the Direction Générale de la Météorologie
and the Tensift basin agency (ABHT).

## Limits worth knowing

- Everything live is **model output**, not gauge or radar data. A global
  model at roughly 10 km resolution smooths convective storms, which are exactly
  what causes Ourika floods; expect it to under-read peak intensities.
- GloFAS runs on a ~5 km cell. On a 500 km² basin it follows trends but its
  absolute discharge is rough (it reads well under 1 m³/s in dry spells).
- "Buildings near channels" counts Overture footprints within 60 m of a
  channel draining at least 20 km². It is a proximity count, not a
  hydraulic flood map.
- Sub-basin labels use the largest mapped locality inside each unit; they
  are orientation aids, not official names.

## Rebuilding the static layers

```bash
pip install -r ourika/pipeline/requirements.txt
python ourika/pipeline/01_delineate_watershed.py     # DEM → basin, sub-basins, rivers
python ourika/pipeline/02_fetch_overture_context.py  # Overture → villages, roads, exposure
python -m http.server                                 # then http://localhost:8000/ourika/
```

`01` downloads two Copernicus tiles (~80 MB, cached in `pipeline/.cache/`),
fills depressions, routes flow and snaps the outlet to the main stem at
Aghbalou. The result, 501.7 km², sits within 0.3 % of the ~503 km² usually
quoted for the basin at that gauge. Sub-basins are cut where a tributary
draining more than 12 km² meets the main stem.

`02` reads Overture GeoParquet straight from S3 (anonymous). Set
`OVERTURE_RELEASE` if the pinned release has been retired.

## What was left out of OSIRIS

Flight and ship tracking, CCTV, news streams, the RECON toolkit (port scan,
WHOIS, sanctions, crypto tracing), Telegram feeds and the AI forecasting
engine. They need a server or keys, and none of them says anything about a
mountain catchment.

## Credits

Elevation: Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence
and Space GmbH 2014–2018, provided under COPERNICUS by the European Union
and ESA. Places, roads, buildings: © Overture Maps Foundation and
OpenStreetMap contributors. Weather and discharge: Open-Meteo (CC BY 4.0),
GloFAS / Copernicus Emergency Management Service. Earthquakes: USGS.
Imagery: NASA GIBS; Esri World Imagery. Basemaps: CARTO, OpenTopoMap.
Map engine: [MapLibre GL JS](https://maplibre.org) (BSD-3-Clause, vendored
in `/vendor`).
