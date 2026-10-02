#!/usr/bin/env python3
"""Morocco's rain bank: cumulative rain surplus or deficit since 2002/03.

For every 0.25 deg ERA5 cell, each hydrological year's (Sep-Aug)
precipitation minus the cell's 1991-2020 normal, added up season by season
from 2002/03 (the start of the GRACE era). Positive means more rain has
fallen since 2002 than a run of normal seasons would have brought; negative
means a running deficit.

It stands in for the GRACE groundwater maps, which could not be used here:
GRACE / GRACE-FO and GLDAS servers were unreachable, and ERA5's own deep soil
water has spurious jumps at its production-stream boundaries (layer 4 over
Morocco more than doubles on 1 Jan 2015). Rainfall is the recharge that
groundwater lives on, but this map cannot show pumping.

Input: ../morocco_rainfall_50_years/data/morocco_precip_hydro_years_1976_2026.nc
Output: data/morocco_cumulative_rain_anomaly_2002_2026.nc
"""

from __future__ import annotations

import datetime as dt

import xarray as xr

from common import FIRST_YEAR, LAST_YEAR, PRECIP_PATH, balance_path, season_label


def main() -> None:
    ds = xr.open_dataset(PRECIP_PATH)
    seasons = ds.sel(year=slice(FIRST_YEAR, LAST_YEAR))
    anomaly = seasons["precip"] - seasons["precip_normal"]
    out = xr.Dataset({"season_anomaly": anomaly, "cumulative_anomaly": anomaly.cumsum("year")})
    out["season_anomaly"].attrs = {"long_name": "season precipitation minus the 1991-2020 normal", "units": "mm"}
    out["cumulative_anomaly"].attrs = {
        "long_name": f"cumulative precipitation anomaly since {season_label(FIRST_YEAR)}", "units": "mm",
    }
    out["year"].attrs = {"long_name": "first year of the hydrological year (Sep-Aug)"}
    out.attrs = {
        "title": f"Morocco cumulative precipitation anomaly, {season_label(FIRST_YEAR)}-{season_label(LAST_YEAR)}",
        "source": ds.attrs.get("source", ""),
        "era5t_preliminary_years": ds.attrs.get("era5t_preliminary_years", ""),
        "history": f"created {dt.datetime.now(dt.timezone.utc):%Y-%m-%d} by 01_cumulative_balance.py",
    }
    path = balance_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_netcdf(path, encoding={v: {"zlib": True, "complevel": 5} for v in out.data_vars})
    c = out["cumulative_anomaly"]
    print(f"Wrote {path}  cumulative range {float(c.min()):.0f} .. {float(c.max()):.0f} mm")


if __name__ == "__main__":
    main()
