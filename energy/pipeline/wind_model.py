"""Wind generation forecasts for Morocco's wind farms.

Like PV, there is no open farm-level production feed for Morocco, so output
is computed physically: Open-Meteo 100 m wind speed through a generic
multi-MW turbine power curve, smoothed to represent a whole farm (turbines
see different wind speeds across the site), minus wake and availability
losses. Air-density effects are ignored.
"""
import numpy as np
import pandas as pd

CUT_IN, RATED, CUT_OUT = 3.0, 12.5, 25.0     # m/s, generic IEC class II turbine
FARM_SPREAD = 1.5                            # m/s std of wind across a farm
LOSSES = 0.12                                # wakes + availability + electrical

_V = np.linspace(0, 35, 701)


def _turbine(v: np.ndarray) -> np.ndarray:
    p = np.clip((v ** 3 - CUT_IN ** 3) / (RATED ** 3 - CUT_IN ** 3), 0, 1)
    return np.where((v < CUT_IN) | (v >= CUT_OUT), 0.0, p)


def _farm_curve() -> np.ndarray:
    """Turbine curve averaged over a normal spread of site wind speeds."""
    offsets = np.linspace(-3, 3, 61) * FARM_SPREAD
    weights = np.exp(-0.5 * (offsets / FARM_SPREAD) ** 2)
    weights /= weights.sum()
    return sum(w * _turbine(np.clip(_V + o, 0, None)) for o, w in zip(offsets, weights))


FARM_CURVE = _farm_curve()


def farm_output(farm: dict, wx: pd.DataFrame) -> pd.Series:
    """Hourly output (MW) for a farm, given its weather frame (m/s at 100 m)."""
    v = wx["wind_speed_100m"].to_numpy(dtype=float)
    cf = np.interp(np.nan_to_num(v, nan=0.0), _V, FARM_CURVE) * (1 - LOSSES)
    out = pd.Series(cf * farm["mw"], index=wx.index)
    return out.where(wx["wind_speed_100m"].notna())
