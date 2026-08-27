"""
02_generate_heat_grid.py  (ArcGIS Pro / arcpy port)

Step 2 of the Dakhla pipeline, rebuilt on ArcGIS Pro geoprocessing.

Builds a uniform 200m x 200m fishnet over the building extent (UTM 28N),
sums building footprint area per cell with Tabulate Intersection, derives
urban_density and a density-driven temperature_proxy, keeps the built-up
cells, and writes:

    <workspace>/dakhla.gdb/heat_grid                 (WGS84 polygons)
    ../data/processed/dakhla_heat_grid_arcgis.geojson (web-map export)

Mirrors scripts/02_generate_heat_grid.py (the GeoPandas route). The
temperature_proxy is a density stand-in, not measured temperature — see
docs/heat_data_sources.md.

Run: propy arcgis_pro/02_generate_heat_grid.py
"""

import os
import sys

import arcpy

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import dakhla_config as cfg


def main():
    arcpy.env.workspace = cfg.GDB_PATH
    arcpy.env.overwriteOutput = True

    buildings = os.path.join(cfg.GDB_PATH, cfg.FC_BUILDINGS)
    if not arcpy.Exists(buildings):
        raise FileNotFoundError(
            f"{cfg.FC_BUILDINGS} not found in the GDB — run step 1 first."
        )

    utm = arcpy.SpatialReference(cfg.UTM28N_WKID)
    wgs84 = arcpy.SpatialReference(cfg.WGS84_WKID)

    # 1. Reproject buildings to a metric CRS so areas are in m^2.
    arcpy.AddMessage(f"Reprojecting buildings to UTM 28N (EPSG:{cfg.UTM28N_WKID})...")
    buildings_utm = os.path.join(cfg.GDB_PATH, "buildings_utm")
    arcpy.management.Project(buildings, buildings_utm, utm)

    # 2. Build a 200m fishnet spanning the building extent.
    arcpy.AddMessage(f"Creating {cfg.GRID_SIZE_METERS}m fishnet...")
    ext = arcpy.Describe(buildings_utm).extent
    origin = f"{ext.XMin} {ext.YMin}"
    y_axis = f"{ext.XMin} {ext.YMin + 10}"
    corner = f"{ext.XMax} {ext.YMax}"

    grid = os.path.join(cfg.GDB_PATH, "grid_full")
    arcpy.env.outputCoordinateSystem = utm
    arcpy.management.CreateFishnet(
        grid, origin, y_axis,
        cfg.GRID_SIZE_METERS, cfg.GRID_SIZE_METERS,
        0, 0, corner,
        labels="NO_LABELS", geometry_type="POLYGON",
    )
    arcpy.env.outputCoordinateSystem = None

    # Stable per-cell id (fishnet OID) for the tabulate join.
    arcpy.management.AddField(grid, "grid_id", "LONG")
    arcpy.management.CalculateField(grid, "grid_id", "!OID!", "PYTHON3")

    # 3. Sum building footprint area within each cell.
    arcpy.AddMessage("Tabulating building area per cell...")
    tab = os.path.join(cfg.GDB_PATH, "tab_building_area")
    arcpy.analysis.TabulateIntersection(
        in_zone_features=grid, zone_fields="grid_id",
        in_class_features=buildings_utm, out_table=tab,
    )
    area_by_cell = {
        gid: area for gid, area in arcpy.da.SearchCursor(tab, ["grid_id", "AREA"])
    }

    # 4. urban_density + temperature_proxy on the grid.
    for fname in ("total_building_area", "cell_area", "urban_density",
                  "temperature_proxy"):
        arcpy.management.AddField(grid, fname, "DOUBLE")

    cell_area = float(cfg.GRID_SIZE_METERS) ** 2  # uniform fishnet cells
    fields = ["grid_id", "total_building_area", "cell_area",
              "urban_density", "temperature_proxy"]
    with arcpy.da.UpdateCursor(grid, fields) as cur:
        for row in cur:
            gid = row[0]
            b_area = float(area_by_cell.get(gid, 0.0))
            density = b_area / cell_area
            row[1] = b_area
            row[2] = cell_area
            row[3] = density
            row[4] = cfg.BASELINE_TEMP_C + density * cfg.MAX_DENSITY_BONUS_C
            cur.updateRow(row)

    # 5. Keep only built-up cells (mirrors the density threshold filter).
    arcpy.AddMessage("Selecting built-up cells...")
    where = f"urban_density > {cfg.MIN_DENSITY_THRESHOLD}"
    grid_built = os.path.join(cfg.GDB_PATH, "grid_built")
    arcpy.analysis.Select(grid, grid_built, where)

    # 6. Reproject to WGS84 for the web map and export GeoJSON.
    arcpy.AddMessage("Reprojecting to WGS84 and exporting...")
    heat_grid = os.path.join(cfg.GDB_PATH, cfg.FC_HEAT_GRID)
    arcpy.management.Project(grid_built, heat_grid, wgs84)

    out_json = os.path.join(cfg.PROCESSED_DIR, "dakhla_heat_grid_arcgis.geojson")
    if arcpy.Exists(out_json):
        arcpy.management.Delete(out_json)
    arcpy.conversion.FeaturesToJSON(heat_grid, out_json, geoJSON="GEOJSON")

    n = int(arcpy.management.GetCount(heat_grid)[0])
    arcpy.AddMessage(f"Step 2 complete: {cfg.FC_HEAT_GRID} ({n} cells)")
    arcpy.AddMessage(f"  exported: {out_json}")


if __name__ == "__main__":
    main()
