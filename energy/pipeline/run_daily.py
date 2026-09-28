"""Daily forecasting run: train, forecast, backtest, publish JSON.

Writes two files that the static dashboard (energy/index.html) reads:
  energy/data/forecast.json   load, PV and weather for yesterday + 3 days
  energy/data/analytics.json  30-day day-ahead error tracking + model card

Run from the repo root:  python energy/pipeline/run_daily.py
"""
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import weather
from config import DATA, FORECAST_DAYS, PV_PLANTS, TRAIN_YEARS, TZ, ZONES
from load_model import ACTUALS, ZoneModel, model_card, zone_weather
from pv_model import plant_output

SHOW_VARS = {
    "temperature_2m": "temp", "apparent_temperature": "feels_like",
    "relative_humidity_2m": "humidity", "wind_speed_10m": "wind",
    "shortwave_radiation": "ghi",
}


def cities() -> dict[str, tuple[float, float]]:
    return {c: (lat, lon) for z in ZONES.values() for c, (lat, lon, _) in z["cities"].items()}


def rnd(s: pd.Series, nd: int = 1) -> list:
    return [None if pd.isna(v) else round(float(v), nd) for v in s]


def iso(idx: pd.DatetimeIndex) -> list[str]:
    return [t.strftime("%Y-%m-%dT%H:%MZ") for t in idx]


def actual_load(model: ZoneModel, wx_d0: pd.DataFrame) -> pd.Series:
    """Measured load when available, otherwise reference load on lead-0 weather."""
    ref = model.reference(wx_d0)
    if model.source == "measured":
        a = pd.read_csv(ACTUALS, parse_dates=["time_utc"])
        a = a[a["zone"] == model.zone].set_index("time_utc")["mw"]
        a.index = pd.to_datetime(a.index, utc=True)
        return a.reindex(ref.index).fillna(ref)
    return ref


def daily(s: pd.Series, how: str = "mean") -> pd.Series:
    """Aggregate to local calendar days, dropping incomplete days at the edges."""
    g = s.groupby(s.index.tz_convert(TZ).date)
    return getattr(g, how)()[g.count() >= 22]


def main():
    city_xy = cities()
    print(f"Fetching training weather for {len(city_xy)} cities…")
    start, end = weather.training_window(TRAIN_YEARS)
    hist = {c: weather.archive(lat, lon, start, end) for c, (lat, lon) in city_xy.items()}

    print("Training zone models…")
    models, hist_ref = {}, []
    for z in ZONES:
        wx = zone_weather(hist, z)
        models[z] = ZoneModel(z).fit(wx)
        hist_ref.append(models[z].reference(wx))
        print(f"  {z}: holdout MAPE {models[z].holdout['mape']:.2f}% ({models[z].source})")
    national_hist = sum(hist_ref).dropna().iloc[-24 * 365:]

    print("Fetching forecasts…")
    fc_city = {c: weather.forecast(lat, lon, 1, FORECAST_DAYS) for c, (lat, lon) in city_xy.items()}
    fc_plant = {p: weather.forecast(v["lat"], v["lon"], 1, FORECAST_DAYS) for p, v in PV_PLANTS.items()}
    idx = next(iter(fc_city.values())).index

    load_fc = {z: models[z].predict(zone_weather(fc_city, z)).reindex(idx) for z in ZONES}
    national = sum(load_fc.values())
    pv_fc = {p: plant_output(PV_PLANTS[p], fc_plant[p]).reindex(idx) for p in PV_PLANTS}
    pv_total = sum(pv_fc.values())

    now = datetime.now(timezone.utc)
    forecast = {
        "generated_utc": now.strftime("%Y-%m-%dT%H:%MZ"),
        "timezone": TZ,
        "times": iso(idx),
        "load": {
            "national": rnd(national, 0),
            "zones": {z: {"label": ZONES[z]["label"], "mw": rnd(load_fc[z], 0)} for z in ZONES},
            "target": models["centre"].source,
        },
        "pv": {
            "total": rnd(pv_total, 1),
            "plants": {p: {"label": v["label"], "capacity_mw": v["mw"], "lat": v["lat"],
                           "lon": v["lon"], "mw": rnd(pv_fc[p], 1)} for p, v in PV_PLANTS.items()},
        },
        "weather": {
            c: {"lat": city_xy[c][0], "lon": city_xy[c][1],
                **{k: rnd(fc_city[c][v].reindex(idx), 1) for v, k in SHOW_VARS.items()}}
            for c in city_xy
        },
    }

    print("Backtesting day-ahead forecasts (previous model runs)…")
    runs_city = {c: weather.previous_runs(lat, lon) for c, (lat, lon) in city_xy.items()}
    runs_plant = {p: weather.previous_runs(v["lat"], v["lon"]) for p, v in PV_PLANTS.items()}
    d0_city = {c: r[0] for c, r in runs_city.items()}
    d1_city = {c: r[1] for c, r in runs_city.items()}

    load_err, nat_fc, nat_act = {}, [], []
    for z, m in models.items():
        f = m.predict(zone_weather(d1_city, z))
        a = actual_load(m, zone_weather(d0_city, z)).reindex(f.index)
        nat_fc.append(f)
        nat_act.append(a)
        load_err[z] = daily((f - a).abs() / a * 100)
    nat_f, nat_a = sum(nat_fc).dropna(), sum(nat_act).dropna()
    load_err["national"] = daily((nat_f - nat_a).abs() / nat_a * 100)

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
    for c in city_xy:
        d0, d1 = d0_city[c], d1_city[c].reindex(d0_city[c].index)
        wx_err[c] = {k: rnd(daily((d1[v] - d0[v]).abs()), 2) for v, k in SHOW_VARS.items()}

    days = sorted(load_err["national"].index)
    recent = nat_f.index[nat_f.index >= nat_f.index.max() - pd.Timedelta(days=7)]
    analytics = {
        "generated_utc": forecast["generated_utc"],
        "days": [d.isoformat() for d in days],
        "method": ("Day-ahead forecast (Open-Meteo run issued the previous day) compared "
                   "with the same model driven by the same-day run. Load 'actual' is the "
                   f"{models['centre'].source} load series."),
        "load_mape": {z: rnd(s.reindex(days), 2) for z, s in load_err.items()},
        "pv_nmae": {p: rnd(s.reindex(days), 2) for p, s in pv_err.items()},
        "pv_energy_mwh": {"fc": rnd(pv_energy["fc"].reindex(days), 0),
                          "act": rnd(pv_energy["act"].reindex(days), 0)},
        "weather_mae": wx_err,
        "recent": {
            "times": iso(recent),
            "load_fc": rnd(nat_f.reindex(recent), 0), "load_act": rnd(nat_a.reindex(recent), 0),
            "pv_fc": rnd(pv_f.reindex(recent), 1), "pv_act": rnd(pv_a.reindex(recent), 1),
        },
        "summary": {
            "load_mape_30d": round(float(load_err["national"].mean()), 2),
            "pv_nmae_30d": round(float(pv_err["total"].mean()), 2),
            "temp_mae_30d": round(float(np.mean([np.nanmean([v for v in e["temp"] if v is not None])
                                                 for e in wx_err.values()])), 2),
        },
        "model": model_card(models, national_hist.max()),
    }

    DATA.mkdir(parents=True, exist_ok=True)
    for name, obj in (("forecast.json", forecast), ("analytics.json", analytics)):
        (DATA / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        print(f"Wrote {DATA / name}")


if __name__ == "__main__":
    main()
