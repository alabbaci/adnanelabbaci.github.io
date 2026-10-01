#!/usr/bin/env python3
"""Fifty hydrological years of ERA5 precipitation over Morocco.

For every hydrological year from 1976/77 to 2025/26 (1 September -> 31 August)
this totals ERA5 precipitation over the Morocco box and compares it with the
1991/92-2020/21 normal (the WMO 1991-2020 normal, in hydrological years), both
as a share of the normal and as the 12-month Standardized Precipitation Index
(SPI), which rates each year against the place's own year-to-year spread.

ERA5 is read from two public copies on Google Cloud, so no Copernicus CDS key
is needed:

* to 10 Jan 2023: WeatherBench 2's ERA5 aggregates, 52 seven-day totals plus
  one or two daily totals per year (instead of 8,760 hourly fields);
* from 11 Jan 2023: ARCO-ERA5 hourly accumulations.

Both are built from the same hourly ERA5 accumulations. A WeatherBench 2 day
is the 24 hourly accumulations stamped 01:00 ... 24:00 UTC, and the hourly
part sums the same 24 stamps, so the two splice without a gap or overlap.

Each year's total is cached in .cache/, so an interrupted run resumes.

Output: data/morocco_precip_hydro_years_1976_2026.nc
"""

from __future__ import annotations

import argparse
import datetime as dt
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import xarray as xr
from scipy import stats

from common import (
    ARCO_ERA5_URL,
    BASELINE_YEARS,
    CACHE_DIR,
    ERA5_BBOX,
    FIRST_YEAR,
    LAST_YEAR,
    WB2_DAILY_URL,
    WB2_WEEKLY_URL,
    precip_path,
    season_label,
)

STORAGE_OPTIONS = {"client_kwargs": {"trust_env": True}}
RETRIES = 6
ONE_DAY = pd.Timedelta(days=1)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # More than ~32 parallel downloads makes the egress proxy reset connections.
    p.add_argument("--workers", type=int, default=32, help="parallel chunk downloads")
    return p.parse_args()


class Store:
    """One ERA5 precipitation store, cut to the Morocco box (values in metres)."""

    def __init__(self, url: str, variable: str) -> None:
        ds = xr.open_zarr(url, chunks=None, consolidated=True, storage_options=STORAGE_OPTIONS)
        west, south, east, north = ERA5_BBOX
        # ERA5 longitudes run 0..359.75 and latitudes north -> south.
        self.data = ds[variable].sel(
            latitude=slice(north, south),
            longitude=slice(west % 360.0, (east - 0.25) % 360.0),
        )
        self.times = ds.indexes["time"]
        self.attrs = dict(ds.attrs)

    def index(self, t: pd.Timestamp) -> int:
        return int(self.times.get_loc(t))

    def field(self, i: int) -> np.ndarray:
        for attempt in range(RETRIES):
            try:
                values = self.data.isel(time=i).values.astype(np.float64)
                break
            except Exception:
                if attempt == RETRIES - 1:
                    raise
                time.sleep(2**attempt)
        if not np.isfinite(values).all():
            raise SystemExit(f"Missing ERA5 values at {self.times[i]}")
        return values


class Sources:
    def __init__(self) -> None:
        self.daily = Store(WB2_DAILY_URL, "total_precipitation_24hr")
        # A weekly value at day t is the mean daily total over t .. t+6.
        self.weekly = Store(WB2_WEEKLY_URL, "total_precipitation_24hr")
        self.hourly = Store(ARCO_ERA5_URL, "total_precipitation")
        self.wb2_last_day = self.daily.times[-1]
        self.final_until = pd.Timestamp(self.hourly.attrs["valid_time_stop"]) + ONE_DAY
        self.era5t_until = pd.Timestamp(self.hourly.attrs["valid_time_stop_era5t"]) + ONE_DAY

    def plan(self, year: int) -> list[tuple[Store, int, float]]:
        """(store, time index, weight) for every field that adds up to the year."""
        days = pd.date_range(f"{year}-09-01", f"{year + 1}-08-31", freq="D")
        tasks: list[tuple[Store, int, float]] = []
        d = 0
        while d < len(days):
            day = days[d]
            if d + 7 <= len(days) and day + 6 * ONE_DAY <= self.wb2_last_day:
                tasks.append((self.weekly, self.weekly.index(day), 7.0))
                d += 7
            elif day <= self.wb2_last_day:
                tasks.append((self.daily, self.daily.index(day), 1.0))
                d += 1
            else:
                for h in range(1, 25):
                    stamp = day + pd.Timedelta(hours=h)
                    if stamp > self.era5t_until:
                        raise SystemExit(f"ERA5 does not reach {stamp} yet; cannot finish {season_label(year)}")
                    tasks.append((self.hourly, self.hourly.index(stamp), 1.0))
                d += 1
        return tasks

    def preliminary(self, year: int) -> bool:
        """True if part of the year is still ERA5T rather than final ERA5."""
        return pd.Timestamp(f"{year + 1}-09-01") > self.final_until


def year_total(src: Sources, year: int, workers: int) -> xr.DataArray:
    cache = CACHE_DIR / f"precip_{year}.nc"
    if cache.exists():
        return xr.open_dataarray(cache).load()
    tasks = src.plan(year)
    start = time.time()
    total = np.zeros(src.hourly.data.shape[1:], dtype=np.float64)
    with ThreadPoolExecutor(workers) as pool:
        for field in pool.map(lambda task: task[0].field(task[1]) * task[2], tasks):
            total += field
    out = xr.DataArray(
        (total * 1000.0).astype(np.float32),  # m -> mm
        coords={"latitude": src.hourly.data.latitude.values, "longitude": src.hourly.data.longitude.values},
        dims=("latitude", "longitude"),
        attrs={"era5t": int(src.preliminary(year))},
    )
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out.to_netcdf(cache)
    print(f"  {season_label(year)}: {len(tasks):>5} fields in {time.time() - start:4.0f}s, "
          f"box mean {float(out.mean()):5.0f} mm", flush=True)
    return out


def spi(precip: np.ndarray, baseline: np.ndarray) -> np.ndarray:
    """Standardized Precipitation Index (McKee et al. 1993; WMO-No. 1090).

    Per grid cell, a gamma distribution is fitted to the baseline totals
    (Thom's maximum-likelihood approximation, with a point mass for any zero
    totals) and each total is mapped to the standard-normal quantile of its
    probability. SPI <= -2 is extremely dry, >= +2 extremely wet.
    """
    zero = (baseline <= 0).mean(axis=0)
    wet = np.where(baseline > 0, baseline, np.nan)
    mean = np.nanmean(wet, axis=0)
    a = np.log(mean) - np.nanmean(np.log(wet), axis=0)
    shape = (1.0 + np.sqrt(1.0 + 4.0 * a / 3.0)) / (4.0 * a)
    prob = zero + (1.0 - zero) * stats.gamma.cdf(precip, a=shape, scale=mean / shape)
    return np.clip(stats.norm.ppf(np.clip(prob, 1e-6, 1.0 - 1e-6)), -3.0, 3.0)


def main() -> None:
    args = parse_args()
    src = Sources()
    print(f"WeatherBench 2 to {src.wb2_last_day:%Y-%m-%d}; ARCO-ERA5 final to "
          f"{src.hourly.attrs['valid_time_stop']}, ERA5T to {src.hourly.attrs['valid_time_stop_era5t']}")

    years = list(range(FIRST_YEAR, LAST_YEAR + 1))
    totals = [year_total(src, y, args.workers) for y in years]
    precip = xr.concat(totals, dim=pd.Index(years, name="year"))
    era5t_years = [season_label(y) for y, t in zip(years, totals) if t.attrs.get("era5t")]
    precip.attrs = {}

    y0, y1 = BASELINE_YEARS
    normal = precip.sel(year=slice(y0, y1)).mean("year")
    lon = ((precip.longitude.values + 180.0) % 360.0) - 180.0
    out = xr.Dataset(
        {
            "precip": precip,
            "precip_normal": normal,
            "precip_ratio": precip / normal,
            "spi": precip.copy(data=spi(precip.values, precip.sel(year=slice(y0, y1)).values).astype(np.float32)),
        }
    ).assign_coords(longitude=lon)
    out["precip"].attrs = {"long_name": "total precipitation, 1 Sep - 31 Aug", "units": "mm"}
    out["precip_normal"].attrs = {
        "long_name": f"normal: mean of hydrological years {season_label(y0)}-{season_label(y1)}", "units": "mm",
    }
    out["precip_ratio"].attrs = {"long_name": "precipitation as a fraction of the normal", "units": "1"}
    out["spi"].attrs = {
        "long_name": f"12-month (Sep-Aug) Standardized Precipitation Index, gamma fitted to "
                     f"{season_label(y0)}-{season_label(y1)}",
        "units": "1",
    }
    out["year"].attrs = {"long_name": "first year of the hydrological year (Sep-Aug)"}
    out.attrs = {
        "title": f"Morocco hydrological-year precipitation, {season_label(FIRST_YEAR)}-{season_label(LAST_YEAR)}",
        "source": "ECMWF ERA5 via WeatherBench 2 (gs://weatherbench2) and ARCO-ERA5 (gs://gcp-public-data-arco-era5)",
        "era5t_preliminary_years": ", ".join(era5t_years),
        "history": f"created {dt.datetime.now(dt.timezone.utc):%Y-%m-%d} by 01_fetch_era5_precipitation.py",
    }
    path = precip_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_netcdf(path, encoding={v: {"zlib": True, "complevel": 5} for v in out.data_vars})
    box = out["precip"].mean(("latitude", "longitude"))
    print(f"Wrote {path}  (box-mean normal {float(normal.mean()):.0f} mm)")
    for y, v in zip(years, box.values):
        print(f"  {season_label(y)} {v:6.0f} mm  {100 * v / float(normal.mean()):4.0f}%")


if __name__ == "__main__":
    main()
