"""
03_integrate_demographics.py  (ArcGIS Pro / arcpy port)

Step 3 of the Dakhla pipeline, rebuilt on ArcGIS Pro geoprocessing.

Attaches a population estimate to the heat grid so the final 3D scene can
ask: do the most vulnerable residents live in the most severe heat traps?

Two modes, checked in order (mirrors scripts/03_integrate_demographics.py):

  1. Census mode — if data/raw/census_sections.geojson exists, its
     population is apportioned onto the grid by area-weighted overlap
     (Tabulate Intersection, weighting by each section's share inside a cell).

  2. Dasymetric proxy mode (default) — distributes Dakhla's RGPH 2024
     population (161,723) across cells proportionally to residential building
     *volume* (footprint area x calculated_height). A model, not counts —
     the field is named population_estimate to keep that visible.

Writes:
    <workspace>/dakhla.gdb/demographics_grid                    (WGS84)
    ../data/processed/dakhla_demographics_grid_arcgis.geojson

Run: propy arcgis_pro/03_integrate_demographics.py
"""

import os
import sys

import arcpy

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import dakhla_config as cfg


def _residential_where():
    quoted = ", ".join(f"'{s}'" for s in sorted(cfg.NON_RESIDENTIAL_SUBTYPES))
    # Keep unknown-subtype footprints: in Dakhla most are housing.
    return f"subtype IS NULL OR subtype NOT IN ({quoted})"


def integrate_building_volume_proxy(grid_utm):
    arcpy.AddMessage(
        f"No census layer — distributing RGPH 2024 population "
        f"({cfg.TOTAL_POPULATION:,}) by residential building volume."
    )
    utm = arcpy.SpatialReference(cfg.UTM28N_WKID)

    buildings_utm = os.path.join(cfg.GDB_PATH, "buildings_utm_demo")
    arcpy.management.Project(
        os.path.join(cfg.GDB_PATH, cfg.FC_BUILDINGS), buildings_utm, utm
    )

    residential = os.path.join(cfg.GDB_PATH, "residential")
    arcpy.analysis.Select(buildings_utm, residential, _residential_where())

    # Piece-wise intersection so each building fragment lands in one cell.
    inter = os.path.join(cfg.GDB_PATH, "res_x_grid")
    arcpy.analysis.Intersect([residential, grid_utm], inter)

    arcpy.management.AddField(inter, "res_volume", "DOUBLE")
    arcpy.management.CalculateField(
        inter, "res_volume",
        "!shape.area! * !calculated_height!", "PYTHON3",
    )

    stats = os.path.join(cfg.GDB_PATH, "res_volume_stats")
    arcpy.analysis.Statistics(inter, stats, [["res_volume", "SUM"]], "grid_id")

    volume_by_cell = {
        gid: (v or 0.0)
        for gid, v in arcpy.da.SearchCursor(stats, ["grid_id", "SUM_res_volume"])
    }
    total_volume = sum(volume_by_cell.values()) or 1.0

    arcpy.management.AddField(grid_utm, "population_estimate", "DOUBLE")
    with arcpy.da.UpdateCursor(grid_utm, ["grid_id", "population_estimate"]) as cur:
        for row in cur:
            share = volume_by_cell.get(row[0], 0.0) / total_volume
            row[1] = round(share * cfg.TOTAL_POPULATION, 1)
            cur.updateRow(row)
    return ["population_estimate"]


def integrate_census(grid_utm):
    arcpy.AddMessage("Census layer found — apportioning by area-weighted overlap...")
    utm = arcpy.SpatialReference(cfg.UTM28N_WKID)

    census = os.path.join(cfg.GDB_PATH, "census_sections")
    arcpy.conversion.JSONToFeatures(cfg.CENSUS_PATH, census)
    census_utm = os.path.join(cfg.GDB_PATH, "census_utm")
    arcpy.management.Project(census, census_utm, utm)

    # Normalize source column codes and add a stable section id.
    fnames = {f.name for f in arcpy.ListFields(census_utm)}
    for src, dst in cfg.COLUMN_MAP.items():
        if src in fnames and dst not in fnames:
            arcpy.management.AlterField(census_utm, src, dst, dst)
            fnames.add(dst)
    arcpy.management.AddField(census_utm, "section_id", "LONG")
    arcpy.management.CalculateField(census_utm, "section_id", "!OID!", "PYTHON3")

    section_pop = {}
    section_eld = {}
    read_fields = ["section_id"]
    has_count = "population_count" in fnames
    has_eld = "population_65plus" in fnames
    if has_count:
        read_fields.append("population_count")
    if has_eld:
        read_fields.append("population_65plus")
    for row in arcpy.da.SearchCursor(census_utm, read_fields):
        sid = row[0]
        if has_count:
            section_pop[sid] = row[read_fields.index("population_count")] or 0.0
        if has_eld:
            section_eld[sid] = row[read_fields.index("population_65plus")] or 0.0

    # PERCENTAGE = share of each census section that falls inside a grid cell.
    tab = os.path.join(cfg.GDB_PATH, "census_x_grid")
    arcpy.analysis.TabulateIntersection(
        in_zone_features=census_utm, zone_fields="section_id",
        in_class_features=grid_utm, class_fields="grid_id", out_table=tab,
    )

    pop_by_cell, eld_by_cell = {}, {}
    for sid, gid, pct in arcpy.da.SearchCursor(
        tab, ["section_id", "grid_id", "PERCENTAGE"]
    ):
        frac = (pct or 0.0) / 100.0
        pop_by_cell[gid] = pop_by_cell.get(gid, 0.0) + section_pop.get(sid, 0.0) * frac
        eld_by_cell[gid] = eld_by_cell.get(gid, 0.0) + section_eld.get(sid, 0.0) * frac

    out_fields = ["population_estimate"]
    for fname in ("population_count", "population_65plus", "elderly_share",
                  "population_estimate"):
        arcpy.management.AddField(grid_utm, fname, "DOUBLE")
    with arcpy.da.UpdateCursor(
        grid_utm,
        ["grid_id", "population_count", "population_65plus",
         "elderly_share", "population_estimate"],
    ) as cur:
        for row in cur:
            gid = row[0]
            pop = pop_by_cell.get(gid, 0.0)
            eld = eld_by_cell.get(gid, 0.0)
            row[1] = round(pop, 1)
            row[2] = round(eld, 1)
            row[3] = round(eld / pop, 4) if pop else 0.0
            row[4] = round(pop, 1)
            cur.updateRow(row)
    return out_fields


def main():
    arcpy.env.workspace = cfg.GDB_PATH
    arcpy.env.overwriteOutput = True

    heat_grid = os.path.join(cfg.GDB_PATH, cfg.FC_HEAT_GRID)
    if not arcpy.Exists(heat_grid):
        raise FileNotFoundError(
            f"{cfg.FC_HEAT_GRID} not found in the GDB — run step 2 first."
        )

    utm = arcpy.SpatialReference(cfg.UTM28N_WKID)
    wgs84 = arcpy.SpatialReference(cfg.WGS84_WKID)

    grid_utm = os.path.join(cfg.GDB_PATH, "demo_grid_utm")
    arcpy.management.Project(heat_grid, grid_utm, utm)

    if os.path.exists(cfg.CENSUS_PATH):
        integrate_census(grid_utm)
    else:
        integrate_building_volume_proxy(grid_utm)

    arcpy.AddMessage("Reprojecting to WGS84 and exporting...")
    demographics = os.path.join(cfg.GDB_PATH, cfg.FC_DEMOGRAPHICS)
    arcpy.management.Project(grid_utm, demographics, wgs84)

    out_json = os.path.join(
        cfg.PROCESSED_DIR, "dakhla_demographics_grid_arcgis.geojson"
    )
    if arcpy.Exists(out_json):
        arcpy.management.Delete(out_json)
    arcpy.conversion.FeaturesToJSON(demographics, out_json, geoJSON="GEOJSON")

    total = sum(
        r[0] or 0.0
        for r in arcpy.da.SearchCursor(demographics, ["population_estimate"])
    )
    arcpy.AddMessage(f"Step 3 complete: {cfg.FC_DEMOGRAPHICS}")
    arcpy.AddMessage(f"  population accounted for: {total:,.0f}")
    arcpy.AddMessage(f"  exported: {out_json}")


if __name__ == "__main__":
    main()
