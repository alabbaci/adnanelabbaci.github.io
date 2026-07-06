"""
city_config.py

Per-city parameters for the heat-mapping pipeline. Every script accepts the
city slug as its first CLI argument (or the CITY env var); default: dakhla.

    python scripts/01_fetch_osm_geometry.py rabat
"""

import os
import sys

CITIES = {
    "dakhla": {
        "label": "Dakhla (Western Sahara / Morocco)",
        # Dakhla peninsula (Rio de Oro): historic city at the southwestern
        # tip, the port, the airport and the newer isthmus developments.
        "bbox": {"xmin": -16.00, "ymin": 23.62, "xmax": -15.72, "ymax": 23.90},
        "metric_crs": "EPSG:32628",  # UTM 28N
        # Overwhelmingly low-rise (1-2 storeys)
        "default_height_m": 4.5,
        # Coastal-desert baseline, ocean-moderated summer ambient
        "baseline_temp_c": 26.0,
    },
    "rabat": {
        "label": "Rabat (Morocco)",
        # Rabat city proper south of the Bouregreg: medina, Hassan, Agdal,
        # l'Océan, Yacoub El Mansour, Hay Riad, Souissi.
        "bbox": {"xmin": -6.90, "ymin": 33.94, "xmax": -6.78, "ymax": 34.04},
        "metric_crs": "EPSG:32629",  # UTM 29N
        # Mixed fabric, mostly 2-storey with mid-rise corridors
        "default_height_m": 6.4,
        # Atlantic-Mediterranean coastal baseline
        "baseline_temp_c": 27.0,
    },
}

# Shared across cities
METERS_PER_LEVEL = 3.2
MAX_DENSITY_BONUS_C = 6.5
GRID_SIZE_METERS = 200
GEOGRAPHIC_CRS = "EPSG:4326"


def get_city() -> tuple[str, dict]:
    slug = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CITY", "dakhla")).lower()
    if slug not in CITIES:
        raise SystemExit(f"Unknown city '{slug}'. Available: {', '.join(CITIES)}")
    return slug, CITIES[slug]
