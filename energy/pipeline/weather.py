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


def log(msg: str):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def _get(url: str, params: dict):
    params = {**params, "timezone": "GMT", "wind_speed_unit": "ms"}
    last = None
    for attempt in range(5):
        t0 = time.time()
        try:
            r = requests.get(url, params=params, timeout=180)
        except (requests.Timeout, requests.ConnectionError) as e:
            last = e
        else:
            if r.status_code == 200:
                if time.time() - t0 > 20:
                    log(f"  slow response from {url.split('/')[2]}: {time.time() - t0:.0f}s")
                return r.json()
            if r.status_code not in (429, 500, 502, 503, 504):
                raise RuntimeError(f"{url} -> HTTP {r.status_code}: {r.text[:300]}")
            last = f"HTTP {r.status_code}"
        wait = 2 ** attempt * 5
        log(f"  {url.split('/')[2]} failed ({last}); retrying in {wait}s")
        time.sleep(wait)
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


def _cache_file(lat: float, lon: float, year: int) -> Path:
    return CACHE / f"v2_{lat:.3f}_{lon:.3f}_{year}.csv.gz"


def _read_cache(f: Path) -> pd.DataFrame | None:
    if not f.exists():
        return None
    df = pd.read_csv(f, index_col=0, parse_dates=True)
    df.index = pd.to_datetime(df.index, utc=True)
    return df


def archive_many(locations: dict[str, tuple[float, float]], start: date, end: date,
                 batch: int = 10) -> dict[str, pd.DataFrame]:
    """Reanalysis history for many locations, cached per location and year.

    Only the days missing from the cache are downloaded, and locations
    needing the same date range share one multi-location request, so a daily
    run fetches a few days of data rather than years.
    """
    CACHE.mkdir(parents=True, exist_ok=True)
    for year in range(start.year, end.year + 1):
        y0, y1 = max(start, date(year, 1, 1)), min(end, date(year, 12, 31))
        todo: dict[tuple[date, date], list[str]] = {}
        for name, (lat, lon) in locations.items():
            cached = _read_cache(_cache_file(lat, lon, year))
            have = cached.index.max().date() if cached is not None and len(cached) else None
            if have is not None and have >= y1 and cached.index.min().date() <= y0:
                continue
            first = y0 if have is None or cached.index.min().date() > y0 else have + timedelta(days=1)
            todo.setdefault((first, y1), []).append(name)
        for (d0, d1), names in todo.items():
            for i in range(0, len(names), batch):
                chunk = names[i:i + batch]
                t0 = time.time()
                payload = _get(ARCHIVE_URL, {
                    "latitude": ",".join(f"{locations[n][0]}" for n in chunk),
                    "longitude": ",".join(f"{locations[n][1]}" for n in chunk),
                    "hourly": ",".join(ARCHIVE_VARS),
                    "start_date": d0.isoformat(), "end_date": d1.isoformat(),
                })
                payload = payload if isinstance(payload, list) else [payload]
                for n, part in zip(chunk, payload):
                    lat, lon = locations[n]
                    f = _cache_file(lat, lon, year)
                    new = _frame(part).dropna(how="all")
                    old = _read_cache(f) if d0 != y0 else None
                    df = new if old is None else pd.concat([old, new])
                    df[~df.index.duplicated(keep="last")].sort_index().to_csv(f)
                log(f"  archive {d0}..{d1}: {len(chunk)} locations in {time.time() - t0:.0f}s")
    out = {}
    for name, (lat, lon) in locations.items():
        parts = [_read_cache(_cache_file(lat, lon, y)) for y in range(start.year, end.year + 1)]
        df = pd.concat([p for p in parts if p is not None]).sort_index()
        out[name] = df.loc[str(start):str(end)]
    return out


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
