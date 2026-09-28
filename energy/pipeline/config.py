"""Shared configuration for the Morocco energy forecasting pipeline.

Everything here is open data or a published figure. Numbers that are
calibration assumptions (not measured) are marked as such so they can be
corrected when better data is available.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]           # energy/
DATA = ROOT / "data"                                 # JSON served to the dashboard

TZ = "Africa/Casablanca"

# --- Administrative regions -------------------------------------------------
# Morocco's 12 regions (2015 division), keyed by a short id; `iso` is the
# ISO 3166-2 code used by the boundary file. Forecasts are made per region.
#   pop   — RGPH 2024 legal population, millions (HCP)
#   gdp   — share of national GDP, % (HCP regional accounts, ~2022)
#   cities — (lat, lon, weight): demand centres whose weather represents
#            the region, weighted by their approximate share of its demand.
# ONEE does not publish regional consumption, so each region's share of
# national demand is an assumption: the mean of its population and GDP
# shares (see `demand_share`).
REGIONS = {
    "tta": {"name": "Tanger-Tétouan-Al Hoceïma", "iso": "MA-01", "pop": 4.03, "gdp": 10.6,
            "cities": {"Tanger": (35.7595, -5.8340, 0.60), "Tétouan": (35.5785, -5.3684, 0.28),
                       "Al Hoceïma": (35.2517, -3.9372, 0.12)}},
    "ori": {"name": "L'Oriental", "iso": "MA-02", "pop": 2.29, "gdp": 4.8,
            "cities": {"Oujda": (34.6814, -1.9086, 0.60), "Nador": (35.1681, -2.9335, 0.40)}},
    "fm": {"name": "Fès-Meknès", "iso": "MA-03", "pop": 4.47, "gdp": 8.4,
           "cities": {"Fès": (34.0181, -5.0078, 0.60), "Meknès": (33.8950, -5.5547, 0.40)}},
    "rsk": {"name": "Rabat-Salé-Kénitra", "iso": "MA-04", "pop": 5.13, "gdp": 16.0,
            "cities": {"Rabat": (34.0209, -6.8416, 0.65), "Kénitra": (34.2610, -6.5802, 0.35)}},
    "bmk": {"name": "Béni Mellal-Khénifra", "iso": "MA-05", "pop": 2.53, "gdp": 5.5,
            "cities": {"Béni Mellal": (32.3373, -6.3498, 0.65), "Khouribga": (32.8811, -6.9063, 0.35)}},
    "cs": {"name": "Casablanca-Settat", "iso": "MA-06", "pop": 7.69, "gdp": 31.8,
           "cities": {"Casablanca": (33.5731, -7.5898, 0.75), "El Jadida": (33.2316, -8.5007, 0.25)}},
    "ms": {"name": "Marrakech-Safi", "iso": "MA-07", "pop": 4.89, "gdp": 8.6,
           "cities": {"Marrakech": (31.6295, -7.9811, 0.70), "Safi": (32.2994, -9.2372, 0.30)}},
    "dt": {"name": "Drâa-Tafilalet", "iso": "MA-08", "pop": 1.66, "gdp": 2.6,
           "cities": {"Errachidia": (31.9314, -4.4244, 0.50), "Ouarzazate": (30.9335, -6.9370, 0.50)}},
    "sm": {"name": "Souss-Massa", "iso": "MA-09", "pop": 3.02, "gdp": 6.6,
           "cities": {"Agadir": (30.4278, -9.5981, 0.80), "Taroudant": (30.4703, -8.8770, 0.20)}},
    "gon": {"name": "Guelmim-Oued Noun", "iso": "MA-10", "pop": 0.45, "gdp": 1.3,
            "cities": {"Guelmim": (28.9870, -10.0574, 1.0)}},
    "lsh": {"name": "Laâyoune-Sakia El Hamra", "iso": "MA-11", "pop": 0.45, "gdp": 2.1,
            "cities": {"Laâyoune": (27.1253, -13.1625, 1.0)}},
    "dod": {"name": "Dakhla-Oued Ed-Dahab", "iso": "MA-12", "pop": 0.22, "gdp": 1.7,
            "cities": {"Dakhla": (23.6848, -15.9580, 1.0)}},
}


def demand_share(region_id: str) -> float:
    """Assumed share of national demand: mean of population and GDP shares."""
    pop = sum(r["pop"] for r in REGIONS.values())
    gdp = sum(r["gdp"] for r in REGIONS.values())
    r = REGIONS[region_id]
    return 0.5 * r["pop"] / pop + 0.5 * r["gdp"] / gdp


# National calibration (assumptions — update from ONEE annual reports /
# Ember when newer figures are published).
NATIONAL_ANNUAL_TWH = 43.0      # net national demand, ~2024
NATIONAL_PEAK_MW = 7_800        # summer evening peak, ~2024

# --- PV plants -------------------------------------------------------------
# Utility-scale photovoltaic plants in operation (MASEN "Noor" programme).
# Capacities are nominal AC ratings from MASEN publications.
PV_PLANTS = {
    "noor_ouarzazate_iv": {"label": "Noor Ouarzazate IV", "region": "dt",
                           "lat": 30.9960, "lon": -6.8630, "mw": 72},
    "noor_laayoune": {"label": "Noor Laâyoune I", "region": "lsh",
                      "lat": 27.0800, "lon": -13.3700, "mw": 85},
    "noor_boujdour": {"label": "Noor Boujdour I", "region": "lsh",
                      "lat": 26.1400, "lon": -14.4400, "mw": 20},
}

# --- Wind farms ------------------------------------------------------------
# Operating wind farms with published capacities, from Wikipedia's "List of
# power stations in Morocco" (which cites ONEE, MASEN, the Ministry of
# Energy and the operators). Dhar Sadane is part of the Tangier I site and is
# not counted separately. Coordinates are approximate (the named locality),
# which is adequate for weather-grid forecasting. This is ~1.4 GW, not the
# full national fleet; add farms here as capacities are confirmed.
WIND_FARMS = {
    "tarfaya": {"label": "Tarfaya", "region": "lsh", "lat": 27.83, "lon": -12.85, "mw": 301},
    "midelt": {"label": "Midelt", "region": "dt", "lat": 32.63, "lon": -4.63, "mw": 210},
    "aftissat": {"label": "Aftissat", "region": "lsh", "lat": 26.73, "lon": -14.23, "mw": 201},
    "akhfennir": {"label": "Akhfennir I+II", "region": "gon", "lat": 28.10, "lon": -12.05, "mw": 200},
    "tangier_i": {"label": "Tangier I", "region": "tta", "lat": 35.78, "lon": -5.62, "mw": 140},
    "khalladi": {"label": "Khalladi", "region": "tta", "lat": 35.66, "lon": -5.63, "mw": 120},
    "cap_sim": {"label": "Cap Sim (Essaouira)", "region": "ms", "lat": 31.40, "lon": -9.78, "mw": 60},
    "haouma": {"label": "Haouma", "region": "tta", "lat": 35.83, "lon": -5.50, "mw": 50.6},
    "foum_el_oued": {"label": "Foum El Oued", "region": "lsh", "lat": 27.18, "lon": -13.37, "mw": 50.1},
    "koudia_al_baida": {"label": "Koudia Al Baida", "region": "tta", "lat": 35.72, "lon": -5.43, "mw": 50},
    "lafarge_tetouan": {"label": "Lafarge Tétouan", "region": "tta", "lat": 35.56, "lon": -5.40, "mw": 32},
    "ynna_essaouira": {"label": "YNNA Bio Power (Essaouira)", "region": "ms", "lat": 31.45, "lon": -9.72, "mw": 20},
}

# Hub-height wind for the farms (Open-Meteo provides 100 m).
WIND_VARS = ["wind_speed_100m", "temperature_2m"]

# Weather variables pulled from Open-Meteo for every location.
WEATHER_VARS = [
    "temperature_2m", "apparent_temperature", "relative_humidity_2m",
    "wind_speed_10m", "shortwave_radiation", "direct_normal_irradiance",
    "diffuse_radiation", "cloud_cover",
]

FORECAST_DAYS = 3
TRAIN_YEARS = 3
