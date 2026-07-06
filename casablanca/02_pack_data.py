"""Step 2a — Pack Casablanca GeoJSON into compact base64 typed arrays.

Scheme (per the Night Grid spec):
- All coordinates quantized to decimeters relative to the buildings'
  min-x/min-y origin (shared origin for roads).
- Per ring/polyline: first vertex as Int32 pair, subsequent vertices as
  Int16 delta pairs; consecutive duplicates dropped after quantization;
  ring closing vertex dropped; rings with <3 points skipped.
- Per-ring vertex counts (Uint16), per-ring role (Uint8: 0=outer, 1=hole;
  first ring of each polygon is outer), rings-per-building (Uint8),
  per-building heights (Float32; 0 = unknown).
- Roads: same lens/starts/deltas scheme; edges whose delta would overflow
  Int16 are subdivided.
- Each typed array is base64-encoded separately (little-endian).
"""
import base64
import json
import math

import numpy as np
from shapely.geometry import shape
from shapely.geometry.polygon import orient

SCALE = 10  # decimeters
I16_MAX = 32767


def b64(arr: np.ndarray) -> str:
    return base64.b64encode(arr.tobytes()).decode("ascii")


def quantize_seq(coords, ox, oy, closed):
    """Coordinate sequence -> quantized int pairs, dups dropped."""
    pts = []
    for x, y in coords:
        q = (round(x * SCALE) - ox, round(y * SCALE) - oy)
        if not pts or q != pts[-1]:
            pts.append(q)
    if closed and len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts


def subdivide(pts):
    """Insert midpoints so every consecutive delta fits in Int16."""
    out = [pts[0]]
    for b in pts[1:]:
        a = out[-1]
        n = max(
            1,
            math.ceil(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / I16_MAX),
        )
        for k in range(1, n + 1):
            p = (
                a[0] + (b[0] - a[0]) * k // n,
                a[1] + (b[1] - a[1]) * k // n,
            )
            if p != out[-1]:
                out.append(p)
    return out


class Packer:
    def __init__(self):
        self.lens, self.starts, self.deltas = [], [], []

    def add(self, pts):
        pts = subdivide(pts)
        self.lens.append(len(pts))
        self.starts.extend(pts[0])
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            self.deltas.extend((bx - ax, by - ay))
        return len(pts)


def main():
    with open("casablanca_buildings.geojson") as f:
        bld_fc = json.load(f)["features"]
    with open("casablanca_roads.geojson") as f:
        road_fc = json.load(f)["features"]

    # Shared decimeter origin from the buildings layer
    minx = miny = math.inf
    for ft in bld_fc:
        g = ft["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            for x, y in poly[0]:
                minx, miny = min(minx, x), min(miny, y)
    ox, oy = round(minx * SCALE), round(miny * SCALE)

    # --- Buildings ---
    bp = Packer()
    roles, rings_per, heights = [], [], []
    skipped = 0
    for ft in bld_fc:
        g = ft["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        n_rings = 0
        for poly in polys:
            # normalize winding: outer CCW, holes CW
            p = orient(shape({"type": "Polygon", "coordinates": poly}), sign=1.0)
            outer = quantize_seq(p.exterior.coords, ox, oy, closed=True)
            if len(outer) < 3:
                skipped += 1
                continue
            n_rings += 1
            bp.add(outer)
            roles.append(0)
            for hole in p.interiors:
                hq = quantize_seq(hole.coords, ox, oy, closed=True)
                if len(hq) < 3:
                    continue
                n_rings += 1
                bp.add(hq)
                roles.append(1)
        if n_rings == 0:
            continue
        assert n_rings <= 255, "building with >255 rings"
        rings_per.append(n_rings)
        h = float(ft["properties"].get("height_m") or 0.0)
        heights.append(h if math.isfinite(h) else 0.0)

    # --- Roads ---
    rp = Packer()
    for ft in road_fc:
        pts = quantize_seq(ft["geometry"]["coordinates"], ox, oy, closed=False)
        if len(pts) < 2:
            continue
        rp.add(pts)

    payload = {
        "meta": {
            "scale": SCALE,
            "nBld": len(heights),
            "nRoad": len(rp.lens),
            "city": "Casablanca",
            "crs": "EPSG:32629",
        },
        "bldRingLens": b64(np.asarray(bp.lens, "<u2")),
        "bldRingRole": b64(np.asarray(roles, "<u1")),
        "bldRingsPer": b64(np.asarray(rings_per, "<u1")),
        "bldStarts": b64(np.asarray(bp.starts, "<i4")),
        "bldDeltas": b64(np.asarray(bp.deltas, "<i2")),
        "bldHeights": b64(np.asarray(heights, "<f4")),
        "roadLens": b64(np.asarray(rp.lens, "<u2")),
        "roadStarts": b64(np.asarray(rp.starts, "<i4")),
        "roadDeltas": b64(np.asarray(rp.deltas, "<i2")),
    }

    # Self-consistency (mirrors the Node smoke test)
    assert sum(rings_per) == len(bp.lens) == len(roles)
    assert len(bp.deltas) // 2 == sum(bp.lens) - len(bp.lens)
    assert len(rp.deltas) // 2 == sum(rp.lens) - len(rp.lens)
    assert max(bp.lens) <= 65535 and max(rp.lens) <= 65535
    assert max(map(abs, bp.deltas)) <= I16_MAX
    assert max(map(abs, rp.deltas)) <= I16_MAX

    with open("payload.json", "w") as f:
        json.dump(payload, f)

    wall_tris = 2 * sum(bp.lens)
    print(f"buildings: {len(heights)} ({skipped} degenerate rings skipped), "
          f"rings: {len(bp.lens)}, ring vertices: {sum(bp.lens)}")
    print(f"roads: {len(rp.lens)} polylines, {sum(rp.lens)} points")
    print(f"est. wall triangles: {wall_tris}")
    print(f"payload.json: {sum(len(v) for v in payload.values() if isinstance(v, str)) / 1e6:.2f} MB base64")


if __name__ == "__main__":
    main()
