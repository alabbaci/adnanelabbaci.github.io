# ⚡ Morocco Energy Forecasts

An end-to-end, zero-cost energy forecasting platform for Morocco: machine
learning, a daily automated pipeline and a public dashboard, built entirely
on open data. It's modelled on an open forecasting platform built for the
Italian market (Terna + ENTSO-E + Open-Meteo, Streamlit, Turso) and adapted
to what Morocco actually publishes.

**▶ Dashboard: [`energy/index.html`](index.html)**, served by GitHub Pages at `/energy/`.

## Features

| Feature | What it shows |
|---|---|
| **Load forecasting** | Hourly demand for four Moroccan grid zones and the national total, yesterday + 3 days ahead |
| **PV forecasting** | Hourly output of MASEN's utility-scale PV plants (Noor Ouarzazate IV, Noor Laâyoune I, Noor Boujdour I) |
| **Weather analytics** | Temperature, feels-like temperature, wind, solar radiation and humidity for 12 cities |
| **Forecast analytics** | 30-day day-ahead error tracking for load, PV and weather, plus the load model card |

## How it works

```
GitHub Actions (daily 05:17 UTC)
  └─ energy/pipeline/run_daily.py
       ├─ weather.py     Open-Meteo archive (3 y, cached) + forecast + previous runs
       ├─ load_model.py  XGBoost + LightGBM ensemble per zone
       ├─ pv_model.py    pvlib physical model, single-axis trackers
       └─ writes energy/data/forecast.json + analytics.json  → committed to the repo
GitHub Pages
  └─ energy/index.html  static dashboard reading those two JSON files
```

The frontend and the models are separate: the page only reads published
forecasts, so it stays public and free while the training code runs in CI.
The git repository itself is the forecast store, so no external database
account is needed. (The Italian platform uses Turso; swapping one in is a
small change in `run_daily.py` if you want queryable history.)

## Adapting to Morocco: what differs from Italy

| Italy | Morocco | Consequence here |
|---|---|---|
| Terna publishes hourly zonal load | ONEE publishes **no open hourly load** | Models train on a *calibrated reference load* by default (below) |
| ENTSO-E has PV generation | Morocco is **not in ENTSO-E**; no open plant output | PV is forecast **physically** with pvlib instead of ML |
| 7 bidding zones | No market zones | Four demand zones built from ONEE regional areas, weighted by RGPH 2024 population |
| Italian calendar | **Ramadan**, Hijri holidays, the Ramadan UTC+0/+1 clock switch | Dedicated calendar features (`calendar_ma.py`) |

### The reference load (read this before quoting numbers)

Without an open metered series, the load models learn from a reference series
built from real inputs: the hourly Moroccan demand profile with its
lighting-driven evening peak, weekday/weekend and holiday factors, the Ramadan
reshaping (lower daytime, post-iftar peak, suhoor bump), cooling and heating
degree-hours from population-weighted **reanalysis weather**, and ~3.5 %/yr
demand growth. The whole series is scaled to national annual demand
(`NATIONAL_ANNUAL_TWH` in `config.py`). The dashboard labels it as modelled.

**To train on measured data**, add `energy/data/raw/load_actuals.csv` with
columns `time_utc, zone, mw` (zones: `north, centre, south, sahara`). With
at least 60 days of data the ensemble trains on it, and the analytics tab
compares forecasts with the measured values. National data only? Split it
by the zone shares in `config.py`.

### Forecast analytics method

The error tracking uses Open-Meteo's **Previous Runs API**. For each of the
last 30 days, the forecast driven by the weather run issued the *day before*
(day-ahead) is compared with the same model driven by the *same-day* run.
Weather skill is measured the same way. That gives a full 30-day error history
from the first run instead of waiting months for forecasts to accumulate.

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r energy/requirements.txt
python energy/pipeline/run_daily.py          # ~2–4 min first run (downloads 3 y of weather)
python -m http.server                        # then open http://localhost:8000/energy/
```

## Stack

Python · XGBoost · LightGBM · pvlib · pandas · GitHub Actions · GitHub Pages ·
Open-Meteo. Everything runs on free tiers.

## Caveats

- Load values are **modelled** until measured data is added (see above).
  Zone shares and national calibration are assumptions in `config.py`.
- PV covers the **photovoltaic** Noor plants only. Noor Ouarzazate I–III and
  Noor Midelt are concentrated solar (CSP with storage) and aren't modelled.
- Islamic holiday dates follow announced moon sightings and may shift by a
  day. Extend the tables in `calendar_ma.py` each year.

Weather data © Open-Meteo (CC BY 4.0) and its source models (ECMWF, DWD, NOAA, Météo-France).
