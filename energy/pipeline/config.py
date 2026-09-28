"""Shared configuration for the Morocco energy forecasting pipeline.

Everything here is open data or a published figure. Numbers that are
calibration assumptions (not measured) are marked as such so they can be
corrected when better data is available.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]           # energy/
DATA = ROOT / "data"                                 # JSON served to the dashboard
HISTORY = DATA / "history"                           # archived daily forecasts
MODELS = ROOT / "models"                             # trained model files

TZ = "Africa/Casablanca"

# --- Load zones -----------------------------------------------------------
# ONEE does not publish zonal load, so "zones" follow the grid's regional
# directorates grouped into four areas, each represented by its largest
# demand centres. `share` is the assumed fraction of national demand
# (calibration assumption, derived from 2024 RGPH population and the
# industrial weight of the Casablanca–Tanger axis).
ZONES = {
    "north": {
        "label": "Nord (Tanger–Tétouan–Al Hoceïma, Oriental)",
        "share": 0.20,
        "cities": {"Tanger": (35.7595, -5.8340, 0.55),
                   "Tétouan": (35.5785, -5.3684, 0.20),
                   "Oujda": (34.6814, -1.9086, 0.25)},
    },
    "centre": {
        "label": "Centre (Casablanca–Settat, Rabat–Salé–Kénitra, Fès–Meknès)",
        "share": 0.52,
        "cities": {"Casablanca": (33.5731, -7.5898, 0.50),
                   "Rabat": (34.0209, -6.8416, 0.22),
                   "Fès": (34.0181, -5.0078, 0.16),
                   "Meknès": (33.8950, -5.5547, 0.12)},
    },
    "south": {
        "label": "Sud (Marrakech–Safi, Souss–Massa, Drâa–Tafilalet)",
        "share": 0.23,
        "cities": {"Marrakech": (31.6295, -7.9811, 0.45),
                   "Agadir": (30.4278, -9.5981, 0.35),
                   "Ouarzazate": (30.9335, -6.9370, 0.20)},
    },
    "sahara": {
        "label": "Provinces du Sud (Laâyoune, Dakhla)",
        "share": 0.05,
        "cities": {"Laâyoune": (27.1253, -13.1625, 0.70),
                   "Dakhla": (23.6848, -15.9580, 0.30)},
    },
}

# National calibration (assumptions — update from ONEE annual reports /
# Ember when newer figures are published).
NATIONAL_ANNUAL_TWH = 43.0      # net national demand, ~2024
NATIONAL_PEAK_MW = 7_800        # summer evening peak, ~2024

# --- PV plants -------------------------------------------------------------
# Utility-scale photovoltaic plants in operation (MASEN "Noor" programme).
# Capacities are nominal AC ratings from MASEN publications.
PV_PLANTS = {
    "noor_ouarzazate_iv": {"label": "Noor Ouarzazate IV", "lat": 30.9960, "lon": -6.8630,
                           "mw": 72, "tilt": 0, "tracking": True},
    "noor_laayoune": {"label": "Noor Laâyoune I", "lat": 27.0800, "lon": -13.3700,
                      "mw": 85, "tilt": 0, "tracking": True},
    "noor_boujdour": {"label": "Noor Boujdour I", "lat": 26.1400, "lon": -14.4400,
                      "mw": 20, "tilt": 0, "tracking": True},
}

# Weather variables pulled from Open-Meteo for every location.
WEATHER_VARS = [
    "temperature_2m", "apparent_temperature", "relative_humidity_2m",
    "wind_speed_10m", "shortwave_radiation", "direct_normal_irradiance",
    "diffuse_radiation", "cloud_cover",
]

FORECAST_DAYS = 3
TRAIN_YEARS = 3
