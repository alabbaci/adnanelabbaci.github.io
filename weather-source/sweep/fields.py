"""Load one run into time stacks of plain-unit fields over the domain."""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import config, fetch

log = logging.getLogger(__name__)

SFC = {
    "t2": {"param": "2t"}, "td2": {"param": "2d"}, "msl": {"param": "msl"},
    "u10": {"param": "10u"}, "v10": {"param": "10v"}, "tp": {"param": "tp"}, "sf": {"param": "sf"},
    "tcwv": {"param": "tcwv"}, "cape": {"param": "mucape"}, "z500": {"param": "gh", "levelist": "500"},
}
FINE = {"fg3": {"param": "10fg"}, "fg3b": {"param": "10fg3"}, "mx3": {"param": "mx2t3"}}  # 10fg3 after 90 h
WAVE = {"swh": {"param": "swh"}, "pp1d": {"param": "pp1d"}}
EP = {
    "p_rain50": {"param": "tpg50"}, "p_rain100": {"param": "tpg100"}, "p_rain25": {"param": "tpg25"},
    "p_gust25": {"param": "10fgg25"}, "p_gust15": {"param": "10fgg15"},
    "p_warm2": {"param": "ptsa_gt_2stdev"}, "p_warm15": {"param": "ptsa_gt_1p5stdev"},
}


@dataclass
class Forecast:
    run: fetch.Run
    steps: list[int]
    lsm: np.ndarray
    f: dict[str, np.ndarray] = field(default_factory=dict)          # name -> (nt, ny, nx)
    ens: dict[str, dict[tuple[int, int], np.ndarray]] = field(default_factory=dict)  # 24 h windows
    warm: dict[str, dict[int, np.ndarray]] = field(default_factory=dict)            # 850 hPa anomaly probs

    @property
    def times(self) -> list[dt.datetime]:
        return [self.run.valid(s) for s in self.steps]

    def __getitem__(self, name: str) -> np.ndarray:
        return self.f[name]


def _stack(parts: list[dict], name: str, shape) -> np.ndarray:
    return np.stack([p[name] if name in p else np.full(shape, np.nan, np.float32) for p in parts])


def heat_index(t: np.ndarray, td: np.ndarray) -> np.ndarray:
    """NOAA heat index (°C) from temperature and dew point (°C); equals t below 27 °C."""
    e = 6.112 * np.exp(17.67 * td / (td + 243.5))
    es = 6.112 * np.exp(17.67 * t / (t + 243.5))
    rh = np.clip(100 * e / es, 0, 100)
    tf = t * 9 / 5 + 32
    hi = (-42.379 + 2.04901523 * tf + 10.14333127 * rh - 0.22475541 * tf * rh - 6.83783e-3 * tf ** 2
          - 5.481717e-2 * rh ** 2 + 1.22874e-3 * tf ** 2 * rh + 8.5282e-4 * tf * rh ** 2
          - 1.99e-6 * tf ** 2 * rh ** 2)
    hic = (hi - 32) * 5 / 9
    return np.where(t >= 27, np.maximum(hic, t), t).astype(np.float32)


def load(run: fetch.Run, cache: Path | None) -> Forecast:
    shape = (fetch.NY, fetch.NX)
    jobs = [(run, "oper", "fc", s, SFC | ({"lsm": {"param": "lsm"}} if s == 0 else {})) for s in config.STEPS]
    jobs += [(run, "oper", "fc", s, FINE) for s in config.FINE_STEPS]
    jobs += [(run, "wave", "fc", s, WAVE) for s in config.STEPS]
    jobs += [(run, "enfo", "ep", 240, EP)]
    log.info("fetching %d step files from %s", len(jobs), run.source)
    res = fetch.fetch_many(jobs, cache)
    n = len(config.STEPS)
    sfc, fine, wave, ep = res[:n], res[n:n + len(config.FINE_STEPS)], res[-n - 1:-1], res[-1]

    fc = Forecast(run=run, steps=list(config.STEPS), lsm=sfc[0]["lsm"])
    f = fc.f
    f["t2"] = _stack(sfc, "t2", shape) - 273.15
    f["td2"] = _stack(sfc, "td2", shape) - 273.15
    f["msl"] = _stack(sfc, "msl", shape) / 100
    f["u10"] = _stack(sfc, "u10", shape)
    f["v10"] = _stack(sfc, "v10", shape)
    f["wind10"] = np.hypot(f["u10"], f["v10"])
    f["tcwv"] = _stack(sfc, "tcwv", shape)
    f["cape"] = _stack(sfc, "cape", shape)
    f["z500"] = _stack(sfc, "z500", shape) / 10
    f["swh"] = _stack(wave, "swh", shape)
    f["pp1d"] = _stack(wave, "pp1d", shape)
    f["hi"] = heat_index(f["t2"], f["td2"])

    tp = _stack(sfc, "tp", shape) * 1000
    tp[0] = np.nan_to_num(tp[0])
    sf = _stack(sfc, "sf", shape) * 1000  # mm water equivalent
    sf[0] = np.nan_to_num(sf[0])
    rain6 = np.full_like(tp, np.nan)
    rain6[1:] = np.maximum(tp[1:] - tp[:-1], 0)
    f["rain6"] = rain6
    rain24 = np.full_like(tp, np.nan)
    rain24[4:] = np.maximum(tp[4:] - tp[:-4], 0)
    f["rain24"] = rain24
    snow6 = np.full_like(sf, np.nan)
    snow6[1:] = np.maximum(sf[1:] - sf[:-1], 0) * 1.0  # cm of snow at roughly 10:1
    f["snow6"] = snow6

    # Fold the 3-hourly maxima into the 6-hourly frames: frame k covers (step-6, step].
    fg = {s: p.get("fg3", p.get("fg3b")) for s, p in zip(config.FINE_STEPS, fine)}
    mx = {s: p.get("mx3") for s, p in zip(config.FINE_STEPS, fine)}
    gust = np.full((n,) + shape, np.nan, np.float32)
    tmax = np.full((n,) + shape, np.nan, np.float32)
    for k, s in enumerate(config.STEPS):
        g = [fg[x] for x in (s - 3, s) if fg.get(x) is not None]
        m = [mx[x] for x in (s - 3, s) if mx.get(x) is not None]
        if g:
            gust[k] = np.nanmax(np.stack(g), axis=0)
        if m:
            tmax[k] = np.nanmax(np.stack(m), axis=0) - 273.15
    f["gust"] = gust
    f["tmax"] = tmax

    last = config.STEPS[-1]
    for name in ("p_rain50", "p_rain100", "p_rain25", "p_gust25", "p_gust15"):
        wins = {}
        for key, arr in (ep.get(name) or {}).items():
            a, b = (int(x) for x in key.split("-"))
            if b <= last + 24:
                wins[(a, b)] = arr
        fc.ens[name] = dict(sorted(wins.items()))
    for name in ("p_warm2", "p_warm15"):
        fc.warm[name] = {int(k): v for k, v in sorted((ep.get(name) or {}).items(), key=lambda kv: int(kv[0]))
                         if int(k) <= last}
    log.info("loaded %d frames, %d ensemble windows", n, len(fc.ens.get("p_rain50", {})))
    return fc
