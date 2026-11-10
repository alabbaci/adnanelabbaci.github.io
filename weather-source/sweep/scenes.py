"""Choose the scenes for each highlight and write their frames as small lossless WebP strips.

Each layer of a scene is one image: frames stacked top to bottom, one grid cell per pixel.
Values are 8-bit, 0-254 between `lo` and `hi` (square-root scale for rain and snow), 255 missing.
Wind is one RGB strip with u in red and v in green, 0-254 between -amp and +amp.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from . import config
from .detect import DEG, Item
from .fields import Forecast

LAYERS = {
    "t2": {"label": "Temperature (2 m)", "units": "C", "lo": -10, "hi": 50, "palette": "temp"},
    "tmax": {"label": "Highest temperature in the past 6 h", "units": "C", "lo": -10, "hi": 50, "palette": "temp"},
    "hi": {"label": "Heat index (feels like)", "units": "C", "lo": 20, "hi": 65, "palette": "heat"},
    "td2": {"label": "Dew point (2 m)", "units": "C", "lo": -30, "hi": 30, "palette": "dewpoint"},
    "rain6": {"label": "Rain in the past 6 h", "units": "mm", "lo": 0, "hi": 150, "scale": "sqrt", "palette": "rain"},
    "rain24": {"label": "Rain in the past 24 h", "units": "mm", "lo": 0, "hi": 300, "scale": "sqrt", "palette": "rain"},
    "snow6": {"label": "Snowfall in the past 6 h", "units": "cm", "lo": 0, "hi": 40, "scale": "sqrt", "palette": "snow"},
    "gust": {"label": "Strongest gust in the past 6 h", "units": "ms", "lo": 0, "hi": 50, "palette": "wind"},
    "wind10": {"label": "Wind speed (10 m)", "units": "ms", "lo": 0, "hi": 40, "palette": "wind"},
    "tcwv": {"label": "Total column water vapour", "units": "kgm2", "lo": 0, "hi": 75, "palette": "moisture"},
    "cape": {"label": "Thunderstorm energy (MUCAPE)", "units": "jkg", "lo": 0, "hi": 6000, "scale": "sqrt",
             "palette": "cape"},
    "swh": {"label": "Significant wave height", "units": "m", "lo": 0, "hi": 14, "palette": "waves"},
    "ens_rain50": {"label": "Ensemble chance of more than 50 mm in 24 h", "units": "pct", "lo": 0, "hi": 100,
                   "palette": "prob", "source": ("ens", "p_rain50")},
    "ens_rain100": {"label": "Ensemble chance of more than 100 mm in 24 h", "units": "pct", "lo": 0, "hi": 100,
                    "palette": "prob", "source": ("ens", "p_rain100")},
    "ens_gust25": {"label": "Ensemble chance of gusts over 25 m/s in 24 h", "units": "pct", "lo": 0, "hi": 100,
                   "palette": "prob", "source": ("ens", "p_gust25")},
    "ens_warm2": {"label": "Ensemble chance the 850 hPa temperature is 2 SD above normal", "units": "pct",
                  "lo": 0, "hi": 100, "palette": "probwarm", "source": ("warm", "p_warm2")},
}

# Scenes per leading hazard: (fill layer, isobars?, wind particles?).
RECIPES = {
    "tropical-cyclone": [("tcwv", True, False), ("gust", True, True), ("rain6", True, False), ("ens_rain50", False, False)],
    "heat": [("tmax", False, False), ("t2", True, True), ("ens_warm2", False, False)],
    "humid-heat": [("hi", False, False), ("td2", False, True), ("tmax", False, False)],
    "rain": [("rain6", True, False), ("tcwv", True, True), ("ens_rain50", False, False)],
    "storms": [("cape", False, True), ("rain6", True, False), ("ens_rain50", False, False)],
    "wind": [("gust", True, False), ("wind10", True, True), ("ens_gust25", False, False)],
    "dust": [("wind10", True, True), ("td2", False, True), ("gust", False, False)],
    "waves": [("swh", True, False), ("wind10", True, True)],
    "snow": [("snow6", False, False), ("t2", True, True)],
}
# Layers whose frame k summarises the 6 h ending at step k (so frame 0 is empty).
PAST6 = {"tmax", "gust", "rain6", "snow6"}


@dataclass
class Scene:
    fill: str
    isobars: bool
    particles: bool
    bbox: tuple[float, float, float, float]  # west, south, east, north
    frames: list[int]                        # HRES steps, or window end steps for ensemble layers
    windows: list[tuple[int, int]] = field(default_factory=list)
    title: str = ""
    captions: list[dict] = field(default_factory=list)
    focus: list[dict] = field(default_factory=list)
    package: str = ""
    nbytes: int = 0
    stride: int = 1                          # 2 = every other grid cell (continent-wide scenes)
    meta: dict = field(default_factory=dict)


def scene_bbox(item: Item) -> tuple[float, float, float, float]:
    rows, cols = np.nonzero(item.foot)
    n, s = config.NORTH - rows.min() * config.RES, config.NORTH - rows.max() * config.RES
    w, e = config.WEST + cols.min() * config.RES, config.WEST + cols.max() * config.RES
    lat0 = math.cos(math.radians((n + s) / 2))
    width, height = (e - w) * lat0, n - s
    pad = max(3.0, 0.25 * max(width, height))
    width, height = width + 2 * pad, height + 2 * pad
    width, height = max(width, 14.0), max(height, 11.0)
    if width < height * 1.15:   # landscape-ish boxes suit both the desktop and the phone layout
        width = height * 1.15
    if height < width / 1.9:
        height = width / 1.9
    width, height = min(width, 60.0), min(height, 48.0)
    cx, cy = (w + e) / 2, (n + s) / 2
    half_w, half_h = width / lat0 / 2, height / 2
    w, e = cx - half_w, cx + half_w
    s, n = cy - half_h, cy + half_h
    # Slide (then clip) the box back inside the data domain.
    if w < config.WEST:
        e, w = e + config.WEST - w, config.WEST
    if e > config.EAST:
        w, e = w - (e - config.EAST), config.EAST
    if s < config.SOUTH:
        n, s = n + config.SOUTH - s, config.SOUTH
    if n > config.NORTH:
        s, n = s - (n - config.NORTH), config.NORTH
    snap = lambda v: round(v / config.RES) * config.RES  # noqa: E731
    return (snap(max(w, config.WEST)), snap(max(s, config.SOUTH)), snap(min(e, config.EAST)), snap(min(n, config.NORTH)))


def plan(fc: Forecast, item: Item) -> list[Scene]:
    bbox = scene_bbox(item)
    nt = len(fc.steps)
    k0, k1 = max(item.k0 - 2, 0), min(item.k1 + 2, nt - 1)
    while k1 - k0 < 8:  # at least two days
        k0, k1 = max(k0 - 1, 0), min(k1 + 1, nt - 1)
        if k0 == 0 and k1 == nt - 1:
            break
    s0, s1 = fc.steps[k0], fc.steps[k1]
    recipe = list(RECIPES[item.primary.hazard])
    if item.primary.hazard == "rain" and "storms" in item.hazards:
        recipe.insert(2, ("cape", False, True))
    if item.primary.hazard == "heat" and "humid-heat" in item.hazards:
        recipe.insert(1, ("hi", False, False))

    scenes = []
    for fill, iso, parts in recipe:
        spec = LAYERS[fill]
        src = spec.get("source")
        if src and src[0] == "ens":
            wins = [w for w in fc.ens[src[1]] if w[1] > s0 and w[0] < s1]
            if len(wins) < 2:
                continue
            scenes.append(Scene(fill, False, False, bbox, [b for _, b in wins], windows=wins))
        elif src and src[0] == "warm":
            steps = [s for s in fc.warm[src[1]] if s0 - 12 <= s <= s1 + 12]
            if len(steps) < 2:
                continue
            scenes.append(Scene(fill, False, False, bbox, steps))
        else:
            lo = max(k0, 1) if fill in PAST6 else k0
            scenes.append(Scene(fill, iso, parts, bbox, fc.steps[lo:k1 + 1]))
    return scenes[:4]


def _q(a: np.ndarray, lo: float, hi: float, sqrt: bool = False) -> np.ndarray:
    x = np.clip((a - lo) / (hi - lo), 0, 1)
    if sqrt:
        x = np.sqrt(x)
    q = np.rint(x * 254)
    q[~np.isfinite(a)] = 255
    return q.astype(np.uint8)


def _save(img: Image.Image, path: Path) -> int:
    img.save(path, "WEBP", lossless=True, quality=70, method=4)
    return path.stat().st_size


def write(fc: Forecast, scene: Scene, out_dir: Path, rel: str) -> None:
    """Write one scene's strips into out_dir and fill scene.meta for the feed."""
    out_dir.mkdir(parents=True, exist_ok=True)
    w, s, e, n = scene.bbox
    i0, i1 = int(round((config.NORTH - n) / config.RES)), int(round((config.NORTH - s) / config.RES)) + 1
    j0, j1 = int(round((w - config.WEST) / config.RES)), int(round((e - config.WEST) / config.RES)) + 1
    sl = (slice(i0, i1, scene.stride), slice(j0, j1, scene.stride))
    spec = LAYERS[scene.fill]
    src = spec.get("source")
    if src and src[0] == "ens":
        stack = np.stack([fc.ens[src[1]][win][sl] for win in scene.windows])
    elif src and src[0] == "warm":
        stack = np.stack([fc.warm[src[1]][st][sl] for st in scene.frames])
    else:
        ks = [fc.steps.index(st) for st in scene.frames]
        stack = fc[scene.fill][ks][(slice(None),) + sl]
    nf, ny, nx = stack.shape
    sqrt = spec.get("scale") == "sqrt"
    layers = {"fill": {"file": "fill.webp", "lo": spec["lo"], "hi": spec["hi"], "scale": "sqrt" if sqrt else "linear"}}
    size = _save(Image.fromarray(_q(stack, spec["lo"], spec["hi"], sqrt).reshape(nf * ny, nx), "L"), out_dir / "fill.webp")

    if scene.isobars or scene.particles:
        ks = [fc.steps.index(st) for st in scene.frames]
    if scene.isobars:
        p = fc["msl"][ks][(slice(None),) + sl]
        lo, hi = math.floor(np.nanmin(p)) - 1, math.ceil(np.nanmax(p)) + 1
        layers["mslp"] = {"file": "mslp.webp", "lo": lo, "hi": hi, "scale": "linear"}
        size += _save(Image.fromarray(_q(p, lo, hi).reshape(nf * ny, nx), "L"), out_dir / "mslp.webp")
    if scene.particles:
        u = fc["u10"][ks][(slice(None),) + sl]
        v = fc["v10"][ks][(slice(None),) + sl]
        amp = max(10, 5 * math.ceil(float(np.nanmax(np.abs(np.stack([u, v])))) / 5))
        rgb = np.stack([_q(u, -amp, amp), _q(v, -amp, amp), np.full(u.shape, 128, np.uint8)], axis=-1)
        layers["wind"] = {"file": "wind.webp", "amp": amp}
        size += _save(Image.fromarray(rgb.reshape(nf * ny, nx, 3), "RGB"), out_dir / "wind.webp")

    scene.package = rel
    scene.nbytes = size
    if scene.windows:
        frame_times = [fc.run.valid(b) for _, b in scene.windows]
        kind = "window24"
    else:
        frame_times = [fc.run.valid(st) for st in scene.frames]
        kind = "past6" if scene.fill in PAST6 else "instant"
    scene.meta = {
        "fill": scene.fill, "label": spec["label"], "units": spec["units"], "palette": spec["palette"],
        "kind": kind, "grid": {"west": w, "north": n, "res": config.RES * scene.stride, "nx": nx, "ny": ny},
        "frames": [t.strftime("%Y-%m-%dT%H:%MZ") for t in frame_times], "layers": layers,
    }
