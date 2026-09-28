"""Open-Meteo client: forecasts, historical archive and previous model runs.

All frames are hourly, indexed in UTC. Open-Meteo is free for
non-commercial use and needs no API key.
"""
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

from config import ROOT, WEATHER_VARS

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
CACHE = ROOT / ".cache" / "weather"


# The load model trains only on these; fetching fewer variables keeps the
# multi-year archive requests small and fast.
ARCHIVE_VARS = ["temperature_2m", "apparent_temperature", "relative_humidity_2m",
                "wind_speed_10m", "shortwave_radiation"]


def _get(url: str, params: dict) -> dict:
    params = {**params, "timezone": "GMT", "wind_speed_unit": "ms"}
    last = None
    for attempt in range(5):
        try:
            r = requests.get(url, params=params, timeout=180)
        except (requests.Timeout, requests.ConnectionError) as e:
            last = e
        else:
            if r.status_code == 200:
                return r.json()
            if r.status_code not in (429, 500, 502, 503, 504):
                raise RuntimeError(f"{url} -> HTTP {r.status_code}: {r.text[:300]}")
            last = f"HTTP {r.status_code}"
        time.sleep(2 ** attempt * 5)
    raise RuntimeError(f"{url}: gave up after retries ({last})")


def _frame(payload: dict) -> pd.DataFrame:
    h = payload["hourly"]
    idx = pd.to_datetime(h.pop("time"), utc=True)
    return pd.DataFrame(h, index=idx).astype(float)


def forecast(lat: float, lon: float, past_days: int = 1, days: int = 3) -> pd.DataFrame:
    return _frame(_get(FORECAST_URL, {
        "latitude": lat, "longitude": lon, "hourly": ",".join(WEATHER_VARS),
        "past_days": past_days, "forecast_days": days,
    }))


def archive(lat: float, lon: float, start: date, end: date) -> pd.DataFrame:
    """Reanalysis history, cached per location and calendar year."""
    CACHE.mkdir(parents=True, exist_ok=True)
    parts = []
    for year in range(start.year, end.year + 1):
        y0, y1 = max(start, date(year, 1, 1)), min(end, date(year, 12, 31))
        f = CACHE / f"v2_{lat:.3f}_{lon:.3f}_{year}.csv.gz"
        complete_year = y1 == date(year, 12, 31)
        if f.exists():
            df = pd.read_csv(f, index_col=0, parse_dates=True)
            df.index = pd.to_datetime(df.index, utc=True)
            if complete_year or df.index.max().date() >= y1:
                parts.append(df.loc[str(y0):str(y1)])
                continue
        df = _frame(_get(ARCHIVE_URL, {
            "latitude": lat, "longitude": lon, "hourly": ",".join(ARCHIVE_VARS),
            "start_date": y0.isoformat(), "end_date": y1.isoformat(),
        })).dropna(how="all")
        df.to_csv(f)
        parts.append(df)
    return pd.concat(parts).sort_index()


def previous_runs(lat: float, lon: float, past_days: int = 31) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(lead-0, lead-1) weather for the last `past_days` days.

    Lead 0 is the run issued on the same day (a near-analysis); lead 1 is what
    the model predicted the day before — i.e. a day-ahead forecast.
    """
    lead1 = [f"{v}_previous_day1" for v in WEATHER_VARS]
    df = _frame(_get(PREVIOUS_RUNS_URL, {
        "latitude": lat, "longitude": lon, "hourly": ",".join(WEATHER_VARS + lead1),
        "past_days": past_days, "forecast_days": 1,
    }))
    today = pd.Timestamp.now(tz="UTC").normalize()
    df = df[df.index < today]
    d0 = df[WEATHER_VARS]
    d1 = df[lead1].rename(columns=lambda c: c.removesuffix("_previous_day1"))
    ok = d0.notna().all(axis=1) & d1.notna().all(axis=1)
    return d0[ok], d1[ok]


def training_window(years: int) -> tuple[date, date]:
    end = date.today() - timedelta(days=7)      # ERA5 lags ~5 days
    return date(end.year - years, end.month, 1), end
