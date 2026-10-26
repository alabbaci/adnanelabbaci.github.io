"""Where things are: country raster, the 'Africa and its seas' mask, and naming of places and seas."""
from __future__ import annotations

import json
import math
from functools import cached_property
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from . import config
from .fetch import LATS, LONS, NX, NY

DATA = Path(__file__).parent / "data"

AFRICAN = {
    "Algeria", "Angola", "Benin", "Botswana", "Burkina Faso", "Burundi", "Cabo Verde", "Cameroon",
    "Central African Rep.", "Chad", "Comoros", "Congo", "Côte d'Ivoire", "Dem. Rep. Congo", "Djibouti",
    "Egypt", "Eq. Guinea", "Eritrea", "eSwatini", "Ethiopia", "Gabon", "Gambia", "Ghana", "Guinea",
    "Guinea-Bissau", "Kenya", "Lesotho", "Liberia", "Libya", "Madagascar", "Malawi", "Mali", "Mauritania",
    "Mauritius", "Morocco", "Mozambique", "Namibia", "Niger", "Nigeria", "Rwanda", "S. Sudan", "Saint Helena",
    "São Tomé and Principe", "Senegal", "Seychelles", "Sierra Leone", "Somalia", "Somaliland", "South Africa",
    "Sudan", "Tanzania", "Togo", "Tunisia", "Uganda", "W. Sahara", "Zambia", "Zimbabwe",
}

DISPLAY = {
    "Central African Rep.": "Central African Republic", "Dem. Rep. Congo": "DR Congo",
    "Eq. Guinea": "Equatorial Guinea", "S. Sudan": "South Sudan", "W. Sahara": "Western Sahara",
    "eSwatini": "Eswatini", "Somaliland": "Somalia", "Bosnia and Herz.": "Bosnia and Herzegovina",
    "N. Cyprus": "Cyprus", "Fr. S. Antarctic Lands": "French Southern Lands",
}

# Ordered: the first box containing the point names the water. (south, north, west, east)
SEAS = [
    ("the Mediterranean", 30.0, 46.0, -6.0, 37.0),
    ("the Red Sea", 12.5, 30.0, 32.0, 43.5),
    ("the Gulf of Aden", 10.5, 15.5, 43.0, 51.5),
    ("the Persian Gulf", 23.0, 31.0, 47.0, 57.0),
    ("the Arabian Sea", 5.0, 26.0, 51.5, 70.0),
    ("the Mozambique Channel", -26.0, -11.0, 33.0, 44.5),
    ("the Gulf of Guinea", -6.0, 7.0, -10.0, 12.0),
    ("the waters south of South Africa", -48.0, -33.0, 14.0, 34.0),
    ("the south-west Indian Ocean", -48.0, -5.0, 33.0, 70.0),
    ("the western Indian Ocean", -5.0, 12.0, 39.0, 70.0),
    ("the Atlantic off north-west Africa", 20.0, 46.0, -40.0, -5.0),
    ("the eastern tropical Atlantic", -6.0, 20.0, -40.0, 12.0),
    ("the South Atlantic", -60.0, -6.0, -40.0, 20.0),
]


def sea_name(lat: float, lon: float) -> str:
    for name, s, n, w, e in SEAS:
        if s <= lat <= n and w <= lon <= e:
            return name
    return "the open ocean"


def country_label(name: str, lat: float, lon: float) -> str:
    """Display name, giving overseas islands near Africa their own names."""
    if name == "France" and lat < 0:
        return "Réunion" if lon > 50 else "Mayotte"
    if name == "Spain" and lat < 32:
        return "the Canary Islands"
    if name == "Portugal" and lat < 34:
        return "Madeira"
    return DISPLAY.get(name, name)


def km_between(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(min(1.0, math.sqrt(a)))


def compass(lat1, lon1, lat2, lon2) -> str:
    """Eight-point direction from point 1 to point 2."""
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - \
        math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lon2 - lon1))
    deg = (math.degrees(math.atan2(y, x)) + 360) % 360
    return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][int((deg + 22.5) // 45) % 8]


def cell_area_km2() -> np.ndarray:
    side = config.RES * 111.2
    return (side * side * np.cos(np.radians(LATS)))[:, None] * np.ones((1, NX), np.float32)


class Geo:
    def __init__(self, lsm: np.ndarray):
        self.lsm = lsm
        self.land = lsm > 0.5
        self.countries = json.loads((DATA / "countries.json").read_text(encoding="utf-8"))
        self.places = json.loads((DATA / "places.json").read_text(encoding="utf-8"))
        self.area = cell_area_km2()

    @cached_property
    def country_index(self) -> np.ndarray:
        """Country number (index into self.countries) for every grid cell, -1 for none."""
        img = Image.new("I", (NX, NY), -1)
        draw = ImageDraw.Draw(img)
        # Outer rings only, largest first, so enclaves (Lesotho in South Africa) are drawn on top.
        rings = []
        for k, c in enumerate(self.countries):
            for poly in c["polygons"]:
                ring = poly[0]
                xy = [((ring[i] - config.WEST) / config.RES, (config.NORTH - ring[i + 1]) / config.RES)
                      for i in range(0, len(ring), 2)]
                if len(xy) >= 3:
                    xs, ys = zip(*xy)
                    rings.append(((max(xs) - min(xs)) * (max(ys) - min(ys)), k, xy))
        for _, k, xy in sorted(rings, key=lambda r: -r[0]):
            draw.polygon(xy, fill=k)
        idx = np.array(img, dtype=np.int32)
        # Small islands can fall between grid points; give remaining land the nearest country.
        missing = self.land & (idx < 0)
        if missing.any():
            _, (ii, jj) = ndimage.distance_transform_edt(idx < 0, return_indices=True)
            idx[missing] = idx[ii[missing], jj[missing]]
        return idx

    @cached_property
    def african_land(self) -> np.ndarray:
        idx = self.country_index
        names = np.array([c["name"] for c in self.countries] + [""])
        name_grid = names[np.where(idx >= 0, idx, len(names) - 1)]
        africa = np.isin(name_grid, list(AFRICAN))
        lat = LATS[:, None] * np.ones((1, NX))
        lon = LONS[None, :] * np.ones((NY, 1))
        overseas = ((name_grid == "France") & (lat < 0)) | ((name_grid == "Spain") & (lat < 32)) | \
                   ((name_grid == "Portugal") & (lat < 34))
        return (africa | overseas) & self.land

    @cached_property
    def region(self) -> np.ndarray:
        """African land plus sea within ~600 km whose nearest land is African: where a highlight must peak."""
        dist, (ii, jj) = ndimage.distance_transform_edt(~self.land, return_indices=True)
        nearest_african = self.african_land[ii, jj]
        return self.african_land | (~self.land & nearest_african & (dist * config.RES * 111.2 < 600))

    @cached_property
    def coast_km(self) -> np.ndarray:
        """Distance of sea cells from the nearest land, km (0 on land)."""
        return ndimage.distance_transform_edt(~self.land) * config.RES * 111.2

    def country_at(self, lat: float, lon: float) -> str | None:
        i = int(round((config.NORTH - lat) / config.RES))
        j = int(round((lon - config.WEST) / config.RES))
        k = self.country_index[i, j]
        return country_label(self.countries[k]["name"], lat, lon) if self.land[i, j] and k >= 0 else None

    def nearest_place(self, lat: float, lon: float) -> dict:
        return min(self.places, key=lambda p: km_between(lat, lon, p["lat"], p["lon"]))

    def countries_in(self, mask: np.ndarray, weights: np.ndarray | None = None, limit: int = 3) -> list[str]:
        idx = self.country_index[mask & self.land]
        w = (weights[mask & self.land] if weights is not None else np.ones(idx.size))
        totals: dict[str, float] = {}
        ii, jj = np.nonzero(mask & self.land)
        for k, wt, i, j in zip(idx, w, ii, jj):
            if k < 0:
                continue
            label = country_label(self.countries[k]["name"], float(LATS[i]), float(LONS[j]))
            totals[label] = totals.get(label, 0.0) + float(wt)
        ranked = sorted(totals, key=lambda n: -totals[n])
        top = totals[ranked[0]] if ranked else 0
        return [n for n in ranked if totals[n] >= 0.08 * top][:limit]

    def place_at(self, lat: float, lon: float, short: bool = False) -> str:
        """'Kayes, Mali' when a town is close, else 'about 120 km SE of Lusaka, Zambia', else country or sea.

        `short` drops the country, for use inside a sentence that already names it.
        """
        best, best_score = None, -99.0
        for p in self.places:
            d = km_between(lat, lon, p["lat"], p["lon"])
            if d > 250:
                continue
            score = math.log10(max(p["pop"], 1000)) - d / 40
            if score > best_score:
                best, best_score = (p, d), score
        if best:
            p, d = best
            where = p["name"] if short else f"{p['name']}, {country_label(p['country'], p['lat'], p['lon'])}"
            if d < 25:
                return where
            return f"about {int(round(d, -1))} km {compass(p['lat'], p['lon'], lat, lon)} of {where}"
        i = int(round((config.NORTH - lat) / config.RES))
        j = int(round((lon - config.WEST) / config.RES))
        k = self.country_index[i, j]
        if self.land[i, j] and k >= 0:
            return country_label(self.countries[k]["name"], lat, lon)
        return sea_name(lat, lon)

    def towns_in(self, mask: np.ndarray, values: np.ndarray | None = None, limit: int = 3,
                 min_pop: int = 50000) -> list[dict]:
        """Biggest towns inside the mask (weighted by the field value when given)."""
        out = []
        for p in self.places:
            if p["pop"] < min_pop:
                continue
            i = int(round((config.NORTH - p["lat"]) / config.RES))
            j = int(round((p["lon"] - config.WEST) / config.RES))
            if 0 <= i < NY and 0 <= j < NX and mask[i, j]:
                v = float(values[i, j]) if values is not None else 0.0
                out.append({**p, "value": v})
        out.sort(key=lambda p: -(math.log10(p["pop"]) + (p["value"] / 4 if values is not None else 0)))
        picked: list[dict] = []
        for p in out:  # keep labels apart on the map
            if all(km_between(p["lat"], p["lon"], q["lat"], q["lon"]) > 150 for q in picked):
                picked.append(p)
            if len(picked) == limit:
                break
        return picked
