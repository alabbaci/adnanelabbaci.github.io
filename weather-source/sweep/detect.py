"""Find the notable weather in a run: rule-based candidates per hazard, then merged into highlights.

Thresholds are set for Africa, where 35 °C or 50 mm in a day is ordinary in many places, so most
rules either use high absolute thresholds or ask the ensemble whether the event is unusual.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage

from . import config
from .fetch import LATS, LONS
from .fields import Forecast
from .geo import Geo

DEG = int(round(1 / config.RES))  # grid cells per degree


@dataclass
class Candidate:
    hazard: str
    score: float
    foot: np.ndarray            # 2D footprint
    k0: int
    k1: int
    k_peak: int
    peak: float
    lat: float
    lon: float
    area_km2: float
    info: dict = field(default_factory=dict)


@dataclass
class Item:
    primary: Candidate
    others: list[Candidate] = field(default_factory=list)

    @property
    def all(self) -> list[Candidate]:
        return [self.primary, *self.others]

    @property
    def score(self) -> float:
        return self.primary.score + 0.25 * sum(c.score for c in self.others)

    @property
    def hazards(self) -> list[str]:
        out = []
        for c in self.all:
            if c.hazard not in out:
                out.append(c.hazard)
        return out

    @property
    def foot(self) -> np.ndarray:
        f = self.primary.foot.copy()
        for c in self.others:
            f |= c.foot
        return f

    @property
    def k0(self) -> int:
        return min(c.k0 for c in self.all)

    @property
    def k1(self) -> int:
        return max(c.k1 for c in self.all)


def _area_factor(km2: float) -> float:
    return math.log10(1 + km2 / 2e4)


def _pop_factor(geo: Geo, foot: np.ndarray) -> tuple[float, int]:
    pop = 0
    for p in geo.places:
        i = int(round((config.NORTH - p["lat"]) / config.RES))
        j = int(round((p["lon"] - config.WEST) / config.RES))
        if 0 <= i < foot.shape[0] and 0 <= j < foot.shape[1] and foot[i, j]:
            pop += p["pop"]
    return math.log10(1 + pop / 1e5), pop


def _blobs(geo: Geo, hazard: str, exceed: np.ndarray, value: np.ndarray, allowed: np.ndarray,
           min_km2: float = 8000, join_deg: float = 1.0) -> list[Candidate]:
    """Connected areas where `exceed` holds at some time, with their peak and active period."""
    exceed = exceed & allowed[None]
    foot = exceed.any(axis=0)
    if not foot.any():
        return []
    joined = ndimage.binary_dilation(foot, iterations=max(1, int(join_deg * DEG)))
    labels, n = ndimage.label(joined)
    out = []
    for lab in range(1, n + 1):
        comp = foot & (labels == lab)
        area = float(geo.area[comp].sum())
        if area < min_km2:
            continue
        ex = exceed & comp[None]
        v = np.where(ex, value, -np.inf)
        flat = int(np.argmax(v))
        k, i, j = np.unravel_index(flat, v.shape)
        active = np.nonzero(ex.any(axis=(1, 2)))[0]
        out.append(Candidate(hazard, 0.0, comp, int(active[0]), int(active[-1]), int(k), float(v[k, i, j]),
                             float(LATS[i]), float(LONS[j]), area))
    return out


def _ens_max(fc: Forecast, name: str, foot: np.ndarray, k0: int, k1: int) -> float:
    """Highest ensemble probability inside the footprint over windows overlapping the event."""
    s0, s1 = fc.steps[k0], fc.steps[k1]
    best = 0.0
    for (a, b), arr in fc.ens.get(name, {}).items():
        if b > s0 and a < s1 + 6:
            best = max(best, float(np.nanmax(np.where(foot, arr, 0))))
    return best


def _warm_stack(fc: Forecast, name: str) -> np.ndarray:
    """The 850 hPa warm-anomaly probability nearest in time to each frame."""
    warm = fc.warm.get(name, {})
    out = np.zeros_like(fc["t2"])
    if not warm:
        return out
    keys = np.array(sorted(warm))
    for k, s in enumerate(fc.steps):
        out[k] = warm[int(keys[np.argmin(np.abs(keys - s))])]
    return out


def heat(fc: Forecast, geo: Geo) -> list[Candidate]:
    tmax = np.nan_to_num(fc["tmax"], nan=-99)
    pwarm = _warm_stack(fc, "p_warm2")
    exceed = (tmax >= 41) | ((tmax >= 38) & (pwarm >= 60))
    out = []
    for c in _blobs(geo, "heat", exceed, tmax, geo.african_land, min_km2=15000, join_deg=0.5):
        pw = float(np.max(np.where(c.foot[None], pwarm, 0)))
        popf, pop = _pop_factor(geo, c.foot)
        c.info = {"p_warm2": pw, "pop": pop, "area40": float(geo.area[c.foot & (tmax >= 40).any(0)].sum())}
        c.score = 1.0 + (c.peak - 39) * 0.6 + pw / 30 + _area_factor(c.area_km2) + popf
        out.append(c)
    return out


def humid_heat(fc: Forecast, geo: Geo) -> list[Candidate]:
    hi = np.nan_to_num(fc["hi"], nan=-99)
    out = []
    for c in _blobs(geo, "humid-heat", hi >= 44, hi, geo.african_land, min_km2=3000):
        popf, pop = _pop_factor(geo, c.foot)
        t = fc["t2"][c.k_peak]
        td = fc["td2"][c.k_peak]
        i, j = _ij(c.lat, c.lon)
        c.info = {"pop": pop, "t": float(t[i, j]), "td": float(td[i, j])}
        c.score = 1.0 + (c.peak - 43) * 0.4 + _area_factor(c.area_km2) + 1.3 * popf
        out.append(c)
    return out


def rain(fc: Forecast, geo: Geo) -> list[Candidate]:
    r24 = np.nan_to_num(fc["rain24"])
    lat = LATS[:, None] * np.ones_like(geo.lsm)
    threshold = np.where(np.abs(lat) < 12, 70.0, 45.0)
    allowed = geo.african_land | (geo.region & (geo.coast_km < 60))
    out = []
    for c in _blobs(geo, "rain", r24 >= threshold[None], r24, allowed, min_km2=6000):
        p50 = _ens_max(fc, "p_rain50", c.foot, c.k0, c.k1)
        p100 = _ens_max(fc, "p_rain100", c.foot, c.k0, c.k1)
        popf, pop = _pop_factor(geo, c.foot)
        c.info = {"p_rain50": p50, "p_rain100": p100, "pop": pop}
        c.score = 0.5 + c.peak / 45 + p50 / 35 + _area_factor(c.area_km2) + popf
        out.append(c)
    return out


def _desert(fc: Forecast, geo: Geo) -> np.ndarray:
    return geo.african_land & (np.nanmean(fc["tcwv"], axis=0) < 20) & (np.nanmean(fc["td2"], axis=0) < 5)


def wind(fc: Forecast, geo: Geo) -> list[Candidate]:
    gust = np.nan_to_num(fc["gust"])
    desert = _desert(fc, geo)
    land = geo.african_land & ~desert
    sea = geo.region & ~geo.land & (geo.coast_km < 150)
    exceed = (land[None] & (gust >= 22)) | (sea[None] & (gust >= 26))
    out = []
    for c in _blobs(geo, "wind", exceed, gust, land | sea, min_km2=5000):
        pg = _ens_max(fc, "p_gust25", c.foot, c.k0, c.k1)
        popf, pop = _pop_factor(geo, c.foot)
        c.info = {"p_gust25": pg, "pop": pop}
        c.score = 0.5 + (c.peak - 20) / 3 + pg / 30 + _area_factor(c.area_km2) + popf
        out.append(c)
    return out


def dust(fc: Forecast, geo: Geo) -> list[Candidate]:
    gust = np.nan_to_num(fc["gust"])
    w10 = np.nan_to_num(fc["wind10"])
    dry = (fc["t2"] - fc["td2"]) >= 15
    exceed = ((w10 >= 11) | (gust >= 18)) & dry
    out = []
    for c in _blobs(geo, "dust", exceed, gust, _desert(fc, geo), min_km2=40000, join_deg=1.5):
        popf, pop = _pop_factor(geo, c.foot)
        i, j = _ij(c.lat, c.lon)
        c.info = {"pop": pop, "wind10": float(w10[c.k_peak, i, j]),
                  "area11": float(geo.area[c.foot & (w10 >= 11).any(0)].sum())}
        c.score = (c.peak - 16) / 3 + 1.2 * _area_factor(c.area_km2) + 0.7 * popf
        out.append(c)
    return out


def storms(fc: Forecast, geo: Geo) -> list[Candidate]:
    cape = np.nan_to_num(fc["cape"])
    r6 = np.nan_to_num(fc["rain6"])
    lat = np.abs(LATS)[:, None] * np.ones_like(geo.lsm)
    exceed = (cape >= 2500) & (r6 >= 5) & (lat[None] >= 16) | (cape >= 4000) & (r6 >= 15)
    out = []
    for c in _blobs(geo, "storms", exceed, cape, geo.african_land, min_km2=8000):
        popf, pop = _pop_factor(geo, c.foot)
        c.info = {"pop": pop, "rain6": float(np.max(np.where(c.foot[None], r6, 0)))}
        c.score = (c.peak - 2000) / 1200 + _area_factor(c.area_km2) + popf
        out.append(c)
    return out


def waves(fc: Forecast, geo: Geo) -> list[Candidate]:
    swh = np.nan_to_num(fc["swh"])
    sea = geo.region & ~geo.land & (geo.coast_km < 250)
    out = []
    for c in _blobs(geo, "waves", swh >= 4.5, swh, sea, min_km2=10000):
        coastal = ndimage.binary_dilation(c.foot, iterations=2 * DEG)
        popf, pop = _pop_factor(geo, coastal)
        i, j = _ij(c.lat, c.lon)
        c.info = {"pop": pop, "period": float(np.nan_to_num(fc["pp1d"][c.k_peak, i, j]))}
        c.score = (c.peak - 4.5) * 1.1 + 0.5 * _area_factor(c.area_km2) + popf + c.info["period"] / 15
        out.append(c)
    return out


def snow(fc: Forecast, geo: Geo) -> list[Candidate]:
    s6 = np.nan_to_num(fc["snow6"])
    total = np.cumsum(s6, axis=0)
    out = []
    for c in _blobs(geo, "snow", (total >= 5) & (s6 > 0.2), total, geo.african_land, min_km2=1500):
        popf, pop = _pop_factor(geo, ndimage.binary_dilation(c.foot, iterations=DEG))
        c.info = {"pop": pop}
        c.score = 2.0 + c.peak / 15 + _area_factor(c.area_km2) + popf
        out.append(c)
    return out


def _ij(lat: float, lon: float) -> tuple[int, int]:
    return int(round((config.NORTH - lat) / config.RES)), int(round((lon - config.WEST) / config.RES))


def cyclones(fc: Forecast, geo: Geo) -> list[Candidate]:
    """Track closed, moist, windy lows in the tropics and subtropics from frame to frame."""
    msl = fc["msl"]
    tracks: list[list[dict]] = []
    open_tracks: list[list[dict]] = []
    lat2d = LATS[:, None] * np.ones_like(geo.lsm)
    for k in range(len(fc.steps)):
        p = ndimage.gaussian_filter(np.nan_to_num(msl[k], nan=1013), 1)
        mins = (p == ndimage.minimum_filter(p, size=4 * DEG + 1)) & (p <= 1007) & \
               (np.abs(lat2d) >= 4) & (np.abs(lat2d) <= 35)
        env = ndimage.uniform_filter(p, size=8 * DEG + 1)
        pts = []
        for i, j in zip(*np.nonzero(mins)):
            if env[i, j] - p[i, j] < 3.5:
                continue
            sl = (slice(max(i - 2 * DEG, 0), i + 2 * DEG + 1), slice(max(j - 2 * DEG, 0), j + 2 * DEG + 1))
            vmax = float(np.nanmax(fc["wind10"][k][sl]))
            moist = float(np.nanmean(fc["tcwv"][k][sl]))
            if vmax < 12 or moist < 45:
                continue
            pts.append({"k": k, "lat": float(LATS[i]), "lon": float(LONS[j]), "p": float(msl[k, i, j]),
                        "vmax": vmax, "gust": float(np.nanmax(np.nan_to_num(fc["gust"][k][sl]))),
                        "land": bool(geo.land[i, j]), "i": int(i), "j": int(j)})
        still = []
        for t in open_tracks:
            last = t[-1]
            near = [q for q in pts if abs(q["lat"] - last["lat"]) < 4 and abs(q["lon"] - last["lon"]) < 5]
            if near:
                q = min(near, key=lambda q: (q["lat"] - last["lat"]) ** 2 + (q["lon"] - last["lon"]) ** 2)
                pts.remove(q)
                t.append(q)
                still.append(t)
            else:
                tracks.append(t)
        open_tracks = still + [[q] for q in pts]
    tracks += open_tracks

    out = []
    for t in tracks:
        if len(t) < 4 or t[0]["land"] or max(q["vmax"] for q in t) < 16:
            continue
        if not any(geo.region[q["i"], q["j"]] for q in t):
            continue
        foot = np.zeros_like(geo.land)
        for q in t:
            foot[max(q["i"] - 3 * DEG, 0):q["i"] + 3 * DEG + 1, max(q["j"] - 3 * DEG, 0):q["j"] + 3 * DEG + 1] = True
        deepest = min(t, key=lambda q: q["p"])
        landfall = next((q for q in t if q["land"]), None)
        r24 = np.nan_to_num(fc["rain24"])
        popf, pop = _pop_factor(geo, foot & geo.land)
        c = Candidate("tropical-cyclone", 0.0, foot, t[0]["k"], t[-1]["k"], deepest["k"], deepest["p"],
                      deepest["lat"], deepest["lon"], float(geo.area[foot].sum()))
        c.info = {"track": [{k: q[k] for k in ("k", "lat", "lon", "p", "vmax", "gust", "land")} for q in t],
                  "landfall": landfall, "vmax": max(q["vmax"] for q in t), "gust": max(q["gust"] for q in t),
                  "rain24": float(np.max(np.where(foot[None], r24, 0))), "pop": pop,
                  "p_rain50": _ens_max(fc, "p_rain50", foot & geo.land, c.k0, c.k1)}
        c.score = 6 + (1005 - c.peak) / 6 + c.info["vmax"] / 10 + popf + (2 if landfall else 0)
        out.append(c)
    return out


# Which hazards a highlight led by one hazard may absorb when they overlap in space and time.
ABSORBS = {
    "tropical-cyclone": {"rain", "wind", "waves", "storms"},
    "rain": {"storms", "wind"},
    "storms": {"rain", "wind"},
    "wind": {"waves", "rain", "dust"},
    "waves": {"wind"},
    "heat": {"humid-heat", "dust"},
    "humid-heat": {"heat"},
    "dust": {"wind", "heat"},
    "snow": {"wind", "rain", "storms"},
}
PER_HAZARD = 4


def find(fc: Forecast, geo: Geo, limit: int = config.MAX_ITEMS) -> list[Item]:
    cands: list[Candidate] = []
    for rule in (cyclones, heat, humid_heat, rain, wind, dust, storms, waves, snow):
        cands += rule(fc, geo)
    # The peak must be over Africa or its nearby seas.
    cands = [c for c in cands if geo.region[_ij(c.lat, c.lon)]]
    cands.sort(key=lambda c: -c.score)

    items: list[Item] = []
    for c in cands:
        grown = ndimage.binary_dilation(c.foot, iterations=2 * DEG)
        home = None
        for it in items:
            if c.hazard not in ABSORBS.get(it.primary.hazard, set()) and c.hazard != it.primary.hazard:
                continue
            if c.k0 > it.k1 + 2 or c.k1 < it.k0 - 2:
                continue
            if (grown & it.foot).any():
                home = it
                break
        if home is None:
            items.append(Item(c))
        else:
            home.others.append(c)

    items.sort(key=lambda it: -it.score)
    picked, count = [], {}
    for it in items:
        h = it.primary.hazard
        if count.get(h, 0) >= PER_HAZARD or it.score < 1.0:
            continue
        count[h] = count.get(h, 0) + 1
        picked.append(it)
        if len(picked) == limit:
            break
    return picked
