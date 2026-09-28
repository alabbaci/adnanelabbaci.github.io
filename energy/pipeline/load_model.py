"""Regional electricity load forecasting for Morocco (XGBoost + LightGBM ensemble).

Unlike Italy (Terna) Morocco's operator ONEE publishes no open hourly load
series. Two training targets are therefore supported:

1. **Measured actuals** — if `energy/data/raw/load_actuals.csv` exists
   (columns: `time_utc, region, mw`, region ids as in
   config.REGIONS), the ensemble trains on it directly.
2. **Calibrated reference load** (default) — a physically-shaped hourly
   series built from the Moroccan daily/weekly profile, the holiday and
   Ramadan calendar, population-weighted cooling/heating degree-hours from
   real reanalysis weather, and scaled to national annual demand and peak
   (see config.NATIONAL_*). It's a model, not metered data, and the
   dashboard labels it that way.
"""
import lightgbm as lgb
import numpy as np
import pandas as pd
import xgboost as xgb

from calendar_ma import calendar_frame
from config import DATA, NATIONAL_ANNUAL_TWH, NATIONAL_PEAK_MW, REGIONS, TZ, demand_share

ACTUALS = DATA / "raw" / "load_actuals.csv"

# Typical Moroccan weekday shape (fraction of daily peak) by local hour:
# night trough, late-morning plateau, afternoon dip, lighting-driven
# evening peak around 20–21h.
HOURLY_SHAPE = np.array([
    0.74, 0.69, 0.66, 0.64, 0.63, 0.64, 0.67, 0.72, 0.79, 0.85, 0.89, 0.91,
    0.91, 0.89, 0.87, 0.86, 0.86, 0.88, 0.92, 0.97, 1.00, 0.99, 0.93, 0.83,
])
DOW_FACTOR = np.array([1.00, 1.00, 1.00, 1.00, 0.98, 0.94, 0.88])  # Mon..Sun
GROWTH_PER_YEAR = 0.035
REFERENCE_YEAR = 2024.5

FEATURES = ["hour", "dow", "month", "doy_sin", "doy_cos", "is_holiday", "is_ramadan",
            "temp", "temp_app", "temp_24h", "temp_72h", "humidity", "wind", "ghi", "trend"]


def region_weather(weather: dict[str, pd.DataFrame], region: str) -> pd.DataFrame:
    """Demand-weighted mean of the region's city weather."""
    cities = REGIONS[region]["cities"]
    total = sum(w for _, _, w in cities.values())
    return sum(weather[c] * (w / total) for c, (_, _, w) in cities.items()).dropna()


def features(wx: pd.DataFrame) -> pd.DataFrame:
    cal = calendar_frame(wx.index, TZ)
    t = wx["temperature_2m"]
    years = wx.index.year + wx.index.dayofyear / 366
    return cal.assign(
        temp=t,
        temp_app=wx["apparent_temperature"],
        temp_24h=t.ewm(halflife=12).mean(),     # building thermal inertia
        temp_72h=t.ewm(halflife=36).mean(),
        humidity=wx["relative_humidity_2m"],
        wind=wx["wind_speed_10m"],
        ghi=wx["shortwave_radiation"],
        trend=np.asarray(years - REFERENCE_YEAR, dtype=float),
    )[FEATURES]


def reference_shape(X: pd.DataFrame) -> pd.Series:
    """Unscaled reference load (dimensionless) from features."""
    shape = HOURLY_SHAPE[X["hour"]].copy()
    ram = X["is_ramadan"].to_numpy() == 1
    h = X["hour"].to_numpy()
    # Ramadan: lower daytime activity, sharper post-iftar peak, suhoor bump.
    shape[ram & (h >= 10) & (h <= 17)] *= 0.93
    shape[ram & (h >= 21) & (h <= 23)] *= 1.04
    shape[ram & (h >= 2) & (h <= 4)] *= 1.08
    day = DOW_FACTOR[X["dow"]] * np.where(X["is_holiday"] == 1, 0.86, 1.0)
    # Ease weekday/weekend/holiday transitions over the night instead of
    # stepping at midnight, as real demand does.
    day = pd.Series(day, index=X.index).rolling(7, center=True, min_periods=1).mean().to_numpy()
    cdh = np.clip(0.5 * X["temp_app"] + 0.5 * X["temp_24h"] - 24.0, 0, None)
    hdh = np.clip(14.0 - X["temp_24h"], 0, None)
    weather = 1 + 0.032 * cdh + 0.012 * hdh
    growth = (1 + GROWTH_PER_YEAR) ** X["trend"]
    return pd.Series(shape * day * weather * growth, index=X.index)


def calibrate(X: pd.DataFrame, region: str) -> float:
    """MW scale so the region's last 365 days match its share of national energy."""
    s = reference_shape(X).iloc[-24 * 365:]
    target_mean_mw = demand_share(region) * NATIONAL_ANNUAL_TWH * 1e6 / 8760
    return target_mean_mw / s.mean()


def _targets(X: pd.DataFrame, region: str, scale: float) -> tuple[pd.Series, str]:
    if ACTUALS.exists():
        a = pd.read_csv(ACTUALS, parse_dates=["time_utc"])
        a = a[a["region"] == region].set_index("time_utc")["mw"]
        a.index = pd.to_datetime(a.index, utc=True)
        a = a.reindex(X.index).dropna()
        if len(a) > 24 * 60:
            return a, "measured"
    return reference_shape(X) * scale, "reference"


class RegionModel:
    def __init__(self, region: str):
        self.region = region
        self.scale = None
        self.source = None
        self.holdout = {}
        self.xgb = xgb.XGBRegressor(n_estimators=600, max_depth=7, learning_rate=0.05,
                                    subsample=0.8, colsample_bytree=0.8, n_jobs=4)
        self.lgb = lgb.LGBMRegressor(n_estimators=800, num_leaves=63, learning_rate=0.04,
                                     subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                                     verbose=-1, n_jobs=4)

    def fit(self, wx_hist: pd.DataFrame):
        X = features(wx_hist)
        self.scale = calibrate(X, self.region)
        y, self.source = _targets(X, self.region, self.scale)
        X = X.loc[y.index]
        split = len(X) - 24 * 60                      # 60-day holdout
        for m in (self.xgb, self.lgb):
            m.fit(X.iloc[:split], y.iloc[:split])
        pred = self._predict(X.iloc[split:])
        err = pred - y.iloc[split:]
        self.holdout = {"mape": float((err.abs() / y.iloc[split:]).mean() * 100),
                        "mae_mw": float(err.abs().mean())}
        for m in (self.xgb, self.lgb):                # refit on everything
            m.fit(X, y)
        return self

    def _predict(self, X: pd.DataFrame) -> pd.Series:
        return pd.Series((self.xgb.predict(X) + self.lgb.predict(X)) / 2, index=X.index)

    def predict(self, wx: pd.DataFrame) -> pd.Series:
        return self._predict(features(wx))

    def reference(self, wx: pd.DataFrame) -> pd.Series:
        """Reference load for given weather (the 'actual' in reference mode)."""
        return reference_shape(features(wx)) * self.scale


def model_card(models: dict[str, "RegionModel"], national_hist_peak: float) -> dict:
    return {
        "algorithm": "Mean ensemble of XGBoost and LightGBM, one model per region",
        "features": FEATURES,
        "target": models[next(iter(models))].source,
        "holdout_days": 60,
        "regions": {z: m.holdout for z, m in models.items()},
        "calibration": {"annual_twh": NATIONAL_ANNUAL_TWH,
                        "reference_peak_mw": NATIONAL_PEAK_MW,
                        "modelled_peak_mw_last_year": round(national_hist_peak)},
    }
