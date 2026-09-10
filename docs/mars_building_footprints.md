# Better Building Footprints with MARS (Microsoft Foundry)

`scripts/01_fetch_overture_geometry.py` gets Dakhla's building footprints
from Overture Maps, which is free, needs no credentials, and already blends
OSM with Microsoft/Google ML-detected footprints. That is the right default.
It is also the weakest link in this pipeline: coverage of Dakhla's informal
and low-rise fabric is uneven, and the `README` caveat about heights applies
to footprints too — what the density proxy and the dasymetric population
model both rest on is *which polygons exist*.

MARS (Map Auto-Regressor) is Microsoft's foundation model for turning
high-resolution RGB satellite imagery into production-ready vector layers.
Where Overture gives you somebody else's extraction of somebody else's
imagery, MARS lets you run the extraction yourself against imagery you
choose — a specific date, a specific sensor, a specific part of the
peninsula.

## Whether it is worth it here

It is not a drop-in upgrade. Three things to weigh first.

- **It costs money.** MARS wants orthorectified imagery at 25–75cm ground
  sample distance (60cm optimal). That is commercial tasking or archive
  imagery, not Sentinel-2's 10m. Inference runs on a
  `Standard_NC24ads_A100_v4` GPU VM, which needs quota in Microsoft Foundry.
- **It gives you footprints, not heights.** MARS reads RGB imagery, so it
  returns 2D vector geometry. `calculated_height` still has to come from
  Overture's `height`/`num_floors` attributes, a DSM, or the 4.5m low-rise
  default. Swapping in MARS improves *which* buildings the pipeline sees,
  not how tall it thinks they are.
- **Dakhla is small.** 3,953 buildings over a compact peninsula. A targeted
  run over the dense old-town blocks — the ones the whole heat-exposure
  argument turns on — is a far better use of a GPU hour than the full bbox.

If you want a footprint upgrade without an Azure bill, check whether the
Overture release already carries newer Microsoft ML footprints for the area
before reaching for MARS.

## Running it

1. **Deploy the model.** Get MARS from the
   [Microsoft Foundry model catalog](https://ai.azure.com/catalog/models/mars-map-autoregressive).
   You will likely need to request GPU quota for the
   `Standard_NC24ads_A100_v4` VM first — see the
   [quota docs](https://learn.microsoft.com/en-us/azure/foundry/how-to/quota).
2. **Stand up Planetary Computer Pro.** MARS reads its input from a
   [Microsoft Planetary Computer Pro](https://azure.microsoft.com/en-us/products/planetary-computer-pro)
   GeoCatalog, not from local files.
3. **Ingest the imagery** as a STAC collection of Cloud Optimized GeoTIFFs.
   Commercial imagery for the Dakhla bbox is available through providers
   and partners such as [SkyWatch](https://skywatch.com/). Each COG should
   be RGB, with STAC metadata specifying `gsd`, projection (`proj:epsg`),
   band information (`eo:bands`), and accurate `bbox` and `geometry` fields.
4. **Run inference** with the
   [GeoAI SDK](https://azure.github.io/microsoft-planetary-computer-pro/geoai/geoai-sdk/README.html)
   against that collection. Tile at 512 × 512 pixels.
5. **Export the vector layer** and fold it into this pipeline (below).

The bbox to cover is the one at the top of
`scripts/01_fetch_overture_geometry.py`:
`(-16.02, 23.62, -15.86, 23.80)`.

## Folding the output back in

Nothing downstream needs to change if the MARS-derived layer lands at
`data/processed/dakhla_buildings_3d.geojson` in EPSG:4326 with the schema
`fetch_buildings_3d()` already produces:

| Property | Meaning |
|---|---|
| `geometry` | Polygon / MultiPolygon footprint |
| `calculated_height` | Height in meters (see caveat above) |
| `building` | Class string, used to exclude non-residential volume in step 3 |
| `subtype` | Overture subtype; may be null for MARS output |

`building` matters more than it looks. `scripts/03_integrate_demographics.py`
reads it to drop commercial, industrial and military structures before
distributing census population by residential volume. MARS output that
labels every polygon identically will push population into warehouses and
port buildings, so either carry a class attribute through from the model or
spatially join Overture's classes onto the new footprints.

The cleanest way to add this is a sibling script — `01b_fetch_mars_footprints.py`
— that writes the same two output files, rather than an Azure branch inside
the Overture script. Then step 2 and step 3 run unchanged on whichever
source produced the layer.

## References

- [MARS on Microsoft Foundry](https://ai.azure.com/catalog/models/mars-map-autoregressive)
- [MARS: A Foundational Map Auto-Regressor (OpenReview)](https://openreview.net/forum?id=QV4sV5cbLl)
- [GeoAI SDK documentation](https://azure.github.io/microsoft-planetary-computer-pro/geoai/geoai-sdk/README.html)
- [Planetary Computer Pro on Microsoft Learn](https://learn.microsoft.com/en-us/azure/planetary-computer/)
