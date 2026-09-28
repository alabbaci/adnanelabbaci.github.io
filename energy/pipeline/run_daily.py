"""Daily forecasting run: train, forecast, backtest, publish JSON.

Writes two files that the static dashboard (energy/index.html) reads, both
organised by Morocco's 12 administrative regions plus a national total:
  energy/data/forecast.json   load, PV and weather for yesterday + 3 days
  energy/data/analytics.json  30-day day-ahead error tracking + model card

Run from the repo root:  python energy/pipeline/run_daily.py
"""
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import weather
from weather import log
from config import DATA, FORECAST_DAYS, PV_PLANTS, REGIONS, TRAIN_YEARS, TZ, demand_share
from load_model import ACTUALS, RegionModel, model_card, region_weather
from pv_model import plant_output

# Days of extra weather history fetched ahead of each window so the lagged
# temperature features (24 h / 72 h thermal memory) are warmed up.
WARMUP_DAYS = 3

SHOW_VARS = {
    "temperature_2m": "temp", "apparent_temperature": "feels_like",
    "relative_humidity_2m": "humidity", "wind_speed_10m": "wind",
    "shortwave_radiation": "ghi",
}


def cities() -> dict[str, tuple[float, float]]:
    return {c: (lat, lon) for r in REGIONS.values() for c, (lat, lon, _) in r["cities"].items()}


def national_weather(by_region: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Demand-weighted national mean of regional weather."""
    return sum(by_region[r] * demand_share(r) for r in REGIONS).dropna()


def rnd(s: pd.Series, nd: int = 1) -> list:
    return [None if pd.isna(v) else round(float(v), nd) for v in s]


def iso(idx: pd.DatetimeIndex) -> list[str]:
    return [t.strftime("%Y-%m-%dT%H:%MZ") for t in idx]


def actual_load(model: RegionModel, wx_d0: pd.DataFrame) -> pd.Series:
    """Measured load when available, otherwise reference load on lead-0 weather."""
    ref = model.reference(wx_d0)
    if model.source == "measured":
        a = pd.read_csv(ACTUALS, parse_dates=["time_utc"])
        a = a[a["region"] == model.region].set_index("time_utc")["mw"]
        a.index = pd.to_datetime(a.index, utc=True)
        return a.reindex(ref.index).fillna(ref)
    return ref


def daily(s: pd.Series, how: str = "mean") -> pd.Series:
    """Aggregate to local calendar days, dropping incomplete days at the edges."""
    g = s.groupby(s.index.tz_convert(TZ).date)
    return getattr(g, how)()[g.count() >= 22]


def weather_block(wx: pd.DataFrame, idx: pd.DatetimeIndex) -> dict:
    return {k: rnd(wx[v].reindex(idx), 1) for v, k in SHOW_VARS.items()}


def main():
    city_xy = cities()
    log(f"Fetching training weather for {len(city_xy)} cities…")
    start, end = weather.training_window(TRAIN_YEARS)
    hist = weather.archive_many(city_xy, start, end)

    log("Training regional models…")
    models, hist_ref = {}, []
    for r in REGIONS:
        wx = region_weather(hist, r)
        models[r] = RegionModel(r).fit(wx)
        hist_ref.append(models[r].reference(wx))
        log(f"  {r}: holdout MAPE {models[r].holdout['mape']:.2f}% ({models[r].source})")
    national_hist = sum(hist_ref).dropna().iloc[-24 * 365:]
    target = models["cs"].source

    log("Fetching forecasts…")
    fc_city = {c: weather.forecast(lat, lon, 1 + WARMUP_DAYS, FORECAST_DAYS) for c, (lat, lon) in city_xy.items()}
    fc_plant = {p: weather.forecast(v["lat"], v["lon"], 1, FORECAST_DAYS) for p, v in PV_PLANTS.items()}
    idx = next(iter(fc_city.values())).index[24 * WARMUP_DAYS:]     # yesterday + forecast days

    fc_region_wx = {r: region_weather(fc_city, r) for r in REGIONS}
    load_fc = {r: models[r].predict(fc_region_wx[r]).reindex(idx) for r in REGIONS}
    pv_fc = {p: plant_output(PV_PLANTS[p], fc_plant[p]).reindex(idx) for p in PV_PLANTS}

    forecast = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "timezone": TZ,
        "times": iso(idx),
        "load_target": target,
        "national": {"load": rnd(sum(load_fc.values()), 0),
                     "weather": weather_block(national_weather(fc_region_wx), idx)},
        "regions": {
            r: {"name": REGIONS[r]["name"], "iso": REGIONS[r]["iso"],
                "share": round(demand_share(r), 4), "cities": list(REGIONS[r]["cities"]),
                "load": rnd(load_fc[r], 0), "weather": weather_block(fc_region_wx[r], idx)}
            for r in REGIONS
        },
        "pv": {
            "total": rnd(sum(pv_fc.values()), 1),
            "plants": {p: {"label": v["label"], "region": v["region"], "capacity_mw": v["mw"],
                           "lat": v["lat"], "lon": v["lon"], "mw": rnd(pv_fc[p], 1)}
                       for p, v in PV_PLANTS.items()},
        },
    }

    log("Backtesting day-ahead forecasts (previous model runs)…")
    runs_city = {c: weather.previous_runs(lat, lon, 31 + WARMUP_DAYS) for c, (lat, lon) in city_xy.items()}
    runs_plant = {p: weather.previous_runs(v["lat"], v["lon"]) for p, v in PV_PLANTS.items()}
    d0_reg = {r: region_weather({c: v[0] for c, v in runs_city.items()}, r) for r in REGIONS}
    d1_reg = {r: region_weather({c: v[1] for c, v in runs_city.items()}, r) for r in REGIONS}
    d0_reg["national"], d1_reg["national"] = national_weather(d0_reg), national_weather(d1_reg)

    fc_s, act_s = {}, {}
    for r, m in models.items():
        fc_s[r] = m.predict(d1_reg[r])
        act_s[r] = actual_load(m, d0_reg[r]).reindex(fc_s[r].index)
    fc_s["national"] = sum(fc_s[r] for r in REGIONS).dropna()
    act_s["national"] = sum(act_s[r] for r in REGIONS).dropna()
    load_err = {k: daily((fc_s[k] - act_s[k]).abs() / act_s[k] * 100) for k in fc_s}

    pv_err, pv_f_all, pv_a_all = {}, [], []
    for p, (d0, d1) in runs_plant.items():
        f, a = plant_output(PV_PLANTS[p], d1), plant_output(PV_PLANTS[p], d0).reindex(d1.index)
        pv_f_all.append(f)
        pv_a_all.append(a)
        pv_err[p] = daily((f - a).abs() / PV_PLANTS[p]["mw"] * 100)
    pv_f, pv_a = sum(pv_f_all).dropna(), sum(pv_a_all).dropna()
    cap = sum(v["mw"] for v in PV_PLANTS.values())
    pv_err["total"] = daily((pv_f - pv_a).abs() / cap * 100)
    pv_energy = pd.DataFrame({"fc": daily(pv_f, "sum"), "act": daily(pv_a, "sum")})

    wx_err = {}
    for k in d0_reg:
        d0, d1 = d0_reg[k], d1_reg[k].reindex(d0_reg[k].index)
        wx_err[k] = {name: daily((d1[v] - d0[v]).abs()) for v, name in SHOW_VARS.items()}

    days = sorted(load_err["national"].index)[WARMUP_DAYS:]        # drop warm-up days
    t_end = fc_s["national"].index.max()
    recent = fc_s["national"].index[fc_s["national"].index >= t_end - pd.Timedelta(days=7)]
    keys = ["national", *REGIONS]
    analytics = {
        "generated_utc": forecast["generated_utc"],
        "days": [d.isoformat() for d in days],
        "method": ("Day-ahead forecast (Open-Meteo run issued the previous day) compared "
                   "with the same model driven by the same-day run. Load 'actual' is the "
                   f"{target} load series."),
        "load_mape": {k: rnd(load_err[k].reindex(days), 2) for k in keys},
        "pv_nmae": {p: rnd(s.reindex(days), 2) for p, s in pv_err.items()},
        "pv_energy_mwh": {"fc": rnd(pv_energy["fc"].reindex(days), 0),
                          "act": rnd(pv_energy["act"].reindex(days), 0)},
        "weather_mae": {k: {n: rnd(s.reindex(days), 2) for n, s in wx_err[k].items()} for k in keys},
        "recent": {
            "times": iso(recent),
            "load": {k: {"fc": rnd(fc_s[k].reindex(recent), 0), "act": rnd(act_s[k].reindex(recent), 0)}
                     for k in keys},
            "pv": {"fc": rnd(pv_f.reindex(recent), 1), "act": rnd(pv_a.reindex(recent), 1)},
        },
        "summary": {
            k: {"load_mape_30d": round(float(load_err[k].mean()), 2),
                "temp_mae_30d": round(float(wx_err[k]["temp"].mean()), 2)}
            for k in keys
        } | {"pv_nmae_30d": round(float(pv_err["total"].mean()), 2)},
        "model": model_card(models, national_hist.max()),
    }

    DATA.mkdir(parents=True, exist_ok=True)
    for name, obj in (("forecast.json", forecast), ("analytics.json", analytics)):
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        (DATA / name).write_text(text)
        log(f"Wrote {DATA / name} ({len(text) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
