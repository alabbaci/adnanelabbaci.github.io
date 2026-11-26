"""Shared geometry for the Morocco 4X map: projection, hex grid, paths.

Projection: spherical Lambert azimuthal equal-area centred on Morocco, so a
hex covers the same ground area everywhere on the map (86.6 km² ... see HEX_KM).
Grid: pointy-top hexagons in "odd-r" offset layout (odd rows shifted right).
All projected coordinates are kilometres; +x east, +y north.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
SOURCES = HERE / "sources"
DATA = HERE.parent / "data"

R_KM = 6371.0088
LON0, LAT0 = -8.6, 28.6          # projection centre

HEX_KM = 8.0                     # flat-to-flat width of a hex
SIZE = HEX_KM / math.sqrt(3)     # centre-to-corner
ROW_KM = 1.5 * SIZE              # vertical distance between rows
HEX_AREA_KM2 = math.sqrt(3) / 2 * HEX_KM ** 2

# Map frame in projected km (covers Morocco plus sea and neighbours for context).
XMIN, XMAX = -980.0, 800.0
YMIN, YMAX = -940.0, 890.0
COLS = int(math.ceil((XMAX - XMIN) / HEX_KM))
ROWS = int(math.ceil((YMAX - YMIN) / ROW_KM))
N = COLS * ROWS


def project(lon, lat):
    """lon/lat in degrees -> x, y in km (numpy-friendly)."""
    lam = np.radians(np.asarray(lon, dtype=float) - LON0)
    phi = np.radians(np.asarray(lat, dtype=float))
    phi0 = math.radians(LAT0)
    cosc = math.sin(phi0) * np.sin(phi) + math.cos(phi0) * np.cos(phi) * np.cos(lam)
    k = np.sqrt(2.0 / (1.0 + cosc))
    x = R_KM * k * np.cos(phi) * np.sin(lam)
    y = R_KM * k * (math.cos(phi0) * np.sin(phi) - math.sin(phi0) * np.cos(phi) * np.cos(lam))
    return x, y


def unproject(x, y):
    """x, y in km -> lon, lat in degrees."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    phi0 = math.radians(LAT0)
    rho = np.hypot(x, y)
    rho = np.where(rho == 0, 1e-12, rho)
    c = 2.0 * np.arcsin(np.clip(rho / (2.0 * R_KM), -1, 1))
    lat = np.arcsin(np.cos(c) * math.sin(phi0) + y * np.sin(c) * math.cos(phi0) / rho)
    lon = LON0 + np.degrees(np.arctan2(x * np.sin(c), rho * math.cos(phi0) * np.cos(c) - y * math.sin(phi0) * np.sin(c)))
    return lon, np.degrees(lat)


def hex_center(col, row):
    """Projected km of the centre of hex (col, row). Row 0 is the northern edge."""
    col = np.asarray(col)
    row = np.asarray(row)
    x = XMIN + HEX_KM * (col + 0.5 * (row & 1)) + HEX_KM / 2
    y = YMAX - (ROW_KM * row + SIZE)
    return x, y


def hex_index(x, y):
    """Projected km -> flat cell index (row * COLS + col), or -1 outside the frame."""
    fx = (np.asarray(x, dtype=float) - XMIN - HEX_KM / 2) / SIZE
    fy = (YMAX - np.asarray(y, dtype=float) - SIZE) / SIZE
    q = math.sqrt(3) / 3 * fx - fy / 3
    r = 2.0 / 3 * fy
    # cube rounding
    cx, cz = q, r
    cy = -cx - cz
    rx, ry, rz = np.rint(cx), np.rint(cy), np.rint(cz)
    dx, dy, dz = np.abs(rx - cx), np.abs(ry - cy), np.abs(rz - cz)
    fix_x = (dx > dy) & (dx > dz)
    fix_z = ~fix_x & ~(dy > dz)
    rx = np.where(fix_x, -ry - rz, rx)
    rz = np.where(fix_z, -rx - ry, rz)
    row = rz.astype(np.int64)
    col = (rx + (rz - (row & 1)) / 2).astype(np.int64)
    ok = (col >= 0) & (col < COLS) & (row >= 0) & (row < ROWS)
    return np.where(ok, row * COLS + col, -1)


def neighbors(col, row):
    """The six neighbours of an odd-r hex, as (col, row) pairs inside the frame."""
    if row & 1:
        d = [(1, 0), (1, -1), (0, -1), (-1, 0), (0, 1), (1, 1)]
    else:
        d = [(1, 0), (0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1)]
    out = []
    for dc, dr in d:
        c, r = col + dc, row + dr
        if 0 <= c < COLS and 0 <= r < ROWS:
            out.append((c, r))
    return out
