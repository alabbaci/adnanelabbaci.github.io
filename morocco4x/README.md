# Morocco 4X

The real Morocco drawn the way a 4X strategy game draws its world: a board of
hexagons with terrain, cities with banners, resources on tiles, a bar of
national yields and a set of data lenses. Nothing on it is invented; every
hex, city and number comes from a public source.

**Open it:** [`index.html`](index.html) (served by GitHub Pages at `/morocco4x/`).

Inspired by Andrej Karpathy's [usaciv](https://karpathy.ai/usaciv/), which does
this for the United States. The code here is written from scratch and the look
is its own.

## What is on the map

| | |
|---|---|
| Board | 59,095 hexes of 8 km (55.4 km² each) in an equal-area projection; 12,338 of them are Morocco |
| Terrain | Farmland, steppe, scrub, desert; hills, mountains, snow line; forest, oasis, town, marsh |
| Cities | 166 cities and urban communes with their 1994, 2004, 2014 and 2024 census populations |
| Units | 12 regions and 75 provinces and prefectures |
| Yields | Population, food, production, GDP, schooling, tourist nights, unemployment |
| Lenses | 16 statistical lenses (by region or province) and 4 land lenses (by hex) |
| Resources | 134 sites: mines, power plants, dams, ports, fishing ports, airports, World Heritage sites, produce, industry |
| Lines | Motorways, main roads, railways and rivers |

Controls are in the Help panel (`?`). The link in the address bar always
reopens the exact view, lens and selection. The **Almanac** inside the map
explains every definition and lists every source.

## How the terrain is decided

Each hex aggregates the pixels inside it from two rasters and applies fixed rules
(`pipeline/01_terrain.py`):

- **ESA WorldCover 2021** (10 m, read at its 320 m overview): desert when bare
  ground is 60% or more; farmland when cropland is 30% or more and leads;
  otherwise the largest of grass or shrub. Forest at 28% tree cover, oasis when
  crops and trees reach 5% of a desert hex, town at 10% built-up.
- **SRTM-based terrain tiles** (about 0.5 km): hills when the standard deviation
  of elevation is 55 m or more, mountains at 150 m (or above 1,800 m with 95 m),
  snow line when a mountain hex reaches 3,300 m. Shading is a real hillshade.

## Data and sources

| Source | Used for |
|---|---|
| HCP, RGPH 2024 census (via the citypopulation.de compilation for cities and provinces) | Populations, urban share, households, census unemployment, illiteracy, schooling |
| HCP, regional accounts 2024 | GDP, value added by sector, GDP and household spending per head |
| HCP, employment survey 2024 | Unemployment and activity rates (the three southern regions are published as one group) |
| HCP, poverty mapping 2024 and living-standards survey 2022 | Multidimensional and monetary poverty |
| Ministry of Tourism | Nights in tourist accommodation by region |
| ESA WorldCover 2021 v200 (CC BY 4.0) | Land cover |
| Mapzen / Tilezen terrain tiles on AWS | Elevation, sea depth |
| geoBoundaries gbOpen MAR ADM1 / ADM2 | Region and province outlines |
| Overture Maps 2026-11-18.0 (OpenStreetMap and partners) | Roads, railways, rivers, city coordinates |
| Natural Earth | Neighbouring countries |
| Global Energy Monitor, Mindat, UNESCO, ANP, ONP, ONDA, Wikipedia / Wikidata, press | Resource positions and figures; each site carries its own link |

The transcribed tables, with a source URL on every indicator and every site, are
in [`pipeline/sources/`](pipeline/sources).

### Known limits

- Most economic and social statistics exist by region only. A city screen shows
  the city's own census history and its region's figures; nothing is apportioned
  down to cities.
- The six largest cities are whole cities; the rest are single urban communes,
  so a suburb that is its own commune appears as its own city. Two communes
  (Ras El Mae, Oulad Belaaguid) are left out for lack of reliable coordinates.
- The Unemployment lens uses the census rate (available for all 12 regions),
  which is higher than the survey rate shown in the top bar.
- A few regional census values (illiteracy, census unemployment, schooling) were
  read from charts in the HCP results note, not from a table; they are flagged
  `chart_only` in `pipeline/sources/regions_stats.json`.
- Resources are a curated selection. Entries marked lower-confidence have an
  approximate position or a figure taken from a secondary summary. Figures carry
  their own year, and years differ between sites.
- The board covers the 12 regions for which HCP publishes statistics. Laâyoune-Sakia
  El Hamra, Dakhla-Oued Ed-Dahab and part of Guelmim-Oued Noun lie in Western
  Sahara, whose status is disputed; the figures shown for them are the Moroccan
  official ones. The Almanac says the same.

## Rebuilding the data

```bash
pip install -r morocco4x/pipeline/requirements.txt
```

```bash
python morocco4x/pipeline/01_terrain.py
```

```bash
python morocco4x/pipeline/02_lines.py
```

```bash
python morocco4x/pipeline/03_places.py
```

The first two download into `pipeline/.cache/` (terrain tiles, WorldCover
overviews, boundaries, Overture extracts; a few minutes, about 60 MB). The third
only reads the committed tables in `pipeline/sources/` and the grid from step 1.
Outputs are `data/world.json`, `data/lines.json` and `data/places.json`.

## Running locally

The page is static: plain ES modules and a 2D canvas, no build step and no
external requests.

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/morocco4x/`.

## Layout

```
index.html, css/style.css
js/main.js      camera, input, frame loop, shareable link
js/render.js    hex terrain, drawn into cached tiles at eight zoom levels
js/overlay.js   banners, resource badges, lettering, outlines, minimap
js/world.js     data loading, lenses, lookups
js/ui.js        yields bar, lens dock, legend, tooltip, search, share
js/panels.js    city, region, province and resource screens
js/almanac.js   definitions and sources
pipeline/       the three build scripts and their source tables
data/           built files read by the page
```
