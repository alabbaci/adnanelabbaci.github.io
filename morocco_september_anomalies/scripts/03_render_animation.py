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
with ffmpeg to MP4 and GIF. The forge3d plumbing lives in drape.py.

Needs a GPU, or a software Vulkan driver (Mesa lavapipe) plus a display;
on a headless Linux box run it under ``xvfb-run``.

Outputs: output/morocco_t2m_anomaly_sep<year>.mp4 / .gif / _peak.png
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import shutil
import tempfile
import time
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image, ImageDraw

from common import BASELINE_YEARS, CACHE_DIR, DEFAULT_YEAR, OUTPUT_DIR, anomaly_path, dem_path
from drape import (
    BG, FPS, INK, INK_2, MUTED, RULE,
    Fonts, MapLayer, Ramp, TerrainRenderer,
    encode, hex_rgb, shade_colours, smoothstep, static_passes, to_terrain_grid, write_render_surface,
)

# --- look ------------------------------------------------------------------

CANVAS = (1920, 1080)
MAP_BOX = (30, 20, 1170, 1060)  # where the rendered country is fitted

# Diverging blue <-> red with a neutral grey midpoint (ColorBrewer RdBu arms).
ANOMALY_LIMIT = 10.0  # degC; values beyond are clipped to the end colours
anomaly_rgb = Ramp([
    (-10.0, "#053061"), (-7.5, "#2166ac"), (-5.0, "#4393c3"), (-2.5, "#92c5de"), (-1.0, "#d1e5f0"),
    (0.0, "#f0efec"),
    (1.0, "#fddbc7"), (2.5, "#f4a582"), (5.0, "#d6604d"), (7.5, "#b2182b"), (10.0, "#67001f"),
])

FRAMES_PER_DAY = 8
HOLD_FIRST_S = 1.0
HOLD_LAST_S = 2.5


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--year", type=int, default=DEFAULT_YEAR)
    p.add_argument("--preview", type=int, metavar="DAY", help="render a single composed frame for this day and stop")
    p.add_argument("--frames-per-day", type=int, default=FRAMES_PER_DAY)
    return p.parse_args()


# --- data ------------------------------------------------------------------

def load_fields(year: int):
    """Daily anomalies on the terrain grid, plus the Morocco-wide mean per day."""
    ds = xr.open_dataset(anomaly_path(year))
    anom = ds["t2m_anomaly"].transpose("time", "latitude", "longitude")
    fields, valid, dem = to_terrain_grid(anom.values, anom.latitude.values, anom.longitude.values, dem_path())
    # Equal-area grid, so a plain mean over land pixels is area-weighted.
    national = fields[:, valid].mean(axis=1)
    dates = [dt.date.fromisoformat(str(t)[:10]) for t in ds.time.values]
    return fields, valid, dem, national, dates, bool(ds.attrs.get("era5t_preliminary", 0))


# --- composition -----------------------------------------------------------

class Composer:
    def __init__(self, alpha: np.ndarray, national: np.ndarray, dates: list[dt.date], preliminary: bool) -> None:
        self.fonts = Fonts(CACHE_DIR)
        self.national = national
        self.dates = dates
        self.preliminary = preliminary
        self.map = MapLayer(alpha, MAP_BOX)
        self.base = self._static_base()

    def _static_base(self) -> Image.Image:
        canvas = Image.new("RGB", CANVAS, BG)
        self.map.paste_shadow(canvas)

        d = ImageDraw.Draw(canvas)
        f = self.fonts
        x = 1230
        year = self.dates[0].year
        header = f"MOROCCO  ·  SEPTEMBER {year}"
        if len(self.dates) < 30:
            header += f"  ·  1–{self.dates[-1].day} SEP SO FAR"
        d.text((x, 92), header, font=f(22, 600), fill=MUTED)
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
            credit = "Data: ECMWF ERA5T, preliminary (Copernicus C3S), via ARCO-ERA5"
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
        n = 30  # one slot per September day; days without data yet stay empty
        w, h = 560, 150
        vmax = max(3.0, float(np.ceil(np.abs(self.national).max())))
        zero = y + h / 2
        step = w / n
        # Country means are small next to the map's +-10 degC scale, so bars
        # take the colour of their arm of the diverging ramp rather than a value.
        warm, cool = hex_rgb("#d6604d"), hex_rgb("#4393c3")
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
        if len(self.national) < n:
            note = "not yet available"
            gap_x = x + len(self.national) * step
            d.text((gap_x + (x + w - gap_x - d.textlength(note, font=f(15))) / 2, zero - 26), note,
                   font=f(15), fill=MUTED)
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
        self.map.paste(canvas, rgb)

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
