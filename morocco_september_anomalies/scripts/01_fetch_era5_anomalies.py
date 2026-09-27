#!/usr/bin/env python3
"""Daily September 2 m temperature anomalies over Morocco from ERA5.

For every day of September <year> this computes

    anomaly(day) = daily_mean_t2m(day) - baseline(day)

where the daily mean is the average of the 00/06/12/18 UTC ERA5 fields and
the baseline is the 1991-2020 mean for the same calendar day, smoothed with an
11-day centred window (so each day's normal is built from 30 years x 11 days).

Data are streamed from ARCO-ERA5 on Google Cloud (a public, analysis-ready
copy of ECMWF ERA5); only the Morocco box is kept in memory.

Output: data/morocco_t2m_anomaly_sep<year>.nc
"""

from __future__ import annotations

import argparse
import datetime as dt
import json

from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import xarray as xr

from common import (
    ARCO_ERA5_URL,
    BASELINE_YEARS,
    CACHE_DIR,
    CLIM_WINDOW_DAYS,
    DEFAULT_YEAR,
    ERA5_BBOX,
    ERA5_VARIABLE,
    SYNOPTIC_HOURS,
    anomaly_path,
)

STORAGE_OPTIONS = {"client_kwargs": {"trust_env": True}}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--year", type=int, default=DEFAULT_YEAR, help="September of this year (default: %(default)s)")
    p.add_argument("--workers", type=int, default=32, help="parallel chunk downloads")
    return p.parse_args()


def open_region() -> tuple[xr.DataArray, pd.DatetimeIndex, dict]:
    # chunks=None keeps variables as lazy backend arrays; a dask graph over
    # 1.3M hourly chunks per variable would not fit in memory.
    ds = xr.open_zarr(ARCO_ERA5_URL, chunks=None, consolidated=True, storage_options=STORAGE_OPTIONS)
    west, south, east, north = ERA5_BBOX
    # ERA5 longitudes run 0..359.75 and latitudes north -> south.
    da = ds[ERA5_VARIABLE].sel(
        latitude=slice(north, south),
        longitude=slice(west % 360.0, (east - 0.25) % 360.0),
    )
    return da, ds.indexes["time"], dict(ds.attrs)


def synoptic_times(first: dt.date, last: dt.date) -> pd.DatetimeIndex:
    days = pd.date_range(first, last, freq="D")
    return pd.DatetimeIndex([d + pd.Timedelta(hours=h) for d in days for h in SYNOPTIC_HOURS])


def fetch_daily_means(da: xr.DataArray, time_index: pd.DatetimeIndex, times: pd.DatetimeIndex, workers: int) -> xr.DataArray:
    idx = time_index.get_indexer(times)
    if (idx < 0).any():
        missing = times[idx < 0]
        raise SystemExit(f"ERA5 has no data for {missing[0]} .. {missing[-1]}")
    with ThreadPoolExecutor(workers) as pool:
        fields = list(pool.map(lambda i: da.isel(time=int(i)).load(), idx))
    subset = xr.concat(fields, dim="time")
    daily = subset.resample(time="1D").mean() - 273.15
    return daily.astype(np.float32)


def baseline_daily_means(da, time_index, workers) -> xr.DataArray:
    """1991-2020 daily means for 27 Aug - 5 Oct, cached between runs."""
    half = CLIM_WINDOW_DAYS // 2
    y0, y1 = BASELINE_YEARS
    cache = CACHE_DIR / f"baseline_daily_{y0}_{y1}_w{CLIM_WINDOW_DAYS}.nc"
    if cache.exists():
        return xr.open_dataarray(cache).load()
    parts = []
    for year in range(y0, y1 + 1):
        first = dt.date(year, 9, 1) - dt.timedelta(days=half)
        last = dt.date(year, 9, 30) + dt.timedelta(days=half)
        print(f"  baseline {year}: {first} -> {last}", flush=True)
        parts.append(fetch_daily_means(da, time_index, synoptic_times(first, last), workers))
    daily = xr.concat(parts, dim="time")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    daily.to_netcdf(cache)
    return daily


def smoothed_september_climatology(baseline: xr.DataArray) -> xr.DataArray:
    """Mean by calendar day, then an n-day centred running mean, then Sept only."""
    key = baseline.time.dt.strftime("%m-%d").rename("monthday")
    by_day = baseline.groupby(key).mean("time")  # 27 Aug .. 5 Oct, sorted
    smooth = by_day.rolling(monthday=CLIM_WINDOW_DAYS, center=True).mean()
    sept = [f"09-{d:02d}" for d in range(1, 31)]
    return smooth.sel(monthday=sept)


def main() -> None:
    args = parse_args()
    da, time_index, attrs = open_region()
    print(f"ARCO-ERA5 final data to {attrs.get('valid_time_stop')}, ERA5T to {attrs.get('valid_time_stop_era5t')}")

    # A month still in progress stops at the last day ERA5T covers; the store
    # carries empty (NaN) placeholders beyond that.
    first, last = dt.date(args.year, 9, 1), dt.date(args.year, 9, 30)
    era5t_stop = dt.date.fromisoformat(attrs.get("valid_time_stop_era5t", str(last))[:10])
    last = min(last, era5t_stop)
    if last < first:
        raise SystemExit(f"No ERA5 data for September {args.year} yet (ERA5T ends {era5t_stop})")
    print(f"Fetching September {args.year} ({first} -> {last}) ...", flush=True)
    target = fetch_daily_means(da, time_index, synoptic_times(first, last), args.workers)
    complete = target.notnull().all(("latitude", "longitude"))
    target = target.sel(time=complete)
    if target.sizes["time"] == 0:
        raise SystemExit(f"No ERA5 data for September {args.year} yet")
    last = dt.date.fromisoformat(str(target.time.values[-1])[:10])
    era5t = pd.Timestamp(f"{last}T18") > pd.Timestamp(attrs.get("valid_time_stop", "1900-01-01"))

    print(f"Building {BASELINE_YEARS[0]}-{BASELINE_YEARS[1]} baseline ...", flush=True)
    clim = smoothed_september_climatology(baseline_daily_means(da, time_index, args.workers))
    clim = clim.isel(monthday=slice(0, target.sizes["time"]))
    clim = clim.rename(monthday="time").assign_coords(time=target.time.values)

    lon = ((target.longitude.values + 180.0) % 360.0) - 180.0
    out = xr.Dataset(
        {
            "t2m": target,
            "t2m_normal": clim.astype(np.float32),
            "t2m_anomaly": (target - clim).astype(np.float32),
        }
    ).assign_coords(longitude=lon)
    out["t2m"].attrs = {"long_name": "daily mean 2 m temperature (00/06/12/18 UTC)", "units": "degC"}
    out["t2m_normal"].attrs = {
        "long_name": f"{BASELINE_YEARS[0]}-{BASELINE_YEARS[1]} normal, {CLIM_WINDOW_DAYS}-day centred window",
        "units": "degC",
    }
    out["t2m_anomaly"].attrs = {"long_name": "2 m temperature anomaly", "units": "degC"}
    out.attrs = {
        "title": f"Morocco daily 2 m temperature anomalies, September {args.year}",
        "source": "ECMWF ERA5 via ARCO-ERA5 (gs://gcp-public-data-arco-era5)",
        "era5t_preliminary": int(era5t),
        "last_day": str(last),
        "baseline": f"{BASELINE_YEARS[0]}-{BASELINE_YEARS[1]}",
        "history": f"created {dt.datetime.now(dt.timezone.utc):%Y-%m-%d} by 01_fetch_era5_anomalies.py",
    }
    path = anomaly_path(args.year)
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_netcdf(path, encoding={v: {"zlib": True, "complevel": 5} for v in out.data_vars})

    a = out["t2m_anomaly"]
    print(f"Wrote {path}  anomaly range {float(a.min()):.1f} .. {float(a.max()):.1f} degC")
    print(json.dumps(
        {str(t)[:10]: round(float(v), 2) for t, v in zip(a.time.values, a.mean(("latitude", "longitude")).values)},
        indent=0,
    ))


if __name__ == "__main__":
    main()
