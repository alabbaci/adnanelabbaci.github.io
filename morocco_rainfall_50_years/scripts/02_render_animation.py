#!/usr/bin/env python3
"""Render fifty years of Moroccan rainfall, season by season, with forge3d.

Each hydrological year's Standardized Precipitation Index (SPI-12) is
interpolated onto the 1 km terrain grid and draped over Morocco's relief in
the forge3d terrain viewer, exactly like the September temperature animation
(the forge3d plumbing is shared through ../morocco_september_anomalies/
scripts/drape.py). The map is coloured by SPI rather than share of normal:
in the hyper-arid south a single storm swings the share of normal from 20 % to
300 %, which would drown out the north, while SPI rates every place against
its own year-to-year spread. The text and bar strip keep the plain numbers
(mm and % of normal).

* a relief pass (neutral grey drape, lit) is rendered once;
* a colour pass (the season's colours with ``preserve_colors``) is rendered
  once per season, multiplied by the relief shading;
* frames between two seasons cross-fade the two shaded renders.

Each frame carries the season, the Morocco-wide total and share of normal,
the colour bar and a 50-bar strip of every season.

Needs a GPU, or a software Vulkan driver (Mesa lavapipe) plus a display;
on a headless Linux box run it under ``xvfb-run``.

Outputs: output/morocco_rainfall_1976_2026.mp4 / .gif and stills of the
driest, wettest and latest seasons.
"""

from __future__ import annotations

import argparse
import shutil
import tempfile
import time
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image, ImageDraw

from common import BASELINE_YEARS, CACHE_DIR, DEM_PATH, FIRST_YEAR, LAST_YEAR, OUTPUT_DIR, precip_path, season_label
from drape import (
    BG, FPS, INK, INK_2, MUTED, RULE,
    Fonts, MapLayer, Ramp, TerrainRenderer,
    encode, hex_rgb, shade_colours, smoothstep, static_passes, to_terrain_grid, write_render_surface,
)

# --- look ------------------------------------------------------------------

CANVAS = (1920, 1080)
MAP_BOX = (30, 20, 1170, 1060)  # where the rendered country is fitted
PANEL_X = 1230

# SPI: brown (dry) <-> teal (wet) with a neutral grey at 0 (ColorBrewer BrBG
# arms); values beyond +-2.5 take the end colours.
SPI_LIMIT = 2.5
rain_rgb = Ramp([
    (-2.5, "#543005"), (-2.0, "#8c510a"), (-1.5, "#bf812d"), (-1.0, "#dfc27d"), (-0.5, "#f6e8c3"),
    (0.0, "#f0efec"),
    (0.5, "#c7eae5"), (1.0, "#80cdc1"), (1.5, "#35978f"), (2.0, "#01665e"), (2.5, "#003c30"),
])
DRY, WET = "#bf812d", "#35978f"

HOLD_FIRST_S = 1.0
HOLD_LAST_S = 3.0
HOLD_FRAMES = 6  # each season rests for 1/4 s ...
FADE_FRAMES = 6  # ... then cross-fades into the next for 1/4 s


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--preview", type=int, metavar="YEAR",
                   help="render one composed frame for the season starting in YEAR and stop")
    return p.parse_args()


# --- data ------------------------------------------------------------------

def load_fields():
    """Per-season SPI fields on the terrain grid, and the Morocco-wide totals."""
    ds = xr.open_dataset(precip_path())
    lat, lon = ds.latitude.values, ds.longitude.values
    fields, valid, dem = to_terrain_grid(ds["spi"].values, lat, lon, DEM_PATH)

    # National totals from the precipitation itself (equal-area grid, so a
    # plain mean over land is area-weighted): total / normal, not a mean of
    # ratios, so the wet north counts for what it actually receives.
    precip_mm, _, _ = to_terrain_grid(ds["precip"].values, lat, lon, DEM_PATH)
    normal_mm, _, _ = to_terrain_grid(ds["precip_normal"].values[None], lat, lon, DEM_PATH)
    national_mm = np.clip(precip_mm, 0.0, None)[:, valid].mean(axis=1)
    normal = float(np.clip(normal_mm[0], 0.0, None)[valid].mean())
    preliminary = {int(s[:4]) for s in ds.attrs.get("era5t_preliminary_years", "").split(", ") if s}
    return fields, valid, dem, national_mm, normal, [int(y) for y in ds.year.values], preliminary


# --- composition -----------------------------------------------------------

class Composer:
    def __init__(self, alpha: np.ndarray, national_mm: np.ndarray, normal: float,
                 years: list[int], preliminary: set[int]) -> None:
        self.fonts = Fonts(CACHE_DIR)
        self.national_mm = national_mm
        self.share = 100.0 * national_mm / normal
        self.years = years
        self.preliminary = preliminary
        self.map = MapLayer(alpha, MAP_BOX)
        self.base = self._static_base()

    def _static_base(self) -> Image.Image:
        canvas = Image.new("RGB", CANVAS, BG)
        self.map.paste_shadow(canvas)

        d = ImageDraw.Draw(canvas)
        f = self.fonts
        x = PANEL_X
        d.text((x, 92), f"MOROCCO  ·  {self.years[0]}–{self.years[-1] + 1}", font=f(22, 600), fill=MUTED)
        d.text((x, 124), "Fifty years", font=f(56, 800), fill=INK)
        d.text((x, 186), "of rainfall", font=f(56, 800), fill=INK)
        d.multiline_text(
            (x, 266),
            "Precipitation in each hydrological year (Sep–Aug)\n"
            f"compared with the {BASELINE_YEARS[0]}–{BASELINE_YEARS[1]} normal",
            font=f(24), fill=INK_2, spacing=8,
        )
        d.line((x, 352, CANVAS[0] - 80, 352), fill=RULE, width=2)

        self._colour_bar(canvas, d, x, 604)
        d.text((x, 740), "Morocco-wide rainfall, % of normal", font=f(21, 600), fill=INK_2)

        d.text((x, 1000), "Data: ECMWF ERA5 (Copernicus C3S), via WeatherBench 2 and ARCO-ERA5",
               font=f(17), fill=MUTED)
        d.text((x, 1024), "Elevation: Tilezen Terrarium tiles (AWS Open Data) · Rendered with forge3d",
               font=f(17), fill=MUTED)
        return canvas

    def _colour_bar(self, canvas: Image.Image, d: ImageDraw.ImageDraw, x: int, y: int) -> None:
        f = self.fonts
        w, h = 560, 22
        d.text((x, y - 44), "Standardized Precipitation Index (SPI)", font=f(21, 600), fill=INK_2)
        ramp = rain_rgb(np.linspace(-SPI_LIMIT, SPI_LIMIT, w))
        bar = Image.fromarray(np.repeat(ramp[None].astype(np.uint8), h, axis=0), "RGB")
        rmask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(rmask).rounded_rectangle((0, 0, w - 1, h - 1), radius=4, fill=255)
        canvas.paste(bar, (x, y), rmask)
        for v in range(-2, 3):
            tx = x + (v + SPI_LIMIT) / (2 * SPI_LIMIT) * (w - 1)
            d.line((tx, y + h + 2, tx, y + h + 8), fill=MUTED, width=1)
            label = f"{v:+d}".replace("-", "−") if v else "0"
            tw = d.textlength(label, font=f(17))
            d.text((tx - tw / 2, y + h + 11), label, font=f(17), fill=INK_2)
        # WMO SPI classes: |SPI| < 1 near normal, >= 2 extreme.
        d.text((x, y + h + 40), "← extremely dry", font=f(18), fill=MUTED)
        mid = "near normal"
        d.text((x + (w - d.textlength(mid, font=f(18))) / 2, y + h + 40), mid, font=f(18), fill=MUTED)
        right = "extremely wet →"
        d.text((x + w - d.textlength(right, font=f(18)), y + h + 40), right, font=f(18), fill=MUTED)

    def _bars(self, d: ImageDraw.ImageDraw, i_now: int, x: int, y: int) -> None:
        f = self.fonts
        n = len(self.share)
        w, h = 560, 150
        dev = self.share - 100.0
        vmax = max(20.0, 10.0 * np.ceil(np.abs(dev).max() / 10.0))
        zero = y + h / 2
        step = w / n
        dry, wet = hex_rgb(DRY), hex_rgb(WET)
        for i, v in enumerate(dev):
            x0 = x + i * step + 1
            x1 = x + (i + 1) * step - 1
            top = zero - v / vmax * (h / 2)
            col = tuple(int(c) for c in (wet if v >= 0 else dry))
            if i != i_now:
                col = tuple(int(c * 0.45 + b * 0.55) for c, b in zip(col, BG))
            y0, y1 = sorted((top, zero))
            if y1 - y0 >= 1:
                d.rounded_rectangle((x0, y0, x1, y1), radius=2, fill=col)
        d.line((x, zero, x + w, zero), fill=MUTED, width=1)
        for i in (0, n // 2 - 1, n - 1):
            label = season_label(self.years[i])
            cx = x + (i + 0.5) * step
            tw = d.textlength(label, font=f(16))
            tx = min(max(cx - tw / 2, x), x + w - tw)
            d.text((tx, y + h + 8), label, font=f(16), fill=MUTED)
        d.text((x + w + 10, zero - h / 2 - 10), f"{100 + vmax:.0f}%", font=f(15), fill=MUTED)
        d.text((x + w + 10, zero - 9), "100%", font=f(15), fill=MUTED)
        d.text((x + w + 10, zero + h / 2 - 10), f"{100 - vmax:.0f}%", font=f(15), fill=MUTED)
        cx = x + (i_now + 0.5) * step
        d.polygon([(cx - 6, y - 12), (cx + 6, y - 12), (cx, y - 3)], fill=INK)

    def compose(self, rgb: np.ndarray, i_now: int, mm_now: float, share_now: float) -> Image.Image:
        canvas = self.base.copy()
        self.map.paste(canvas, rgb)

        d = ImageDraw.Draw(canvas)
        f = self.fonts
        x = PANEL_X
        year = self.years[i_now]
        d.text((x, 384), f"SEPTEMBER {year} – AUGUST {year + 1}", font=f(22, 600), fill=MUTED)
        d.text((x, 412), season_label(year), font=f(64, 800), fill=INK)
        d.text((x, 494), f"Morocco  {mm_now:.0f} mm  ·  {share_now:.0f}% of normal", font=f(26, 600), fill=INK_2)
        if year in self.preliminary:
            d.text((x, 530), "Latest months from preliminary ERA5T data", font=f(16), fill=MUTED)
        self._bars(d, i_now, x, 786)
        return canvas


# --- animation ---------------------------------------------------------------

def main() -> None:
    args = parse_args()
    fields, valid, dem, national_mm, normal, years, preliminary = load_fields()
    share = 100.0 * national_mm / normal
    print(f"{len(years)} seasons {season_label(years[0])}..{season_label(years[-1])}, "
          f"Morocco normal {normal:.0f} mm, share {share.min():.0f}%..{share.max():.0f}%")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = f"morocco_rainfall_{FIRST_YEAR}_{LAST_YEAR + 1}"
    stills = {
        int(np.argmin(share)): "driest",
        int(np.argmax(share)): "wettest",
        len(years) - 1: "latest",
    }
    with tempfile.TemporaryDirectory(prefix="morocco_rain_") as tmp:
        tmp = Path(tmp)
        surface = tmp / "surface.tif"
        write_render_surface(dem, valid, surface)
        renderer = TerrainRenderer(surface, tmp)
        try:
            alpha, shade = static_passes(renderer, valid)
            composer = Composer(alpha, national_mm, normal, years, preliminary)

            def season_rgb(i: int) -> np.ndarray:
                colour = renderer.render(rain_rgb(fields[i]), valid, preserve_colors=True)
                return shade_colours(colour, shade)

            if args.preview is not None:
                i = years.index(args.preview)
                out = OUTPUT_DIR / f"preview_{args.preview}.png"
                composer.compose(season_rgb(i), i, national_mm[i], share[i]).save(out)
                print(f"Wrote {out}")
                return

            frames_dir = tmp / "frames"
            frames_dir.mkdir()
            n = 0

            def emit(img: Image.Image, repeats: int = 1) -> None:
                nonlocal n
                for _ in range(repeats):
                    img.save(frames_dir / f"frame_{n:04d}.png")
                    n += 1

            start = time.time()
            prev = season_rgb(0)
            for i in range(len(years)):
                if i:
                    cur = season_rgb(i)
                    for k in range(1, FADE_FRAMES):
                        w = smoothstep(k / FADE_FRAMES)
                        label = i if w >= 0.5 else i - 1
                        emit(composer.compose(
                            prev * (1.0 - w) + cur * w, label,
                            national_mm[i - 1] * (1.0 - w) + national_mm[i] * w,
                            share[i - 1] * (1.0 - w) + share[i] * w,
                        ))
                    prev = cur
                img = composer.compose(prev, i, national_mm[i], share[i])
                if i == 0:
                    repeats = int(HOLD_FIRST_S * FPS)
                elif i == len(years) - 1:
                    repeats = int(HOLD_LAST_S * FPS)
                else:
                    repeats = HOLD_FRAMES
                emit(img, repeats)
                if i in stills:
                    img.save(OUTPUT_DIR / f"{slug}_{stills[i]}.png")
                if i % 5 == 0:
                    print(f"  season {i + 1}/{len(years)}  ({time.time() - start:.0f}s)", flush=True)
        finally:
            renderer.close()

        mp4 = OUTPUT_DIR / f"{slug}.mp4"
        gif = OUTPUT_DIR / f"{slug}.gif"
        if shutil.which("ffmpeg") is None:
            raise SystemExit("ffmpeg not found; frames were rendered but not encoded")
        encode(frames_dir, mp4, gif)
        print(f"Wrote {mp4} and {gif} ({n} frames at {FPS} fps)")


if __name__ == "__main__":
    main()
