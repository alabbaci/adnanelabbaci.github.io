"""
01_import_overture_geometry.py  (ArcGIS Pro / arcpy port)

Step 1 of the Dakhla pipeline, rebuilt on ArcGIS Pro geoprocessing. It
creates a File Geodatabase and loads two feature classes:

    <workspace>/dakhla.gdb/buildings_3d          (polygons, calculated_height)
    <workspace>/dakhla.gdb/pedestrian_network    (walkable segments)

Two source modes (SOURCE constant, or --source on the command line):

  "geojson"  (default) — imports the committed GeoJSONs produced by the
             open-source pipeline (../data/processed/*.geojson) with
             arcpy.conversion.JSONToFeatures. Needs nothing beyond a stock
             ArcGIS Pro Python environment, and reproduces the exact same
             geometry the deck.gl scene uses.

  "overture" — fetches Dakhla's buildings + transportation directly from the
             Overture Maps GeoParquet release on S3 (anonymous), resolves a
             usable building height, keeps walkable classes, and writes the
             rows into the GDB via an arcpy InsertCursor. Requires pyarrow +
             s3fs + shapely installed into the ArcGIS Pro conda env
             (see arcgis_pro/README.md).

Run inside ArcGIS Pro's Python (Propy) or the Python window:
    propy arcgis_pro/01_import_overture_geometry.py --source geojson
"""

import os
import sys

import arcpy

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import dakhla_config as cfg

SOURCE = "geojson"  # "geojson" | "overture"


def ensure_workspace():
    """Create the workspace folder and an empty File Geodatabase."""
    os.makedirs(cfg.WORKSPACE_DIR, exist_ok=True)
    if not arcpy.Exists(cfg.GDB_PATH):
        arcpy.management.CreateFileGDB(cfg.WORKSPACE_DIR, cfg.GDB_NAME)
        arcpy.AddMessage(f"Created {cfg.GDB_PATH}")
    arcpy.env.workspace = cfg.GDB_PATH
    arcpy.env.overwriteOutput = True


# --------------------------------------------------------------------------
# Mode A: import the committed GeoJSONs (no extra dependencies)
# --------------------------------------------------------------------------
def import_from_geojson():
    for path, fc in (
        (cfg.GEOJSON_BUILDINGS, cfg.FC_BUILDINGS),
        (cfg.GEOJSON_NETWORK, cfg.FC_NETWORK),
    ):
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"{path} not found. Run the open-source scripts/ pipeline "
                "first, or use SOURCE='overture'."
            )
        out = os.path.join(cfg.GDB_PATH, fc)
        arcpy.AddMessage(f"Importing {os.path.basename(path)} -> {fc}")
        arcpy.conversion.JSONToFeatures(path, out)

    # JSONToFeatures already carries calculated_height / building / subtype
    # for the buildings and name / highway for the network. Nothing else to do.
    _report_counts()


# --------------------------------------------------------------------------
# Mode B: fetch live from Overture Maps and write via InsertCursor
# --------------------------------------------------------------------------
def _read_overture(theme, type_, columns):
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import s3fs

    xmin, ymin, xmax, ymax = cfg.BBOX
    bbox_filter = (
        (pc.field("bbox", "xmin") < xmax)
        & (pc.field("bbox", "xmax") > xmin)
        & (pc.field("bbox", "ymin") < ymax)
        & (pc.field("bbox", "ymax") > ymin)
    )
    fs = s3fs.S3FileSystem(anon=True)
    root = f"overturemaps-us-west-2/release/{cfg.OVERTURE_RELEASE}"
    dataset = ds.dataset(
        f"{root}/theme={theme}/type={type_}/", filesystem=fs, format="parquet"
    )
    return dataset.to_table(filter=bbox_filter, columns=columns).to_pylist()


def _wgs84():
    return arcpy.SpatialReference(cfg.WGS84_WKID)


def _create_fc(name, geom_type, fields):
    arcpy.management.CreateFeatureclass(
        cfg.GDB_PATH, name, geom_type, spatial_reference=_wgs84()
    )
    fc = os.path.join(cfg.GDB_PATH, name)
    for fname, ftype, flen in fields:
        if ftype == "TEXT":
            arcpy.management.AddField(fc, fname, ftype, field_length=flen)
        else:
            arcpy.management.AddField(fc, fname, ftype)
    return fc


def import_from_overture():
    arcpy.AddMessage(
        f"Fetching Overture {cfg.OVERTURE_RELEASE} for Dakhla {cfg.BBOX} ..."
    )

    # -- Buildings ----------------------------------------------------------
    b_rows = _read_overture(
        "buildings", "building",
        ["geometry", "height", "num_floors", "subtype", "class"],
    )
    b_fc = _create_fc(
        cfg.FC_BUILDINGS, "POLYGON",
        [("calculated_height", "DOUBLE", None),
         ("building", "TEXT", 100),
         ("subtype", "TEXT", 100)],
    )
    fields = ["SHAPE@", "calculated_height", "building", "subtype"]
    with arcpy.da.InsertCursor(b_fc, fields) as cur:
        kept = 0
        for r in b_rows:
            geom = arcpy.FromWKB(bytes(r["geometry"]))
            if geom is None or geom.type not in ("polygon",):
                continue
            height = cfg.calculated_height(r.get("height"), r.get("num_floors"))
            building = r.get("class") or r.get("subtype") or "yes"
            cur.insertRow([geom, height, building, r.get("subtype")])
            kept += 1
    arcpy.AddMessage(f"  buildings written: {kept}")

    # -- Walkable network ---------------------------------------------------
    s_rows = _read_overture(
        "transportation", "segment",
        ["geometry", "subtype", "class", "names"],
    )
    n_fc = _create_fc(
        cfg.FC_NETWORK, "POLYLINE",
        [("name", "TEXT", 255), ("highway", "TEXT", 100)],
    )
    with arcpy.da.InsertCursor(n_fc, ["SHAPE@", "name", "highway"]) as cur:
        kept = 0
        for r in s_rows:
            if r.get("subtype") != "road":
                continue
            klass = r.get("class")
            if klass in cfg.NON_WALKABLE_CLASSES:
                continue
            geom = arcpy.FromWKB(bytes(r["geometry"]))
            if geom is None:
                continue
            names = r.get("names")
            primary = names.get("primary") if isinstance(names, dict) else None
            cur.insertRow([geom, primary, klass])
            kept += 1
    arcpy.AddMessage(f"  segments written: {kept}")

    _report_counts()


def _report_counts():
    for fc in (cfg.FC_BUILDINGS, cfg.FC_NETWORK):
        n = int(arcpy.management.GetCount(os.path.join(cfg.GDB_PATH, fc))[0])
        arcpy.AddMessage(f"  {fc}: {n} features")


def main(source=SOURCE):
    ensure_workspace()
    if source == "overture":
        import_from_overture()
    else:
        import_from_geojson()
    arcpy.AddMessage("Step 1 complete.")


if __name__ == "__main__":
    src = SOURCE
    if "--source" in sys.argv:
        src = sys.argv[sys.argv.index("--source") + 1]
    main(src)
