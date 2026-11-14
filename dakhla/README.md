# Dakhla Watch

Live situational awareness for **Dakhla**, its peninsula and the lagoon
behind it: wind, heat, rain and swell watch, sea state, Saharan dust,
earthquakes and daily satellite imagery on one 3D map.

**▶ Dashboard: [`index.html`](index.html)** — served by GitHub Pages at
`/dakhla/`.

Same engine, theme, widgets and animations as [Ourika Watch](../ourika/README.md)
(itself adapted from [simplifaisoul/osiris](https://github.com/simplifaisoul/osiris)):
toggleable live layers over a GPU-rendered map, a heads-up display, a
click-through intel panel, a scrolling ticker. It is a static site with no
server, no build step and no API keys.

## What changed from the Ourika version

A mountain catchment floods and snows; a desert peninsula does not. The
layout is identical, the hazards are the ones Dakhla has.

| Ourika Watch | Dakhla Watch |
|---|---|
| Watershed, 12 sub-basins | Watch area, 11 sectors: 6 peninsula, 3 lagoon, 2 mainland shore |
| River network | Atlantic and lagoon shorelines |
| Flash-flood watch on rain | Coastal watch on gusts, air temperature, rain and waves |
| Rain chart | Wind chart: mean wind with the gust envelope |
| River discharge (GloFAS) | Sea state: waves, swell, sea temperature, tide (Open-Meteo marine) |
| Snow line | Heat & dust: temperature spread, desert wind hours, CAMS dust |
| Buildings near channels | Buildings within 150 m of a shoreline |
| Snow cover (MODIS) | Sea-surface temperature (MUR) |
| Long profile, hypsometry | Spine profile tip to neck, area per 5 m band |

New here: 3D buildings (the footprints already used by the heat-trap scene
at the site root) and a **City** view button.

## What is on the map

| Layer | Source | Live? |
|---|---|---|
| Watch area, sectors, shoreline | Overture Maps coastline, sliced along the peninsula axis (`pipeline/01`) | static |
| Elevation stats, spine profile | Copernicus GLO-30 DEM (`pipeline/01`) | static |
| Localities, landmarks, roads, points of interest, buildings near shore | Overture Maps (`pipeline/02`) | static |
| 3D buildings | `data/processed/dakhla_buildings_3d.geojson` (site root pipeline) | static |
| Coastal watch, wind, temperature, rain | [Open-Meteo](https://open-meteo.com) forecast, one point per sector | every 15 min |
| Waves, swell, sea temperature, tide | Open-Meteo marine API, one open-Atlantic point | hourly |
| Dust, PM10, aerosol depth | CAMS via Open-Meteo air-quality API | hourly |
| Earthquakes (365 days, M 2.5+) and historic M 5+ within 700 km | USGS FDSN catalogue | every 5 min |
| Sea-surface temperature and true-colour imagery | NASA GIBS (MUR, MODIS Terra), date stepper | daily |
| 3D terrain and relief shading | Mapzen terrarium tiles on AWS | — |

Click a sector for its forecast, exposure and places. Click anywhere else
(or right-click) for a point forecast. Sectors can be coloured by watch
level, peak gust, warmest hour or rain.

## Watch levels

Each sector is screened on the forecast for the next 48 hours; the level is
the highest any rule reaches. The wave rule applies to the six peninsula
sectors, which face the open Atlantic.

| Level | Gust | Air temp. | Rain 24 h | Waves |
|---|---|---|---|---|
| WATCH | ≥ 55 km/h | ≥ 32 °C | ≥ 5 mm | ≥ 3 m |
| ALERT | ≥ 70 km/h | ≥ 36 °C | ≥ 15 mm | ≥ 4 m |
| SEVERE | ≥ 90 km/h | ≥ 40 °C | ≥ 30 mm | ≥ 5.5 m |

These are screening thresholds for an exposed, arid coast, set in `LEVELS`
at the top of `app.js`. They are **not calibrated against stations and not
an official warning**. For decisions, follow the vigilance bulletins of the
Direction Générale de la Météorologie and the port authority's notices.

## Limits worth knowing

- Everything live is **model output**, not station, buoy or tide-gauge
  data. Eleven sectors sit on only a handful of model grid cells, so
  neighbours often read alike.
- Waves, sea temperature and tide come from one open-ocean cell west of the
  city. The lagoon is sheltered and is not modelled; tide times are hourly
  and not for navigation.
- The peninsula tops out near 31 m. The 3D view stretches relief ×3 and
  building heights ×3 so that they read at all.
- "Buildings near shore" is a 150 m proximity count on Overture footprints,
  not a flood or erosion map. The DEM is too coarse this close to sea level
  to rank buildings by height.
- Sector labels use the main Overture locality or landmark inside each
  unit, or its distance along the peninsula. They are orientation aids, not
  official names.
- Seismicity here is very low; the list is often empty. The nearest active
  zone is the Canary Islands.

## Rebuilding the static layers

```bash
pip install -r dakhla/pipeline/requirements.txt
python dakhla/pipeline/01_build_study_area.py        # coastline + DEM → area, sectors, shoreline
python dakhla/pipeline/02_fetch_overture_context.py  # Overture → places, roads, exposure
python -m http.server                                 # then http://localhost:8000/dakhla/
```

`01` reads the Overture land polygons and one Copernicus tile (~30 MB,
cached in `pipeline/.cache/`). It measures everything along a straight axis
from the southern tip of the peninsula to the head of the lagoon: land west
of the lagoon is the peninsula (89.7 km², 38.8 km long, 2.3 km wide on
average), the water it encloses is the lagoon (417 km²), and a 4 km strip
of the facing mainland closes the watch area.

`02` reads Overture GeoParquet straight from S3 (anonymous). Set
`OVERTURE_RELEASE` if the pinned release has been retired.

## Credits

Elevation: Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence
and Space GmbH 2014–2018, provided under COPERNICUS by the European Union
and ESA. Coastline, places, roads, buildings: © Overture Maps Foundation
and OpenStreetMap contributors. Weather, marine and air quality: Open-Meteo
(CC BY 4.0), CAMS / Copernicus Atmosphere Monitoring Service. Earthquakes:
USGS. Imagery: NASA GIBS; Esri World Imagery. Basemaps: CARTO, OpenTopoMap.
Map engine: [MapLibre GL JS](https://maplibre.org) (BSD-3-Clause, vendored
in `/vendor`).
