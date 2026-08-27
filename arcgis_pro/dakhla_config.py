"""
dakhla_config.py

Shared configuration for the ArcGIS Pro (arcpy) port of the Dakhla 3D
heat-trap & pedestrian exposure pipeline. Values mirror the open-source
GeoPandas pipeline in ../scripts so both routes produce comparable outputs.

Import this from the three step scripts and from the Python toolbox so the
constants stay in one place.
"""

import os

# --- Paths ------------------------------------------------------------------
# arcgis_pro/  ->  repo root
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, ".."))

RAW_DIR = os.path.join(REPO_ROOT, "data", "raw")
PROCESSED_DIR = os.path.join(REPO_ROOT, "data", "processed")

# All arcpy geoprocessing writes into a File Geodatabase kept out of git
# (see arcgis_pro/.gitignore). GeoJSON exports land back in data/processed.
WORKSPACE_DIR = os.path.join(HERE, "workspace")
GDB_NAME = "dakhla.gdb"
GDB_PATH = os.path.join(WORKSPACE_DIR, GDB_NAME)

# Committed GeoJSONs from the open-source pipeline, reused as the offline
# import source for step 1 (SOURCE = "geojson").
GEOJSON_BUILDINGS = os.path.join(PROCESSED_DIR, "dakhla_buildings_3d.geojson")
GEOJSON_NETWORK = os.path.join(PROCESSED_DIR, "dakhla_pedestrian_network.geojson")

# Optional census polygon layer for step 3 (census mode).
CENSUS_PATH = os.path.join(RAW_DIR, "census_sections.geojson")

# --- Feature class names inside the GDB ------------------------------------
FC_BUILDINGS = "buildings_3d"          # WGS84 polygons, calculated_height
FC_NETWORK = "pedestrian_network"      # WGS84 walkable segments
FC_HEAT_GRID = "heat_grid"             # WGS84 200m cells + temperature_proxy
FC_DEMOGRAPHICS = "demographics_grid"  # WGS84 cells + population_estimate

# --- Coordinate systems -----------------------------------------------------
WGS84_WKID = 4326       # Kepler.gl / web-map friendly geographic CRS
UTM28N_WKID = 32628     # metric CRS appropriate for Dakhla (UTM Zone 28N)

# --- Dakhla bounding box (lon_min, lat_min, lon_max, lat_max) ---------------
BBOX = (-16.02, 23.62, -15.86, 23.80)

# --- Step 1: geometry cleaning ---------------------------------------------
OVERTURE_RELEASE = "2026-06-17.0"
NON_WALKABLE_CLASSES = {"motorway", "trunk"}
METERS_PER_FLOOR = 3.2
DEFAULT_HEIGHT_M = 4.5  # Dakhla is predominantly low-rise

# --- Step 2: heat grid ------------------------------------------------------
GRID_SIZE_METERS = 200
BASELINE_TEMP_C = 26.0        # cooled by the Canary Current
MAX_DENSITY_BONUS_C = 6.5
MIN_DENSITY_THRESHOLD = 0.01

# --- Step 3: demographics ---------------------------------------------------
TOTAL_POPULATION = 161_723    # Dakhla municipality, RGPH 2024 (HCP Morocco)
NON_RESIDENTIAL_SUBTYPES = {
    "commercial", "industrial", "service", "transportation",
    "education", "medical", "religious", "civic", "military",
    "agricultural", "entertainment",
}
# Map a census extract's raw column codes to the names used downstream.
COLUMN_MAP = {
    "POP": "population_count",
    "POP65": "population_65plus",
}


def calculated_height(height, num_floors):
    """Resolve a usable building height in meters (mirrors the GeoPandas step)."""
    if height not in (None, "") and float(height) > 0:
        return float(height)
    if num_floors not in (None, "") and float(num_floors) > 0:
        return float(num_floors) * METERS_PER_FLOOR
    return DEFAULT_HEIGHT_M
