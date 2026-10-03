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
It extracts four categories: **Building** and **Water** as polygons, **Road**
and **Railway** as lines. Where Overture gives you somebody else's extraction
of somebody else's imagery, MARS lets you run the extraction yourself against
imagery you choose — a specific date, a specific sensor, a specific part of
the peninsula.

`scripts/01b_fetch_mars_footprints.py` in this repo drives it end to end and
writes the buildings layer in the pipeline's own schema.

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
   [GeoAI SDK](https://azure.github.io/microsoft-planetary-computer-pro/geoai/geoai-sdk/README.html),
   which is what `scripts/01b_fetch_mars_footprints.py` wraps. The SDK is not
   on PyPI — install it from a release wheel or from a clone of the
   [Planetary Computer Pro repo](https://github.com/Azure/microsoft-planetary-computer-pro):

   ```bash
   pip install ./microsoft-planetary-computer-pro/tools/geoai-sdk
   ```

   Note that the SDK only enforces its `naip` collection restriction against
   the *public* Planetary Computer. A private GeoCatalog may use any
   collection name, which is what makes Dakhla possible at all — NAIP is
   United States imagery.

5. **Point the script at your resources** and price the job before spending a
   GPU hour:

   ```bash
   export MARS_ENDPOINT="https://<name>.<region>.inference.ml.azure.com/score"
   export MARS_API_KEY="..."                      # or use Azure AD
   export PCPRO_GEOCATALOG_URI="https://<your-geocatalog>/stac"
   export PCPRO_IMAGERY_COLLECTION="<your-imagery-collection>"
   export PCPRO_STORAGE_URL="https://<account>.blob.core.windows.net"
   export PCPRO_BLOB_CONTAINER="mars-results"

   python scripts/01b_fetch_mars_footprints.py --estimate-only
   ```

   `--estimate-only` reports chip count, imagery found, and estimated
   duration without calling the model. If it finds zero STAC items, your
   collection does not cover the bbox at the requested date range and ground
   sample distance — fix that before running inference.

6. **Run it for real**, carrying heights and building classes over from the
   existing Overture layer:

   ```bash
   python scripts/01b_fetch_mars_footprints.py \
       --heights-from data/processed/dakhla_buildings_3d.geojson
   ```

   Output goes to `data/processed/dakhla_buildings_mars.geojson`. Compare it
   against the Overture layer, then re-run with `--replace-overture` to make
   steps 02 and 03 use it.

The default bbox is the one at the top of
`scripts/01_fetch_overture_geometry.py`:
`(-16.02, 23.62, -15.86, 23.80)`. Override it with `--bbox W S E N` to run
only the dense old-town blocks, which is the cheaper and more defensible
option.

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

`scripts/01b_fetch_mars_footprints.py` does this transfer with
`--heights-from`: it intersects each MARS footprint against the Overture
layer in UTM 28N and takes the attributes of the building it overlaps most,
falling back to 4.5m and class `yes` for anything unmatched. It prints the
match rate, which is worth reading — a low one means the two layers disagree
about where buildings are, which is either the point of running MARS or a
sign your imagery is misregistered.

The script is deliberately a sibling rather than an Azure branch inside the
Overture script, so steps 02 and 03 run unchanged on whichever source
produced the layer.

`--include-roads` saves MARS road and railway centrelines to
`dakhla_mars_roads.geojson` in the same run. They do **not** drop into the
walkable network layer as-is: the pipeline filters on Overture's `class`
attribute to exclude motorways and trunk roads, and MARS returns geometry
with no road classification at all.

## References

- [MARS on Microsoft Foundry](https://ai.azure.com/catalog/models/mars-map-autoregressive)
- [MARS: A Foundational Map Auto-Regressor (OpenReview)](https://openreview.net/forum?id=QV4sV5cbLl)
- [GeoAI SDK documentation](https://azure.github.io/microsoft-planetary-computer-pro/geoai/geoai-sdk/README.html)
- [Planetary Computer Pro on Microsoft Learn](https://learn.microsoft.com/en-us/azure/planetary-computer/)
