"""Download just the GRIB messages we need from ECMWF Open Data, cropped to the domain.

Each run directory has a JSON-lines .index per file listing every message's byte range,
so a field costs one HTTP range request instead of a whole 100 MB step file.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import eccodes
import numpy as np
import requests

from . import config

_local = threading.local()


def _http() -> requests.Session:
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
        _local.s.headers["User-Agent"] = "africa-weather-explorer/0.1"
    return _local.s


def _get(url: str, headers: dict | None = None, timeout: int = 120) -> requests.Response:
    last: Exception | None = None
    for _ in range(4):
        try:
            r = _http().get(url, headers=headers, timeout=timeout)
        except requests.RequestException as e:  # network blip: retry
            last = e
            continue
        if r.status_code in (200, 206):
            return r
        if r.status_code == 404:
            r.raise_for_status()
        last = RuntimeError(f"HTTP {r.status_code} for {url}")
    raise last  # type: ignore[misc]


class Run:
    """One IFS run (date + 00/12 UTC) on one mirror."""

    def __init__(self, base: dt.datetime, source: str):
        self.base = base
        self.source = source

    @property
    def tag(self) -> str:
        return self.base.strftime("%Y%m%dT%HZ")

    def url(self, stream: str, kind: str, step: int, ext: str) -> str:
        d, hh = self.base.strftime("%Y%m%d"), self.base.strftime("%H")
        stamp = self.base.strftime("%Y%m%d%H0000")
        return f"{self.source}/{d}/{hh}z/ifs/0p25/{stream}/{stamp}-{step}h-{stream}-{kind}.{ext}"

    def valid(self, step: int) -> dt.datetime:
        return self.base + dt.timedelta(hours=step)


def latest_run(now: dt.datetime | None = None) -> Run:
    """Newest 00/12 UTC run whose day-6 HRES file and day-10 ensemble products are both out."""
    now = now or dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    base = now.replace(minute=0, second=0, microsecond=0, hour=12 if now.hour >= 12 else 0)
    for _ in range(6):
        for source in config.SOURCES:
            run = Run(base, source)
            try:
                for stream, kind, step in (("oper", "fc", 144), ("enfo", "ep", 240), ("wave", "fc", 144)):
                    _http().head(run.url(stream, kind, step, "index"), timeout=30).raise_for_status()
                return run
            except requests.RequestException:
                continue
        base -= dt.timedelta(hours=12)
    raise RuntimeError("no complete ECMWF open-data run found in the last 3 days")


def _index(run: Run, stream: str, kind: str, step: int) -> list[dict]:
    text = _get(run.url(stream, kind, step, "index")).text
    return [json.loads(line) for line in text.splitlines() if line.strip()]


# Rows run north to south, columns west to east (normalised in _decode).
_ROW0 = int(round((90 - config.NORTH) / config.RES))
_ROW1 = int(round((90 - config.SOUTH) / config.RES)) + 1
_COL0 = int(round((config.WEST + 180) / config.RES))
_COL1 = int(round((config.EAST + 180) / config.RES)) + 1
NY, NX = _ROW1 - _ROW0, _COL1 - _COL0
LATS = config.NORTH - config.RES * np.arange(NY)
LONS = config.WEST + config.RES * np.arange(NX)


_decode_lock = threading.Lock()  # ecCodes' definition parser is not thread-safe


def _decode(blob: bytes) -> np.ndarray:
    with _decode_lock:
        return _decode_unlocked(blob)


def _decode_unlocked(blob: bytes) -> np.ndarray:
    h = eccodes.codes_new_from_message(blob)
    try:
        ni = eccodes.codes_get(h, "Ni")
        nj = eccodes.codes_get(h, "Nj")
        lat0 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees")
        lon0 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
        vals = eccodes.codes_get_values(h).reshape(nj, ni)
        if eccodes.codes_get(h, "bitmapPresent"):
            vals = np.where(vals == eccodes.codes_get(h, "missingValue"), np.nan, vals)
    finally:
        eccodes.codes_release(h)
    if lat0 < 0:
        vals = vals[::-1]
    lon0 = ((lon0 + 180) % 360) - 180
    if abs(lon0 + 180) > 1e-6:  # grid starting elsewhere (e.g. 0E): roll so column 0 is 180W
        vals = np.roll(vals, int(round((lon0 + 180) / config.RES)) % ni, axis=1)
    return vals[_ROW0:_ROW1, _COL0:_COL1].astype(np.float32)


def _matches(row: dict, sel: dict) -> bool:
    return all(str(row.get(k)) == str(v) for k, v in sel.items())


def _cache_file(cache: Path, stream: str, kind: str, step: int, name: str) -> Path:
    return cache / f"{stream}-{kind}-{step}-{name}.npz"


def fetch(run: Run, stream: str, kind: str, step: int, wants: dict[str, dict],
          cache: Path | None = None) -> dict:
    """Fetch the messages matching each selector in `wants` from one step file.

    `wants` maps an output name to index selectors, e.g. {"t850": {"param": "t", "levelist": "850"}}.
    When a selector matches several messages (the 24 h ensemble windows all live in one file)
    the output is a dict keyed by each message's step string, e.g. {"0-24": array, ...}.
    """
    out: dict = {}
    todo = dict(wants)
    if cache:
        for name in list(todo):
            f = _cache_file(cache, stream, kind, step, name)
            if f.exists():
                z = np.load(f)
                out[name] = z["a"] if z.files == ["a"] else {k: z[k] for k in z.files}
                del todo[name]
    if not todo:
        return out
    rows = _index(run, stream, kind, step)
    url = run.url(stream, kind, step, "grib2")
    for name, sel in todo.items():
        hits = [r for r in rows if _matches(r, sel)]
        if not hits:  # e.g. CAPE and 3-hourly maxima don't exist at step 0; the caller fills gaps
            continue
        fields = {}
        for r in hits:
            a, n = r["_offset"], r["_length"]
            fields[str(r.get("step"))] = _decode(_get(url, headers={"Range": f"bytes={a}-{a + n - 1}"}).content)
        out[name] = fields if len(hits) > 1 else next(iter(fields.values()))
        if cache:
            cache.mkdir(parents=True, exist_ok=True)
            f = _cache_file(cache, stream, kind, step, name)
            np.savez_compressed(f, **fields) if len(hits) > 1 else np.savez_compressed(f, a=out[name])
    return out


def fetch_many(jobs: list[tuple], cache: Path | None, workers: int = 8) -> list[dict]:
    """Run fetch() for many (run, stream, kind, step, wants) jobs in parallel, keeping order."""
    workers = int(os.environ.get("AWX_WORKERS", workers))
    with ThreadPoolExecutor(workers) as pool:
        return list(pool.map(lambda j: fetch(*j, cache=cache), jobs))
