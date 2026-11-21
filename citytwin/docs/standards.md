# Standards: what is implemented, what is not

The value of a digital twin is that other systems can consume it. This page states
precisely which specifications are implemented, so that a partner can check the claim
instead of trusting it.

## Implemented

| Standard | Where | Status |
|---|---|---|
| **OGC API — Features Part 1 (Core)** | `api/main.py` | Landing page, conformance, collections, items, single feature, GeoJSON |
| OGC API — Features Part 2 (CRS) | `api/main.py` | `crs` and `bbox-crs` parameters; storage CRS EPSG:4326 |
| OGC API — Features Part 3 (Queryables) | `/collections/{id}/queryables` | JSON Schema per collection |
| **CityJSON 1.1** | `exporters/cityjson.py` | LoD1 `Solid` per building, closed shells, `metadata.referenceSystem` |
| **3D Tiles 1.1** | `exporters/tiles3d.py` | `tileset.json`, GLB with `BATCHID`, EPSG:4978 region bounding volume |
| **PROV-JSON (W3C PROV)** | `provenance.py` | Entities, activities, agents; sha256 per artefact |
| EPSG:4326 / 32628 / 4978 | `config.py` | Geographic, metric (WGS 84 / UTM 28N), ECEF for 3D Tiles |

## Deliberately not implemented

| Standard | Why | What a reviewer should expect |
|---|---|---|
| OGC API — Features Part 4 (Create/Replace/Update/Delete) | The twin is read-only by design; there is no write path into the city | No transaction endpoints; `405` on POST |
| OGC API — Features Part 3 **CQL2** | Property filters are exposed as plain query parameters, not as a filter language | `?building_class=house` works; `?filter=...` does not |
| OGC API — Tiles / Maps / Processes | Out of scope for this prototype; 3D Tiles covers the 3D delivery | No `/tiles` endpoints |
| CityGML 3.0 / CityJSON 2.0 | CityJSON 1.1 is what the current toolchain reads | `metadata.cityjsonVersion` is 1.1 |
| 3D Tiles metadata / styling extensions | The single-tile prototype does not need them yet | Colours are baked into vertex colours |
| SensorThings API | Planned ingestion path for weather-station and low-cost sensor observations | Not present; see roadmap |
| STAC | Planned catalogue for derived artefacts | Not present; see roadmap |

## CityJSON details

- `metadata.referenceSystem` is `https://www.opengis.net/def/crs/EPSG/0/4979`-style
  URI pointing at EPSG:32628 with ellipsoidal heights.
- Each building is one `Solid`: one shell, `n+2` surfaces (ground, `n` walls, roof),
  every edge used exactly twice. `validate_cityjson` counts edges and reports any shell
  that is not closed; the build currently reports **0 open shells**.
- Attributes: `gers_id`, `building_class`, `area_m2`, `height_final_m`,
  `height_provenance`, `height_uncertainty_m`, `cell_hei`, `typology`.
- Semantic surfaces are typed `GroundSurface`, `WallSurface`, `RoofSurface`; LoD is 1.

## 3D Tiles details

- `asset.version` is `1.1`, `geometricError` in metres, one tile with a `region`
  bounding volume in radians (west, south, east, north, min height, max height).
- The GLB is encoded by a small writer in `tiles3d.py` (no trimesh/pygltflib): one
  buffer, interleaved positions and colours, `BATCHID` accessor for picking.
- Round-trip verification (`validate_glb`) checks chunk lengths, accessor counts,
  component types and that vertices are finite.

## CRS chain

```
EPSG:4326  (Overture, API payloads)
   │  to_crs(32628)
EPSG:32628 (metric analysis: grid, areas, distances)
   │  to_crs(4326) + ellipsoidal height
EPSG:4979  (CityJSON vertices)
   │  geodetic → ECEF
EPSG:4978  (3D Tiles positions from the tileset transform)
```

The metric CRS is WGS 84 / UTM zone 28N, the UTM zone Dakhla falls in (15.9° W). The
250 m grid is aligned to its origin, so cells keep their identifiers across builds and
can be joined to any other UTM 28N raster or table.
