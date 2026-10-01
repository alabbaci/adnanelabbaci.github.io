"""Drape a gridded field over Morocco's relief with forge3d.

Shared by the September temperature animation and the 50-year rainfall
animation (../morocco_rainfall_50_years): interpolating 0.25 deg fields onto
the 1 km terrain grid, the forge3d viewer session, the country-mask and
relief passes, fitting the render onto the frame, fonts and video encoding.

Needs a GPU, or a software Vulkan driver (Mesa lavapipe) plus a display;
on a headless Linux box run the scripts under ``xvfb-run``.
"""

from __future__ import annotations

import re
import subprocess
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageFilter, ImageFont
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

import forge3d as f3d

RENDER_SIZE = (1600, 1600)
VERTICAL_EXAGGERATION = 15.0
CAMERA = {"phi": 90.0, "theta": 38.0, "radius": 4600.0, "fov": 24.0}
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

FPS = 24

GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800"
FALLBACK_FONTS = {
    400: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    600: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    800: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
}


# --- colour ----------------------------------------------------------------

def hex_rgb(c: str) -> np.ndarray:
    return np.array([int(c[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


class Ramp:
    """Piecewise-linear colour ramp through (value, "#rrggbb") stops; values
    outside the stops take the end colours."""

    def __init__(self, stops: list[tuple[float, str]]) -> None:
        self.values = np.array([v for v, _ in stops], dtype=np.float32)
        self.rgb = np.stack([hex_rgb(c) for _, c in stops])

    def __call__(self, values: np.ndarray) -> np.ndarray:
        v = np.clip(values, self.values[0], self.values[-1])
        return np.stack([np.interp(v, self.values, self.rgb[:, i]) for i in range(3)], axis=-1)


# --- terrain grid ------------------------------------------------------------

def to_terrain_grid(values: np.ndarray, lat: np.ndarray, lon: np.ndarray, dem_path: Path):
    """Interpolate (n, lat, lon) fields on a regular lon/lat grid onto the
    terrain grid. Returns (fields, valid, dem), valid being the land mask."""
    res = float(abs(lat[1] - lat[0]))
    src_transform = from_origin(float(lon.min()) - res / 2, float(lat.max()) + res / 2, res, res)
    src = values if lat[0] > lat[-1] else values[:, ::-1, :]

    with rasterio.open(dem_path) as dem_src:
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
    return fields, valid, dem


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

def font_files(cache_dir: Path) -> dict[int, Path]:
    out: dict[int, Path] = {}
    font_dir = cache_dir / "fonts"
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
    def __init__(self, cache_dir: Path) -> None:
        self.files = font_files(cache_dir)

    def __call__(self, size: int, weight: int = 400) -> ImageFont.FreeTypeFont:
        return ImageFont.truetype(str(self.files[weight]), size)


# --- forge3d ---------------------------------------------------------------

class TerrainRenderer:
    """A forge3d viewer session; the camera and sun stay fixed.

    Reloading the overlay every frame grows the viewer's memory and slows it
    down, so the session is restarted every RESTART_EVERY renders.
    """

    RESTART_EVERY = 60

    def __init__(self, surface_path: Path, workdir: Path) -> None:
        self.surface_path = surface_path
        self.workdir = workdir
        self.viewer = None
        self.n = 0
        self._open()

    def _open(self) -> None:
        self.viewer = f3d.open_viewer_async(
            terrain_path=self.surface_path, width=1000, height=1000, timeout=600
        )
        self.viewer.send_ipc({"cmd": "set_terrain", **CAMERA, "zscale": 1.0, **SUN, "background": [c / 255 for c in BG]})
        self.viewer.send_ipc({"cmd": "set_terrain_pbr", **PBR})
        self.viewer.send_ipc({"cmd": "set_overlays_enabled", "enabled": True})
        self.viewer.send_ipc({"cmd": "set_overlay_solid", "solid": False})

    def render(self, rgb: np.ndarray, valid: np.ndarray, *, preserve_colors: bool) -> np.ndarray:
        if self.n and self.n % self.RESTART_EVERY == 0:
            self.viewer.close()
            self._open()
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
    edge = alpha > 0.02
    if edge[:, :2].any() or edge[:, -2:].any() or edge[:2].any() or edge[-2:].any():
        raise SystemExit("The country touches the edge of the render; increase CAMERA['radius'].")

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

class MapLayer:
    """Crops the rendered country and fits it into a box on the frame."""

    def __init__(self, alpha: np.ndarray, box: tuple[int, int, int, int]) -> None:
        ys, xs = np.nonzero(alpha > 0.02)
        pad = 12
        self.crop = (max(xs.min() - pad, 0), max(ys.min() - pad, 0),
                     min(xs.max() + pad, alpha.shape[1]), min(ys.max() + pad, alpha.shape[0]))
        cw, ch = self.crop[2] - self.crop[0], self.crop[3] - self.crop[1]
        bw, bh = box[2] - box[0], box[3] - box[1]
        scale = min(bw / cw, bh / ch)
        self.size = (int(round(cw * scale)), int(round(ch * scale)))
        self.xy = (box[0] + (bw - self.size[0]) // 2, box[1] + (bh - self.size[1]) // 2)
        self.alpha = Image.fromarray(np.round(alpha * 255).astype(np.uint8), "L").crop(self.crop).resize(
            self.size, Image.LANCZOS)

    def paste_shadow(self, canvas: Image.Image) -> None:
        """Soft contact shadow under the country."""
        shadow = Image.new("L", canvas.size, 0)
        shadow.paste(self.alpha, (self.xy[0] + 10, self.xy[1] + 14))
        shadow = shadow.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.22))
        canvas.paste(Image.new("RGB", canvas.size, (60, 58, 52)), (0, 0), shadow)

    def paste(self, canvas: Image.Image, rgb: np.ndarray) -> None:
        mp = Image.fromarray(np.round(np.clip(rgb, 0, 255)).astype(np.uint8), "RGB").crop(self.crop)
        canvas.paste(mp.resize(self.size, Image.LANCZOS), self.xy, self.alpha)


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
