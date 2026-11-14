# Dakhla Urban Observatory

A guided 3D presentation of Dakhla, zone by zone: population, density,
built-up land, streets, and six years of vegetation measured from
satellite imagery.

**▶ Presentation: [`index.html`](index.html)** — served by GitHub Pages at
`/observatory/`.

The format follows the "present" view of the
[Urban Observatory](https://obs.autos/) platform by Mohamed Abdelrahman
Ebrahim: a stylised 3D city, a seven-scene tour with play / pause / step,
a choropleth with an indicator switcher, a ranking that reorders itself, a
year timeline, and a Simulation / Map toggle. The code, visual design and
data here are separate work; nothing is copied from that site.

It is a static page: no build step, no server, no API keys. The Simulation
view draws land, streets, buildings, zones and vegetation from files in this
repository and needs no basemap service. The Map view adds a CARTO raster
basemap under the same zones.

## Why the indicators differ from the Amsterdam example

Amsterdam publishes statistics for every district, every year. Dakhla
publishes neither neighbourhood boundaries nor neighbourhood statistics, so
nothing here is copied from a statistical office. Every figure is computed
from open data, and the page says which are modelled and which are measured.

| Indicator | Unit | Years | How |
|---|---|---|---|
| Population | people | 2024 | **Modelled.** RGPH 2024 city total (161,723) shared out by residential building volume |
| Population density | people per km² | 2024 | Modelled population over zone area |
| Built-up land | % of zone under roofs | 2026 | Overture Maps building footprints |
| Street density | km per km² | 2026 | Overture Maps road segments |
| Vegetation cover | % of zone | 2021–2026 | **Measured.** Sentinel-2 spring NDVI ≥ 0.20, 10 m pixels |
| Vegetation per person | m² per person | 2024 | Vegetated area over modelled population |

Only vegetation has a year-by-year record, so the timeline plays for
vegetation and is pinned to one year for the rest. Public-transport access
and PM2.5 from the Amsterdam example are left out: Dakhla has no open
transit data, and the air-quality models are far coarser than a zone.

## Zones

The 18 zones are analysis units, not administrative districts. Building
footprints are clustered (k-means on centroids), each cluster takes the land
nearest its centre, and the result is clipped to within 220 m of the
buildings. Zones are numbered south to north and named after their longest
named street, or their distance and bearing from the centre of the built
city.

## Limits worth knowing

- Population per zone is a model, not a census count. A zone with few but
  very large footprints (warehouses, compounds tagged only as "building")
  gets more people than it should.
- The building layer is coarse: 3,953 footprints for the whole city, many of
  them whole blocks. Areas and volumes are more reliable than counts.
- Vegetation is what a 10 m pixel sees in March–May. Gardens and single
  trees fall below it. City-wide cover moves between 1.46 % and 1.76 %
  across the six years, close to the year-to-year noise of the method, so
  read zone differences rather than small trends.
- Building heights are stretched ×3 in the 3D view.

## Rebuilding the data

```bash
pip install -r observatory/pipeline/requirements.txt
python observatory/pipeline/01_build_zones.py            # zones + population, built-up, streets
python observatory/pipeline/02_vegetation_sentinel2.py   # Sentinel-2 → vegetation per zone and year
python observatory/pipeline/03_scene_land.py             # Overture coastline for the 3D scene
python -m http.server                                     # then http://localhost:8000/observatory/
```

`01` uses layers already in the repository (`data/processed/` and
`dakhla/data/`). `02` reads Sentinel-2 L2A Cloud-Optimised GeoTIFFs from the
public `sentinel-cogs` bucket on AWS (tile 28QDM, about 120 scenes, two
minutes). `03` reads the Overture coastline from S3.

## Credits

Buildings, streets, coastline: © Overture Maps Foundation and OpenStreetMap
contributors. Imagery: Copernicus Sentinel-2 (ESA), via the Element 84
`sentinel-cogs` open data bucket. City population: RGPH 2024. Basemap in Map
view: CARTO. Map engine: [MapLibre GL JS](https://maplibre.org)
(BSD-3-Clause, vendored in `/vendor`). Presentation format inspired by
[Urban Observatory](https://obs.autos/).
