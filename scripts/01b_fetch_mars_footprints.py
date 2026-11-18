"""
01b_fetch_mars_footprints.py

Detects building footprints over Dakhla by running Microsoft's MARS
(Map Auto-Regressor) model on high-resolution imagery, and writes the result
in the same schema `01_fetch_overture_geometry.py` produces, so steps 02 and
03 of the pipeline run unchanged on either source.

This is an *alternative* to the Overture footprints, not a replacement — see
docs/mars_building_footprints.md for when it is worth the cost. In short:
MARS needs 25-75cm RGB imagery (60cm optimal) that you have ingested into a
Microsoft Planetary Computer Pro GeoCatalog, plus a MARS endpoint deployed
from the Microsoft Foundry model catalog onto a Standard_NC24ads_A100_v4 VM.
Neither is free, and neither ships with this repo.

MARS reads RGB and returns 2D vector geometry, so it detects *where* buildings
are, not how tall they are. Use --heights-from to carry `calculated_height`
and the `building` class over from the existing Overture layer by spatial
overlap; unmatched footprints fall back to the same 4.5m low-rise default the
Overture script uses. The class attribute matters: step 03 reads it to exclude
non-residential volume before distributing census population.

Requirements: the GeoAI SDK, which is not on PyPI. Install it from a release
wheel or from a clone of the Planetary Computer Pro repo:

    pip install geoai_sdk-0.1.0-py3-none-any.whl
    # or
    git clone https://github.com/Azure/microsoft-planetary-computer-pro.git
    pip install ./microsoft-planetary-computer-pro/tools/geoai-sdk

Configuration comes from flags or environment variables:

    MARS_ENDPOINT          https://<name>.<region>.inference.ml.azure.com/score
    MARS_API_KEY           endpoint key; omit to use Azure AD instead
    PCPRO_GEOCATALOG_URI   https://<your-geocatalog>/stac
    PCPRO_IMAGERY_COLLECTION   STAC collection holding your RGB COGs
    PCPRO_STORAGE_URL      https://<account>.blob.core.windows.net
    PCPRO_BLOB_CONTAINER   container for chips and result assets

Typical use — price the job before spending a GPU hour, then run it:

    python scripts/01b_fetch_mars_footprints.py --estimate-only
    python scripts/01b_fetch_mars_footprints.py \
        --heights-from data/processed/dakhla_buildings_3d.geojson
"""

import argparse
import asyncio
import os
import sys

import geopandas as gpd

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUTPUT_DIR = os.path.join(ROOT, "data", "processed")

# Dakhla, Western Sahara — same peninsula bbox as 01_fetch_overture_geometry.py.
# (lon_min, lat_min, lon_max, lat_max)
BBOX = (-16.02, 23.62, -15.86, 23.80)

# Keep in sync with 01_fetch_overture_geometry.py: Dakhla is predominantly
# low-rise, and MARS gives us no height at all, so every unmatched footprint
# lands on this default.
DEFAULT_HEIGHT_M = 4.5

# UTM 28N — the CRS 02_generate_heat_grid.py uses for metric work.
METRIC_CRS = "EPSG:32628"

# MARS labels its output Building / Road / Railway / Water.
BUILDING_LABEL = "Building"
ROAD_LABELS = ("Road", "Railway")


def parse_args():
    p = argparse.ArgumentParser(
        description="Detect Dakhla building footprints with the MARS model.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    p.add_argument(
        "--endpoint",
        default=os.getenv("MARS_ENDPOINT"),
        help="MARS scoring endpoint URL [env: MARS_ENDPOINT]",
    )
    p.add_argument(
        "--geocatalog-uri",
        default=os.getenv("PCPRO_GEOCATALOG_URI"),
        help="Planetary Computer Pro STAC endpoint [env: PCPRO_GEOCATALOG_URI]",
    )
    p.add_argument(
        "--collection",
        default=os.getenv("PCPRO_IMAGERY_COLLECTION"),
        help="STAC collection holding the input RGB COGs [env: PCPRO_IMAGERY_COLLECTION]",
    )
    p.add_argument(
        "--storage-url",
        default=os.getenv("PCPRO_STORAGE_URL"),
        help="Blob storage account URL for results [env: PCPRO_STORAGE_URL]",
    )
    p.add_argument(
        "--blob-container",
        default=os.getenv("PCPRO_BLOB_CONTAINER"),
        help="Blob container for chips and assets [env: PCPRO_BLOB_CONTAINER]",
    )
    p.add_argument(
        "--results-collection",
        default="dakhla-mars-footprints",
        help="GeoCatalog collection to publish the run into",
    )

    p.add_argument(
        "--bbox",
        type=float,
        nargs=4,
        metavar=("W", "S", "E", "N"),
        default=list(BBOX),
        help="Area of interest in WGS84",
    )
    p.add_argument(
        "--datetime",
        default="2023-01-01/..",
        help="STAC temporal filter (ISO 8601 instant or range)",
    )
    p.add_argument(
        "--max-gsd",
        type=float,
        default=0.75,
        help="Reject imagery coarser than this ground sample distance, in meters",
    )

    p.add_argument("--chip-size", type=int, default=512, help="Tile size in pixels")
    p.add_argument("--stride", type=int, default=448, help="Tile stride in pixels")
    p.add_argument(
        "--threshold", type=float, default=0.6, help="Model confidence threshold"
    )
    p.add_argument(
        "--min-score",
        type=float,
        default=0.0,
        help="Drop returned features scoring below this (0 keeps everything)",
    )
    p.add_argument(
        "--num-instances", type=int, default=1, help="Deployed endpoint instances"
    )
    p.add_argument(
        "--concurrent-per-instance",
        type=int,
        default=1,
        help="Max concurrent requests per instance",
    )

    p.add_argument(
        "--heights-from",
        metavar="GEOJSON",
        help="Copy calculated_height and building class from this layer by overlap",
    )
    p.add_argument(
        "--include-roads",
        action="store_true",
        help="Also request Road and Railway and save them alongside the buildings",
    )
    p.add_argument(
        "--replace-overture",
        action="store_true",
        help="Overwrite dakhla_buildings_3d.geojson instead of writing a separate file",
    )
    p.add_argument(
        "--estimate-only",
        action="store_true",
        help="Report chip count and imagery availability, then exit without inference",
    )

    return p.parse_args()


def require(args, names, why):
    """Fail early and legibly rather than deep inside an Azure client."""
    missing = [n for n in names if not getattr(args, n.replace("-", "_"))]
    if missing:
        flags = ", ".join(f"--{n}" for n in missing)
        sys.exit(f"error: {flags} required {why}")


def resolve_credentials():
    """Endpoint key if one is set, Azure AD for everything else."""
    try:
        from azure.identity import DefaultAzureCredential
    except ImportError:
        sys.exit(
            "error: azure-identity not installed — see the module docstring for "
            "GeoAI SDK installation"
        )

    azure_credential = DefaultAzureCredential()
    model_credential = os.getenv("MARS_API_KEY") or azure_credential
    return model_credential, azure_credential


def build_job(geoai, args):
    """Assemble the SDK's Input / Constraint / model objects."""
    model_credential, azure_credential = resolve_credentials()

    input_source = geoai.Input(
        collection=args.collection,
        geocatalog_uri=args.geocatalog_uri,
        credential=azure_credential,
    )

    constraint = geoai.Constraint(
        bbox=list(args.bbox),
        datetime=args.datetime,
        filter={"gsd": {"lte": args.max_gsd}},
    )

    categories = [BUILDING_LABEL]
    if args.include_roads:
        categories.extend(ROAD_LABELS)

    params = {
        "chip_size": args.chip_size,
        "stride": args.stride,
        "threshold": args.threshold,
        "categories": categories,
    }

    model = geoai.models.MARS(
        endpoint=args.endpoint,
        credential=model_credential,
        num_instances=args.num_instances,
        concurrent_per_instance=args.concurrent_per_instance,
    )

    return model, input_source, constraint, params, azure_credential


def to_gdf(feature_collection, labels) -> gpd.GeoDataFrame:
    """MARS returns WGS84 features carrying `score` and `label` properties."""
    features = (feature_collection or {}).get("features", [])
    if not features:
        return gpd.GeoDataFrame(
            {"label": [], "score": []}, geometry=[], crs="EPSG:4326"
        )

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    if "label" not in gdf.columns:
        gdf["label"] = "unknown"
    if "score" not in gdf.columns:
        gdf["score"] = 0.0

    return gdf[gdf["label"].isin(labels)].copy()


def attach_overture_attributes(buildings: gpd.GeoDataFrame, reference_path: str):
    """
    Give each MARS footprint the height and class of the Overture building it
    overlaps most. MARS sees geometry, not attributes, and step 03 needs the
    class to keep census population out of warehouses.
    """
    reference = gpd.read_file(reference_path).to_crs("EPSG:4326")
    keep = [c for c in ("calculated_height", "building", "subtype") if c in reference]
    reference = reference[["geometry"] + keep].copy()

    left = buildings.to_crs(METRIC_CRS).reset_index(names="_mars_id")
    right = reference.to_crs(METRIC_CRS).reset_index(names="_ref_id")

    pairs = gpd.overlay(
        left[["_mars_id", "geometry"]],
        right[["_ref_id", "geometry"]],
        how="intersection",
        keep_geom_type=True,
    )

    if pairs.empty:
        best = {}
    else:
        pairs["_overlap"] = pairs.geometry.area
        best = (
            pairs.sort_values("_overlap", ascending=False)
            .drop_duplicates("_mars_id")
            .set_index("_mars_id")["_ref_id"]
        )

    buildings = buildings.copy()
    ref_id = buildings.index.map(best) if len(best) else [None] * len(buildings)
    buildings["_ref_id"] = ref_id
    matched = int(buildings["_ref_id"].notna().sum())

    for column in keep:
        lookup = right.set_index("_ref_id")[column]
        buildings[column] = buildings["_ref_id"].map(lookup)
    buildings = buildings.drop(columns="_ref_id")

    print(
        f"   {matched}/{len(buildings)} footprints matched an Overture building; "
        f"the rest fall back to {DEFAULT_HEIGHT_M}m and class 'yes'"
    )
    return buildings


def to_pipeline_schema(buildings: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Match the columns 01_fetch_overture_geometry.py writes."""
    buildings = buildings[
        buildings.geometry.geom_type.isin(["Polygon", "MultiPolygon"])
    ].copy()

    if "calculated_height" not in buildings.columns:
        buildings["calculated_height"] = DEFAULT_HEIGHT_M
    buildings["calculated_height"] = buildings["calculated_height"].fillna(
        DEFAULT_HEIGHT_M
    )

    if "building" not in buildings.columns:
        buildings["building"] = "yes"
    buildings["building"] = buildings["building"].fillna("yes")

    if "subtype" not in buildings.columns:
        buildings["subtype"] = None

    buildings["source"] = "mars"

    return buildings[
        ["geometry", "calculated_height", "building", "subtype", "score", "source"]
    ]


async def run(args):
    try:
        import geoai
    except ImportError:
        sys.exit(
            "error: the GeoAI SDK is not installed — see the module docstring "
            "for how to install it from a wheel or the Azure repo"
        )

    require(
        args,
        ["endpoint", "geocatalog-uri", "collection"],
        "to reach the MARS endpoint and your imagery",
    )

    model, input_source, constraint, params, azure_credential = build_job(geoai, args)

    print(f"🔄 Estimating MARS job over Dakhla {tuple(args.bbox)}...")
    estimate = await model.estimate(input_source, constraint, params)
    print(estimate)

    if args.estimate_only:
        return

    if getattr(estimate, "stac_items_found", 0) == 0:
        sys.exit(
            f"error: no imagery in collection '{args.collection}' matches this "
            f"bbox, {args.datetime}, and gsd <= {args.max_gsd}m — nothing to run"
        )

    require(
        args,
        ["storage-url", "blob-container"],
        "to publish results (or pass --estimate-only)",
    )

    output = geoai.Output(
        geocatalog_uri=args.geocatalog_uri,
        collection_name=args.results_collection,
        credential=azure_credential,
        storage_url=args.storage_url,
        blob_container=args.blob_container,
    )

    print("🛰️  Running MARS inference...")
    result = await model.run(
        input=input_source, constraint=constraint, params=params, output=output
    )
    print(
        f"   {result.detection_count} features from {result.successful_chips}"
        f"/{result.total_chips} chips ({result.success_rate:.1f}% success)"
    )
    if result.published:
        print(f"   Published: {result.geocatalog_url}")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    buildings = to_gdf(result.merged_results, [BUILDING_LABEL])
    if args.min_score > 0:
        before = len(buildings)
        buildings = buildings[buildings["score"] >= args.min_score].copy()
        print(f"   Dropped {before - len(buildings)} below score {args.min_score}")

    if buildings.empty:
        sys.exit("error: MARS returned no building footprints — nothing written")

    if args.heights_from:
        buildings = attach_overture_attributes(buildings, args.heights_from)
    else:
        print(
            f"   No --heights-from layer: every footprint gets "
            f"{DEFAULT_HEIGHT_M}m and class 'yes', which flattens step 03's "
            f"residential filter"
        )

    buildings = to_pipeline_schema(buildings)

    name = (
        "dakhla_buildings_3d.geojson"
        if args.replace_overture
        else "dakhla_buildings_mars.geojson"
    )
    buildings_path = os.path.join(OUTPUT_DIR, name)
    buildings.to_file(buildings_path, driver="GeoJSON")
    print(f"💾 {buildings_path} ({len(buildings)} footprints)")

    if args.include_roads:
        roads = to_gdf(result.merged_results, ROAD_LABELS)
        roads_path = os.path.join(OUTPUT_DIR, "dakhla_mars_roads.geojson")
        roads.to_file(roads_path, driver="GeoJSON")
        print(
            f"💾 {roads_path} ({len(roads)} segments) — centrelines only, with no "
            f"road class, so they do not drop into the walkable network layer as-is"
        )

    if not args.replace_overture:
        print(
            "\nStep 02 reads dakhla_buildings_3d.geojson. Compare the two layers "
            "first, then re-run with --replace-overture to swap sources."
        )


def main():
    asyncio.run(run(parse_args()))


if __name__ == "__main__":
    main()
