"""Photovoltaic generation forecasts for MASEN's utility-scale PV plants.

There is no open, plant-level production feed for Morocco (ENTSO-E does not
cover it), so output is computed physically with pvlib from Open-Meteo
irradiance: single-axis trackers with backtracking, transposition to the
plane of array, SAPM cell temperature and PVWatts DC/AC with desert soiling
losses. If measured output becomes available it can be used to fit a
correction model on top, as the Italian platform does with ENTSO-E data.
"""
import pandas as pd
import pvlib

DC_AC_RATIO = 1.25
ALBEDO = 0.30                   # bright desert ground
TEMP_PARAMS = pvlib.temperature.TEMPERATURE_MODEL_PARAMETERS["sapm"]["open_rack_glass_polymer"]
LOSSES_PCT = pvlib.pvsystem.pvwatts_losses(soiling=5, shading=1, snow=0, mismatch=2, wiring=2,
                                           connections=0.5, lid=1.5, nameplate_rating=1,
                                           age=0, availability=2)


def plant_output(plant: dict, wx: pd.DataFrame) -> pd.Series:
    """Hourly AC output (MW) for a plant, given its weather frame.

    Open-Meteo radiation is the mean over the preceding hour, so the sun
    position is evaluated at the middle of that hour.
    """
    mid = wx.index - pd.Timedelta(minutes=30)
    sun = pvlib.solarposition.get_solarposition(mid, plant["lat"], plant["lon"])
    track = pvlib.tracking.singleaxis(sun["apparent_zenith"], sun["azimuth"], axis_tilt=0,
                                      axis_azimuth=180, max_angle=55, backtrack=True, gcr=0.35)
    tilt = track["surface_tilt"].fillna(0)
    azim = track["surface_azimuth"].fillna(180)
    ghi = wx["shortwave_radiation"].to_numpy()
    dni = wx["direct_normal_irradiance"].to_numpy()
    dhi = wx["diffuse_radiation"].to_numpy()
    poa = pvlib.irradiance.get_total_irradiance(
        tilt.to_numpy(), azim.to_numpy(), sun["apparent_zenith"].to_numpy(),
        sun["azimuth"].to_numpy(), dni, ghi, dhi, albedo=ALBEDO)["poa_global"]
    poa = pd.Series(poa, index=wx.index).fillna(0).clip(lower=0)
    t_cell = pvlib.temperature.sapm_cell(poa, wx["temperature_2m"], wx["wind_speed_10m"],
                                         **TEMP_PARAMS)
    pdc0 = plant["mw"] * DC_AC_RATIO
    pdc = pvlib.pvsystem.pvwatts_dc(poa, t_cell, pdc0, gamma_pdc=-0.0035)
    pdc = pdc * (1 - LOSSES_PCT / 100)
    pac = pvlib.inverter.pvwatts(pdc, pdc0=plant["mw"] / 0.97, eta_inv_nom=0.97)
    return pac.clip(lower=0, upper=plant["mw"]).fillna(0)
