#!/usr/bin/env python3
"""Render the day-by-day September anomaly animation with forge3d.

Each day's ERA5 anomaly field is interpolated onto the 1 km terrain grid and
draped over Morocco's relief in the forge3d terrain viewer. Two forge3d passes
are combined per frame:

* a relief pass (neutral grey overlay, lit, shadows + ambient occlusion)
  rendered once, because the camera and sun never move;
* a colour pass (the day's anomaly colours with ``preserve_colors`` so they
  match the legend exactly) rendered for every frame.

The colour pass is multiplied by the relief shading, framed with a title,
date, colour bar and a 30-day strip of the Morocco-wide mean, and encoded
with ffmpeg to MP4 and GIF.

Needs a GPU, or a software Vulkan driver (Mesa lavapipe) plus a display;
on a headless Linux box run it under ``xvfb-run``.

Outputs: output/morocco_t2m_anomaly_sep<year>.mp4 / .gif / _peak.png
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
import xarray as xr
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

import forge3d as f3d

from common import BASELINE_YEARS, CACHE_DIR, DEFAULT_YEAR, OUTPUT_DIR, anomaly_path, dem_path

# --- look ------------------------------------------------------------------

CANVAS = (1920, 1080)
MAP_BOX = (30, 20, 1170, 1060)  # where the rendered country is fitted
RENDER_SIZE = (1600, 1600)
VERTICAL_EXAGGERATION = 15.0
CAMERA = {"phi": 90.0, "theta": 38.0, "radius": 3900.0, "fov": 24.0}
SUN = {"sun_azimuth": 300.0, "sun_elevation": 28.0, "sun_intensity": 1.5, "ambient": 0.62, "shadow": 0.45}
PBR = {
    "enabled": True,
    "shadow_technique": "pcss",
    "shadow_map_res": 4096,
    "exposure": 1.0,
    "msaa": 8,
    "normal_strength": 0.6,
    "height_ao": {
        "enabled": True, "directions": 10, "steps": 16, "max_distance": 160.0,
        "strength": 0.14, "resolution_scale": 0.8,
    },
    "tonemap": {"operator": "aces", "white_point": 6.0},
}
RELIEF_STRENGTH = 0.9

BG = (252, 252, 251)
INK = (29, 29, 27)
INK_2 = (84, 84, 80)
MUTED = (128, 127, 121)
RULE = (224, 223, 219)

# Diverging blue <-> red with a neutral grey midpoint (ColorBrewer RdBu arms).
ANOMALY_LIMIT = 10.0  # degC; values beyond are clipped to the end colours
DIVERGING_STOPS = [
    (-10.0, "#053061"), (-7.5, "#2166ac"), (-5.0, "#4393c3"), (-2.5, "#92c5de"), (-1.0, "#d1e5f0"),
    (0.0, "#f0efec"),
    (1.0, "#fddbc7"), (2.5, "#f4a582"), (5.0, "#d6604d"), (7.5, "#b2182b"), (10.0, "#67001f"),
]

FPS = 24
FRAMES_PER_DAY = 8
HOLD_FIRST_S = 1.0
HOLD_LAST_S = 2.5

GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800"
FALLBACK_FONTS = {
    400: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    600: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    800: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--year", type=int, default=DEFAULT_YEAR)
    p.add_argument("--preview", type=int, metavar="DAY", help="render a single composed frame for this day and stop")
    p.add_argument("--frames-per-day", type=int, default=FRAMES_PER_DAY)
    return p.parse_args()


# --- colour ----------------------------------------------------------------

def _hex(c: str) -> np.ndarray:
    return np.array([int(c[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


STOP_VALUES = np.array([v for v, _ in DIVERGING_STOPS], dtype=np.float32)
STOP_RGB = np.stack([_hex(c) for _, c in DIVERGING_STOPS])


def anomaly_rgb(values: np.ndarray) -> np.ndarray:
    v = np.clip(values, -ANOMALY_LIMIT, ANOMALY_LIMIT)
    return np.stack([np.interp(v, STOP_VALUES, STOP_RGB[:, i]) for i in range(3)], axis=-1)


# --- data ------------------------------------------------------------------

def load_fields(year: int):
    """Daily anomalies on the terrain grid, plus the Morocco-wide mean per day."""
    ds = xr.open_dataset(anomaly_path(year))
    anom = ds["t2m_anomaly"].transpose("time", "latitude", "longitude")
    lat, lon = anom.latitude.values, anom.longitude.values
    res = float(abs(lat[1] - lat[0]))
    src_transform = from_origin(float(lon.min()) - res / 2, float(lat.max()) + res / 2, res, res)
    src = anom.values if lat[0] > lat[-1] else anom.values[:, ::-1, :]

    with rasterio.open(dem_path()) as dem_src:
        dem = dem_src.read(1)
        valid = dem != dem_src.nodata
        fields = np.zeros((src.shape[0],) + dem.shape, dtype=np.float32)
        for i in range(src.shape[0]):
            reproject(
                src[i].astype(np.float32), fields[i],
                src_transform=src_transform, src_crs="EPSG:4326",
                dst_transform=dem_src.transform, dst_crs=dem_src.crs,
                resampling=Resampling.cubic_spline,
            )
    # Equal-area grid, so a plain mean over land pixels is area-weighted.
    national = fields[:, valid].mean(axis=1)
    dates = [dt.date.fromisoformat(str(t)[:10]) for t in ds.time.values]
    return fields, valid, dem, national, dates, bool(ds.attrs.get("era5t_preliminary", 0))


def write_render_surface(dem: np.ndarray, valid: np.ndarray, path: Path) -> None:
    """The viewer clamps orbit radius, so render in 1 unit = 1 grid cell (1 km)
    with heights in km x exaggeration instead of metres."""
    surface = np.where(valid, dem / 1000.0 * VERTICAL_EXAGGERATION, -9999.0).astype(np.float32)
    profile = dict(
        driver="GTiff", width=dem.shape[1], height=dem.shape[0], count=1, dtype="float32",
        transform=from_origin(0.0, float(dem.shape[0]), 1.0, 1.0), nodata=-9999.0,
    )
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(surface, 1)


def rgba_overlay(rgb: np.ndarray, valid: np.ndarray, path: Path) -> None:
    rgba = np.zeros(valid.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = np.round(np.clip(rgb, 0, 255)).astype(np.uint8)
    rgba[..., 3] = np.where(valid, 255, 0)
    Image.fromarray(rgba, "RGBA").save(path)


# --- fonts -----------------------------------------------------------------

def font_files() -> dict[int, Path]:
    out: dict[int, Path] = {}
    font_dir = CACHE_DIR / "fonts"
    try:
        font_dir.mkdir(parents=True, exist_ok=True)
        if not all((font_dir / f"Inter-{w}.ttf").exists() for w in FALLBACK_FONTS):
            with urllib.request.urlopen(GOOGLE_FONTS_CSS, timeout=30) as r:
                css = r.read().decode()
            for weight, url in re.findall(r"font-weight: (\d+);\s*src: url\((https://[^)]+\.ttf)\)", css):
                (font_dir / f"Inter-{weight}.ttf").write_bytes(urllib.request.urlopen(url, timeout=30).read())
        for w in FALLBACK_FONTS:
            out[w] = font_dir / f"Inter-{w}.ttf"
            if not out[w].exists():
                raise FileNotFoundError(out[w])
    except Exception as exc:  # offline: fall back to DejaVu
        print(f"Inter unavailable ({exc}); using DejaVu Sans")
        out = {w: Path(p) for w, p in FALLBACK_FONTS.items()}
    return out


class Fonts:
    def __init__(self) -> None:
        self.files = font_files()

    def __call__(self, size: int, weight: int = 400) -> ImageFont.FreeTypeFont:
        return ImageFont.truetype(str(self.files[weight]), size)


# --- forge3d ---------------------------------------------------------------

class TerrainRenderer:
    """One forge3d viewer session; the camera and sun stay fixed."""

    def __init__(self, surface_path: Path, workdir: Path) -> None:
        self.workdir = workdir
        self.viewer = f3d.open_viewer_async(
            terrain_path=surface_path, width=1000, height=1000, timeout=600
        )
        self.viewer.send_ipc({"cmd": "set_terrain", **CAMERA, "zscale": 1.0, **SUN, "background": [c / 255 for c in BG]})
        self.viewer.send_ipc({"cmd": "set_terrain_pbr", **PBR})
        self.viewer.send_ipc({"cmd": "set_overlays_enabled", "enabled": True})
        self.viewer.send_ipc({"cmd": "set_overlay_solid", "solid": False})
        self.n = 0

    def render(self, rgb: np.ndarray, valid: np.ndarray, *, preserve_colors: bool) -> np.ndarray:
        self.n += 1
        overlay = self.workdir / f"overlay_{self.n % 2}.png"
        shot = self.workdir / "shot.png"
        rgba_overlay(rgb, valid, overlay)
        self.viewer.load_overlay("anomaly", overlay, extent=(0.0, 0.0, 1.0, 1.0), opacity=1.0,
                                 preserve_colors=preserve_colors)
        self.viewer.snapshot(shot, width=RENDER_SIZE[0], height=RENDER_SIZE[1])
        return np.asarray(Image.open(shot).convert("RGB"), dtype=np.float32)

    def close(self) -> None:
        self.viewer.close()


def static_passes(renderer: TerrainRenderer, valid: np.ndarray):
    """Screen-space country mask and relief shading (camera never moves)."""
    black = np.zeros(valid.shape + (3,), dtype=np.float32)
    mask_img = renderer.render(black, valid, preserve_colors=True)
    darkness = 1.0 - mask_img.mean(axis=2) / np.mean(BG)
    alpha = np.clip((darkness - 0.15) / 0.7, 0.0, 1.0)

    grey = np.full(valid.shape + (3,), 170.0, dtype=np.float32)
    relief = renderer.render(grey, valid, preserve_colors=False).mean(axis=2)
    inside = alpha > 0.99
    shade = relief / np.median(relief[inside])
    shade = np.clip(1.0 + (shade - 1.0) * RELIEF_STRENGTH, 0.35, 1.6)
    return alpha, shade


def shade_colours(colour: np.ndarray, shade: np.ndarray) -> np.ndarray:
    s = shade[..., None]
    darker = colour * s
    lighter = colour + (255.0 - colour) * (s - 1.0) * 0.6
    return np.where(s < 1.0, darker, lighter)


# --- composition -----------------------------------------------------------

class Composer:
    def __init__(self, alpha: np.ndarray, national: np.ndarray, dates: list[dt.date], preliminary: bool) -> None:
        self.fonts = Fonts()
        self.national = national
        self.dates = dates
        self.preliminary = preliminary

        ys, xs = np.nonzero(alpha > 0.02)
        pad = 12
        self.crop = (max(xs.min() - pad, 0), max(ys.min() - pad, 0),
                     min(xs.max() + pad, alpha.shape[1]), min(ys.max() + pad, alpha.shape[0]))
        cw, ch = self.crop[2] - self.crop[0], self.crop[3] - self.crop[1]
        bw, bh = MAP_BOX[2] - MAP_BOX[0], MAP_BOX[3] - MAP_BOX[1]
        self.scale = min(bw / cw, bh / ch)
        self.map_size = (int(round(cw * self.scale)), int(round(ch * self.scale)))
        self.map_xy = (MAP_BOX[0] + (bw - self.map_size[0]) // 2, MAP_BOX[1] + (bh - self.map_size[1]) // 2)

        self.alpha = Image.fromarray(np.round(alpha * 255).astype(np.uint8), "L").crop(self.crop).resize(
            self.map_size, Image.LANCZOS)
        self.base = self._static_base()

    def _static_base(self) -> Image.Image:
        canvas = Image.new("RGB", CANVAS, BG)
        # soft contact shadow under the country
        shadow = Image.new("L", CANVAS, 0)
        shadow.paste(self.alpha, (self.map_xy[0] + 10, self.map_xy[1] + 14))
        shadow = shadow.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.22))
        canvas.paste(Image.new("RGB", CANVAS, (60, 58, 52)), (0, 0), shadow)

        d = ImageDraw.Draw(canvas)
        f = self.fonts
        x = 1230
        year = self.dates[0].year
        d.text((x, 92), f"MOROCCO  ·  SEPTEMBER {year}", font=f(22, 600), fill=MUTED)
        d.text((x, 124), "Daily temperature", font=f(56, 800), fill=INK)
        d.text((x, 186), "anomaly", font=f(56, 800), fill=INK)
        d.multiline_text(
            (x, 266),
            f"2 m air temperature compared with the\n{BASELINE_YEARS[0]}–{BASELINE_YEARS[1]} normal for the same day",
            font=f(24), fill=INK_2, spacing=8,
        )
        d.line((x, 352, CANVAS[0] - 80, 352), fill=RULE, width=2)

        self._colour_bar(canvas, d, x, 590)
        d.text((x, 736), "Morocco-wide average, each day", font=f(21, 600), fill=INK_2)

        credit = "Data: ECMWF ERA5 (Copernicus Climate Change Service), via ARCO-ERA5"
        if self.preliminary:
            credit += " — preliminary ERA5T"
        d.text((x, 1000), credit, font=f(17), fill=MUTED)
        d.text((x, 1024), "Elevation: Tilezen Terrarium tiles (AWS Open Data) · Rendered with forge3d", font=f(17), fill=MUTED)
        return canvas

    def _colour_bar(self, canvas: Image.Image, d: ImageDraw.ImageDraw, x: int, y: int) -> None:
        f = self.fonts
        w, h = 560, 22
        d.text((x, y - 44), "Anomaly (°C)", font=f(21, 600), fill=INK_2)
        ramp = anomaly_rgb(np.linspace(-ANOMALY_LIMIT, ANOMALY_LIMIT, w))
        bar = Image.fromarray(np.repeat(ramp[None].astype(np.uint8), h, axis=0), "RGB")
        rmask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(rmask).rounded_rectangle((0, 0, w - 1, h - 1), radius=4, fill=255)
        canvas.paste(bar, (x, y), rmask)
        for v in range(-10, 11, 2):
            tx = x + (v + ANOMALY_LIMIT) / (2 * ANOMALY_LIMIT) * (w - 1)
            d.line((tx, y + h + 2, tx, y + h + 8), fill=MUTED, width=1)
            label = f"{v:+d}".replace("-", "−") if v else "0"
            if abs(v) == 10:
                label = ("≤" if v < 0 else "≥") + label
            tw = d.textlength(label, font=f(17))
            d.text((tx - tw / 2, y + h + 11), label, font=f(17), fill=INK_2)
        d.text((x, y + h + 40), "← colder than normal", font=f(18), fill=MUTED)
        right = "warmer than normal →"
        d.text((x + w - d.textlength(right, font=f(18)), y + h + 40), right, font=f(18), fill=MUTED)

    def _bars(self, d: ImageDraw.ImageDraw, day: int, x: int, y: int) -> None:
        f = self.fonts
        n = len(self.national)
        w, h = 560, 150
        vmax = max(3.0, float(np.ceil(np.abs(self.national).max())))
        zero = y + h / 2
        step = w / n
        # Country means are small next to the map's +-10 degC scale, so bars
        # take the colour of their arm of the diverging ramp rather than a value.
        warm, cool = _hex("#d6604d"), _hex("#4393c3")
        for i, v in enumerate(self.national):
            x0 = x + i * step + 1
            x1 = x + (i + 1) * step - 1
            top = zero - v / vmax * (h / 2)
            col = tuple(int(c) for c in (warm if v >= 0 else cool))
            if i != day:
                col = tuple(int(c * 0.45 + b * 0.55) for c, b in zip(col, BG))
            y0, y1 = sorted((top, zero))
            if y1 - y0 >= 1:
                d.rounded_rectangle((x0, y0, x1, y1), radius=2, fill=col)
        d.line((x, zero, x + w, zero), fill=MUTED, width=1)
        for label, i in (("1 Sep", 0), ("15", 14), ("30 Sep", n - 1)):
            cx = x + (i + 0.5) * step
            tw = d.textlength(label, font=f(16))
            tx = min(max(cx - tw / 2, x), x + w - tw)
            d.text((tx, y + h + 8), label, font=f(16), fill=MUTED)
        d.text((x + w + 10, zero - h / 2 - 10), f"+{vmax:g}°", font=f(15), fill=MUTED)
        d.text((x + w + 10, zero + h / 2 - 10), f"−{vmax:g}°", font=f(15), fill=MUTED)
        cx = x + (day + 0.5) * step
        d.polygon([(cx - 6, y - 12), (cx + 6, y - 12), (cx, y - 3)], fill=INK)

    def compose(self, rgb: np.ndarray, day: int, national_now: float) -> Image.Image:
        canvas = self.base.copy()
        mp = Image.fromarray(np.round(np.clip(rgb, 0, 255)).astype(np.uint8), "RGB").crop(self.crop)
        canvas.paste(mp.resize(self.map_size, Image.LANCZOS), self.map_xy, self.alpha)

        d = ImageDraw.Draw(canvas)
        f = self.fonts
        x = 1230
        date = self.dates[day]
        d.text((x, 384), date.strftime("%A").upper(), font=f(22, 600), fill=MUTED)
        d.text((x, 412), f"{date.day} September", font=f(64, 800), fill=INK)
        sign = "+" if national_now >= 0 else "−"
        d.text((x, 494), f"Morocco average  {sign}{abs(national_now):.1f} °C", font=f(26, 600), fill=INK_2)
        self._bars(d, day, x, 782)
        return canvas


# --- animation ---------------------------------------------------------------

def smoothstep(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def encode(frames_dir: Path, mp4: Path, gif: Path) -> None:
    pattern = str(frames_dir / "frame_%04d.png")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", pattern,
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow",
         "-movflags", "+faststart", str(mp4)],
        check=True,
    )
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", pattern,
         "-vf", "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];"
                "[b][p]paletteuse=dither=sierra2_4a",
         str(gif)],
        check=True,
    )


def main() -> None:
    args = parse_args()
    fields, valid, dem, national, dates, preliminary = load_fields(args.year)
    print(f"{len(dates)} days, grid {valid.shape[1]}x{valid.shape[0]}, "
          f"national mean {national.min():+.1f} .. {national.max():+.1f} degC")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="morocco_anom_") as tmp:
        tmp = Path(tmp)
        surface = tmp / "surface.tif"
        write_render_surface(dem, valid, surface)
        renderer = TerrainRenderer(surface, tmp)
        try:
            alpha, shade = static_passes(renderer, valid)
            composer = Composer(alpha, national, dates, preliminary)

            def frame(t: float) -> Image.Image:
                i = min(int(math.floor(t)), len(dates) - 1)
                j = min(i + 1, len(dates) - 1)
                w = smoothstep(t - i) if j != i else 0.0
                field = fields[i] * (1.0 - w) + fields[j] * w
                colour = renderer.render(anomaly_rgb(field), valid, preserve_colors=True)
                rgb = shade_colours(colour, shade)
                day = j if w >= 0.5 else i
                return composer.compose(rgb, day, float(national[i] * (1 - w) + national[j] * w))

            if args.preview is not None:
                out = OUTPUT_DIR / f"preview_day{args.preview:02d}.png"
                frame(float(args.preview - 1)).save(out)
                print(f"Wrote {out}")
                return

            frames_dir = tmp / "frames"
            frames_dir.mkdir()
            n = 0
            times = [k / args.frames_per_day for k in range((len(dates) - 1) * args.frames_per_day + 1)]
            peak_day = int(np.argmax(np.abs(national)))
            start = time.time()
            for k, t in enumerate(times):
                img = frame(t)
                repeats = 1
                if k == 0:
                    repeats = int(HOLD_FIRST_S * FPS)
                elif k == len(times) - 1:
                    repeats = int(HOLD_LAST_S * FPS)
                for _ in range(repeats):
                    img.save(frames_dir / f"frame_{n:04d}.png")
                    n += 1
                if abs(t - peak_day) < 1e-9:
                    img.save(OUTPUT_DIR / f"morocco_t2m_anomaly_sep{args.year}_peak.png")
                if k % 10 == 0:
                    print(f"  frame {k + 1}/{len(times)}  ({time.time() - start:.0f}s)", flush=True)
        finally:
            renderer.close()

        mp4 = OUTPUT_DIR / f"morocco_t2m_anomaly_sep{args.year}.mp4"
        gif = OUTPUT_DIR / f"morocco_t2m_anomaly_sep{args.year}.gif"
        if shutil.which("ffmpeg") is None:
            raise SystemExit("ffmpeg not found; frames were rendered but not encoded")
        encode(frames_dir, mp4, gif)
        print(f"Wrote {mp4} and {gif} ({n} frames at {FPS} fps)")


if __name__ == "__main__":
    main()
