#!/usr/bin/env python3
"""Render Morocco's rain bank, 2002/03 - 2025/26, in 3D with forge3d.

Height and colour show the same thing: the rain each place has banked or
missed since 2002/03 against its 1991-2020 normal. Blue rises where the
running total is a surplus, red sinks where it is a deficit.

Unlike the other animations the terrain itself changes every season, so each
season writes a new surface from the data and runs forge3d's mask, relief and
colour passes on it (see drape.py); frames between seasons cross-fade. The
viewer scales heights to each surface's own min-max, so two marker cells
outside the country pin every surface to the same fixed range; zero stays at
the same level and a 500 mm deficit sinks equally deep in every season.

Needs a GPU, or a software Vulkan driver (Mesa lavapipe) plus a display;
on a headless Linux box run it under ``xvfb-run``.

Outputs: output/morocco_rain_bank_2002_2026.mp4 / .gif and stills of the
peak, the low and the latest season.
"""

from __future__ import annotations

import argparse
import shutil
import tempfile
import time
from pathlib import Path

import numpy as np
import rasterio
import xarray as xr
from PIL import Image, ImageDraw
from rasterio.transform import from_origin

from common import CACHE_DIR, DEM_PATH, FIRST_YEAR, LAST_YEAR, OUTPUT_DIR, PRECIP_PATH, balance_path, season_label
from drape import (
    BG, FPS, INK, INK_2, MUTED, RULE,
    Fonts, MapLayer, Ramp, TerrainRenderer,
    encode, hex_rgb, shade_colours, smoothstep, static_passes, to_terrain_grid,
)

# --- look ------------------------------------------------------------------

CANVAS = (1920, 1080)
MAP_BOX = (30, 20, 1170, 1060)
PANEL_X = 1230
MAP_PAD = 60  # room for the silhouette to rise and sink between frames

# Cumulative anomaly, graduated red (deficit) -> grey -> blue (surplus),
# ColorBrewer RdBu arms; height uses the same clipped range.
LIMIT_MM = 1000.0
HEIGHT_UNITS = 40.0  # surface units at +-LIMIT_MM (heights are normalised by the viewer)
ZSCALE = 5.0  # viewer height scale for the data surface
bank_rgb = Ramp([
    (-1000.0, "#67001f"), (-750.0, "#b2182b"), (-500.0, "#d6604d"), (-250.0, "#f4a582"), (-100.0, "#fddbc7"),
    (0.0, "#f0efec"),
    (100.0, "#d1e5f0"), (250.0, "#92c5de"), (500.0, "#4393c3"), (750.0, "#2166ac"), (1000.0, "#053061"),
])
DEFICIT, SURPLUS = "#d6604d", "#4393c3"

HOLD_FIRST_S = 1.0
HOLD_LAST_S = 3.0
HOLD_FRAMES = 12  # each season rests for 1/2 s ...
FADE_FRAMES = 6  # ... then cross-fades into the next for 1/4 s


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--preview", type=int, metavar="YEAR",
                   help="render one composed frame for the season starting in YEAR and stop")
    return p.parse_args()


# --- data ------------------------------------------------------------------

def load_fields():
    ds = xr.open_dataset(balance_path())
    cum = ds["cumulative_anomaly"]
    fields, valid, _ = to_terrain_grid(cum.values, cum.latitude.values, cum.longitude.values, DEM_PATH)
    normal = xr.open_dataset(PRECIP_PATH)["precip_normal"]
    normal_mm, _, _ = to_terrain_grid(normal.values[None], normal.latitude.values, normal.longitude.values, DEM_PATH)
    # 1 km equal-area cells: km2 = cell count, and mm x km2 x 1e-6 = km3.
    area_km2 = float(valid.sum())
    km3 = fields[:, valid].mean(axis=1) * area_km2 * 1e-6
    normal_km3 = float(np.clip(normal_mm[0], 0.0, None)[valid].mean()) * area_km2 * 1e-6
    preliminary = {int(s[:4]) for s in ds.attrs.get("era5t_preliminary_years", "").split(", ") if s}
    return fields, valid, km3, normal_km3, [int(y) for y in ds.year.values], preliminary


def write_data_surface(field: np.ndarray, valid: np.ndarray, path: Path) -> None:
    """Heights from the data over the whole grid (the country mask clips it
    later; leaving the surroundings empty would drop sheer walls at every
    border), with two marker cells in the corners pinning the viewer's
    min-max normalisation to +-LIMIT_MM."""
    if valid[0, 0] or valid[-1, -1]:
        raise SystemExit("Grid corners fall inside the country; cannot place the height markers.")
    heights = (np.clip(field, -LIMIT_MM, LIMIT_MM) / LIMIT_MM * HEIGHT_UNITS).astype(np.float32)
    heights[0, 0], heights[-1, -1] = HEIGHT_UNITS, -HEIGHT_UNITS
    profile = dict(
        driver="GTiff", width=valid.shape[1], height=valid.shape[0], count=1, dtype="float32",
        transform=from_origin(0.0, float(valid.shape[0]), 1.0, 1.0),
    )
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(heights, 1)


def render_surface(field: np.ndarray, valid: np.ndarray, workdir: Path) -> tuple[np.ndarray, np.ndarray]:
    """Shaded colour render and country mask of one data surface."""
    surface = workdir / "surface.tif"
    write_data_surface(field, valid, surface)
    renderer = TerrainRenderer(surface, workdir, zscale=ZSCALE)
    try:
        alpha, shade = static_passes(renderer, valid)
        colour = renderer.render(bank_rgb(field), valid, preserve_colors=True)
    finally:
        renderer.close()
    return shade_colours(colour, shade), alpha


# --- composition -----------------------------------------------------------

def signed(v: float, fmt: str = ".0f") -> str:
    return f"{v:+{fmt}}".replace("-", "−")


class Composer:
    def __init__(self, alpha: np.ndarray, km3: np.ndarray, normal_km3: float,
                 years: list[int], preliminary: set[int]) -> None:
        self.fonts = Fonts(CACHE_DIR)
        self.km3 = km3
        self.normal_km3 = normal_km3
        self.years = years
        self.preliminary = preliminary
        self.map = MapLayer(alpha, MAP_BOX, pad=MAP_PAD)
        self.base = self._static_base()

    def _static_base(self) -> Image.Image:
        canvas = Image.new("RGB", CANVAS, BG)
        self.map.paste_shadow(canvas)

        d = ImageDraw.Draw(canvas)
        f = self.fonts
        x = PANEL_X
        d.text((x, 92), f"MOROCCO  ·  {season_label(self.years[0])} – {season_label(self.years[-1])}",
               font=f(22, 600), fill=MUTED)
        d.text((x, 124), "Morocco's", font=f(56, 800), fill=INK)
        d.text((x, 186), "rain bank", font=f(56, 800), fill=INK)
        d.multiline_text(
            (x, 266),
            "Rain above or below the 1991–2020 normal,\n"
            f"added up season by season since {season_label(self.years[0])}",
            font=f(24), fill=INK_2, spacing=8,
        )
        d.line((x, 352, CANVAS[0] - 80, 352), fill=RULE, width=2)

        self._colour_bar(canvas, d, x, 604)
        d.text((x, 740), "Morocco-wide running total, km³", font=f(21, 600), fill=INK_2)

        d.text((x, 1000), "Data: ECMWF ERA5 precipitation (Copernicus C3S)",
               font=f(17), fill=MUTED)
        d.text((x, 1024), "Height and colour show the same value · Rendered with forge3d",
               font=f(17), fill=MUTED)
        return canvas

    def _colour_bar(self, canvas: Image.Image, d: ImageDraw.ImageDraw, x: int, y: int) -> None:
        f = self.fonts
        w, h = 560, 22
        d.text((x, y - 44), "Running surplus or deficit (mm of water)", font=f(21, 600), fill=INK_2)
        ramp = bank_rgb(np.linspace(-LIMIT_MM, LIMIT_MM, w))
        bar = Image.fromarray(np.repeat(ramp[None].astype(np.uint8), h, axis=0), "RGB")
        rmask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(rmask).rounded_rectangle((0, 0, w - 1, h - 1), radius=4, fill=255)
        canvas.paste(bar, (x, y), rmask)
        for v in (-1000, -500, 0, 500, 1000):
            tx = x + (v + LIMIT_MM) / (2 * LIMIT_MM) * (w - 1)
            d.line((tx, y + h + 2, tx, y + h + 8), fill=MUTED, width=1)
            label = signed(v) if v else "0"
            if abs(v) == LIMIT_MM:
                label = ("≤" if v < 0 else "≥") + label
            tw = d.textlength(label, font=f(17))
            tx = min(max(tx - tw / 2, x - 8), x + w + 8 - tw)
            d.text((tx, y + h + 11), label, font=f(17), fill=INK_2)
        d.text((x, y + h + 40), "← deficit, sinks", font=f(18), fill=MUTED)
        right = "surplus, rises →"
        d.text((x + w - d.textlength(right, font=f(18)), y + h + 40), right, font=f(18), fill=MUTED)

    def _bars(self, d: ImageDraw.ImageDraw, i_now: int, x: int, y: int) -> None:
        f = self.fonts
        n = len(self.km3)
        w, h = 560, 150
        vmax = max(50.0, 50.0 * np.ceil(np.abs(self.km3).max() / 50.0))
        zero = y + h / 2
        step = w / n
        deficit, surplus = hex_rgb(DEFICIT), hex_rgb(SURPLUS)
        for i, v in enumerate(self.km3):
            x0 = x + i * step + 2
            x1 = x + (i + 1) * step - 2
            top = zero - v / vmax * (h / 2)
            col = tuple(int(c) for c in (surplus if v >= 0 else deficit))
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
        d.text((x + w + 10, zero - h / 2 - 10), signed(vmax), font=f(15), fill=MUTED)
        d.text((x + w + 10, zero - 9), "0", font=f(15), fill=MUTED)
        d.text((x + w + 10, zero + h / 2 - 10), signed(-vmax), font=f(15), fill=MUTED)
        cx = x + (i_now + 0.5) * step
        d.polygon([(cx - 6, y - 12), (cx + 6, y - 12), (cx, y - 3)], fill=INK)

    def compose(self, rgb: np.ndarray, alpha: np.ndarray, i_now: int, km3_now: float) -> Image.Image:
        canvas = self.base.copy()
        self.map.paste(canvas, rgb, alpha)

        d = ImageDraw.Draw(canvas)
        f = self.fonts
        x = PANEL_X
        year = self.years[i_now]
        d.text((x, 384), f"AFTER SEPTEMBER {year} – AUGUST {year + 1}", font=f(22, 600), fill=MUTED)
        d.text((x, 412), season_label(year), font=f(64, 800), fill=INK)
        d.text((x, 494), f"Morocco  {signed(km3_now)} km³ since {season_label(self.years[0])}",
               font=f(26, 600), fill=INK_2)
        note = f"A normal season brings {self.normal_km3:.0f} km³ of rain and snow"
        if year in self.preliminary:
            note += " · latest months preliminary (ERA5T)"
        d.text((x, 530), note, font=f(16), fill=MUTED)
        self._bars(d, i_now, x, 786)
        return canvas


# --- animation ---------------------------------------------------------------

def main() -> None:
    args = parse_args()
    fields, valid, km3, normal_km3, years, preliminary = load_fields()
    print(f"{len(years)} seasons {season_label(years[0])}..{season_label(years[-1])}, "
          f"running total {km3.min():+.0f}..{km3.max():+.0f} km3, normal season {normal_km3:.0f} km3")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = f"morocco_rain_bank_{FIRST_YEAR}_{LAST_YEAR + 1}"
    stills = {int(np.argmax(km3)): "peak", int(np.argmin(km3)): "low", len(years) - 1: "latest"}
    with tempfile.TemporaryDirectory(prefix="morocco_bank_") as tmp:
        tmp = Path(tmp)
        rgb0, alpha0 = render_surface(fields[0], valid, tmp)
        composer = Composer(alpha0, km3, normal_km3, years, preliminary)

        if args.preview is not None:
            i = years.index(args.preview)
            rgb, alpha = render_surface(fields[i], valid, tmp)
            out = OUTPUT_DIR / f"preview_{args.preview}.png"
            composer.compose(rgb, alpha, i, km3[i]).save(out)
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
        prev_rgb, prev_alpha = rgb0, alpha0
        for i in range(len(years)):
            if i:
                rgb, alpha = render_surface(fields[i], valid, tmp)
                for k in range(1, FADE_FRAMES):
                    w = smoothstep(k / FADE_FRAMES)
                    emit(composer.compose(prev_rgb * (1.0 - w) + rgb * w, prev_alpha * (1.0 - w) + alpha * w,
                                          i if w >= 0.5 else i - 1, km3[i - 1] * (1.0 - w) + km3[i] * w))
                prev_rgb, prev_alpha = rgb, alpha
            else:
                rgb, alpha = rgb0, alpha0
            img = composer.compose(rgb, alpha, i, km3[i])
            if i == 0:
                repeats = int(HOLD_FIRST_S * FPS)
            elif i == len(years) - 1:
                repeats = int(HOLD_LAST_S * FPS)
            else:
                repeats = HOLD_FRAMES
            emit(img, repeats)
            if i in stills:
                img.save(OUTPUT_DIR / f"{slug}_{stills[i]}.png")
            print(f"  season {i + 1}/{len(years)}  ({time.time() - start:.0f}s)", flush=True)

        mp4 = OUTPUT_DIR / f"{slug}.mp4"
        gif = OUTPUT_DIR / f"{slug}.gif"
        if shutil.which("ffmpeg") is None:
            raise SystemExit("ffmpeg not found; frames were rendered but not encoded")
        encode(frames_dir, mp4, gif)
        print(f"Wrote {mp4} and {gif} ({n} frames at {FPS} fps)")


if __name__ == "__main__":
    main()
