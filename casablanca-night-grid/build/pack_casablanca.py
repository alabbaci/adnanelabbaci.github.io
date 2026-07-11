#!/usr/bin/env python
"""Pack central Casablanca's buildings + roads into compact base64 typed
arrays and assemble the final self-contained casablanca-night-grid/index.html.

Scheme (adapted from amyxqc/auckland-night-grid):
- Reproject EPSG:4326 -> EPSG:32629 (UTM 29N, meters).
- Quantize coords to decimeters relative to buildings' min-x/min-y (shared origin).
- Per ring/polyline: first vertex Int32 pair, then Int16 delta pairs; drop
  consecutive post-quantization dupes + closing dupe; skip rings <3 pts.
- Arrays: ring lengths Uint16, ring role Uint8 (0=outer,1=hole), rings-per-building
  Uint8, heights Float32 (Overture height, else num_floors*3.2, else 4.5).
- Roads same scheme; subdivide segments whose delta exceeds Int16.
- Base64 each array separately -> const P = {...} with meta {scale:10, nBld, nRoad}.
"""
import base64
import json
import math
import sys
import numpy as np
import geopandas as gpd
from shapely.geometry.polygon import orient

from pathlib import Path

ROOT = str(Path(__file__).resolve().parents[1])
VENDOR = f"{ROOT}/build/vendor/package"
SCALE = 10  # decimeters
I16MIN, I16MAX = -32768, 32767
METERS_PER_FLOOR = 3.2
DEFAULT_HEIGHT_M = 4.5  # medina fabric is mostly 1-2 storeys

def b64(arr):
    return base64.b64encode(arr.tobytes()).decode("ascii")

def parse_height(h, floors):
    if h is not None and not (isinstance(h, float) and math.isnan(h)):
        v = float(h)
        if math.isfinite(v) and v > 0.5:
            return v
    if floors is not None and not (isinstance(floors, float) and math.isnan(floors)):
        v = float(floors) * METERS_PER_FLOOR
        if math.isfinite(v) and v > 0.5:
            return v
    return DEFAULT_HEIGHT_M

def quantize_ring(coords, ox, oy, closed):
    """-> list of (qx,qy) ints: dupes dropped, closing dupe dropped if closed."""
    q = []
    for x, y in coords:
        qx = int(round((x - ox) * SCALE))
        qy = int(round((y - oy) * SCALE))
        if not q or (qx, qy) != q[-1]:
            q.append((qx, qy))
    if closed and len(q) > 1 and q[0] == q[-1]:
        q.pop()
    return q

def subdivide(q):
    """Insert midpoints so every delta fits Int16."""
    out = [q[0]]
    for p in q[1:]:
        stack = [p]
        while stack:
            nxt = stack[-1]
            dx, dy = nxt[0] - out[-1][0], nxt[1] - out[-1][1]
            if I16MIN <= dx <= I16MAX and I16MIN <= dy <= I16MAX:
                out.append(stack.pop())
            else:
                stack.append(((out[-1][0] + nxt[0]) // 2, (out[-1][1] + nxt[1]) // 2))
    return out

class Packer:
    def __init__(self):
        self.lens, self.roles, self.starts, self.deltas = [], [], [], []

    def add(self, q, role=0):
        q = subdivide(q)
        if len(q) > 65535:
            q = q[:65535]
        self.lens.append(len(q))
        self.roles.append(role)
        self.starts.extend(q[0])
        for i in range(1, len(q)):
            self.deltas.extend((q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]))
        return True

def main():
    print("reading geojson ...")
    bld = gpd.read_file(f"{ROOT}/datasets/casablanca_buildings.geojson").to_crs(32629)
    rds = gpd.read_file(f"{ROOT}/datasets/casablanca_roads.geojson").to_crs(32629)

    minx, miny, maxx, maxy = bld.total_bounds
    ox, oy = minx, miny
    print(f"origin (UTM 29N): {ox:.1f}, {oy:.1f}   extent: {maxx-minx:.0f} x {maxy-miny:.0f} m")

    # ---- buildings ----
    bp = Packer()
    rings_per_bld, heights = [], []
    n_measured = 0
    skipped = 0
    for geom, h, fl in zip(bld.geometry, bld.get("height"), bld.get("num_floors")):
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        nrings = 0
        for poly in polys:
            poly = orient(poly, 1.0)  # exterior CCW, holes CW
            ext = quantize_ring(poly.exterior.coords, ox, oy, True)
            if len(ext) < 3:
                skipped += 1
                continue
            bp.add(ext, 0)
            nrings += 1
            for hole in poly.interiors:
                hq = quantize_ring(hole.coords, ox, oy, True)
                if len(hq) < 3:
                    continue
                bp.add(hq, 1)
                nrings += 1
        if nrings == 0:
            continue  # building fully degenerate -> drop entirely
        rings_per_bld.append(min(nrings, 255))
        hv = parse_height(h, fl)
        if hv != DEFAULT_HEIGHT_M:
            n_measured += 1
        heights.append(hv)
    n_bld = len(rings_per_bld)
    print(f"buildings: {n_bld} kept ({n_measured} with height/floors data), "
          f"{skipped} degenerate rings skipped, {len(bp.lens)} rings")

    # ---- roads ----
    rp = Packer()
    for geom in rds.geometry:
        lines = list(geom.geoms) if geom.geom_type == "MultiLineString" else [geom]
        for line in lines:
            q = quantize_ring(line.coords, ox, oy, False)
            if len(q) < 2:
                continue
            rp.add(q)
    n_road = len(rp.lens)
    print(f"roads: {n_road} polylines")

    payload = {
        "meta": {"scale": SCALE, "nBld": n_bld, "nRoad": n_road},
        "bLens": b64(np.array(bp.lens, np.uint16)),
        "bRoles": b64(np.array(bp.roles, np.uint8)),
        "bStarts": b64(np.array(bp.starts, np.int32)),
        "bDeltas": b64(np.array(bp.deltas, np.int16)),
        "bRings": b64(np.array(rings_per_bld, np.uint8)),
        "bHeights": b64(np.array(heights, np.float32)),
        "rLens": b64(np.array(rp.lens, np.uint16)),
        "rStarts": b64(np.array(rp.starts, np.int32)),
        "rDeltas": b64(np.array(rp.deltas, np.int16)),
    }

    # sanity: sum(lens) - nRings == deltaPairs
    assert sum(bp.lens) - len(bp.lens) == len(bp.deltas) // 2
    assert sum(rp.lens) - len(rp.lens) == len(rp.deltas) // 2
    assert len(bp.roles) == len(bp.lens) and sum(rings_per_bld) == len(bp.lens)
    assert all(math.isfinite(h) for h in heights)

    # ---- assemble html ----
    libs = []
    for path in [
        "build/three.min.js",
        "examples/js/controls/OrbitControls.js",
        "examples/js/postprocessing/Pass.js",
        "examples/js/postprocessing/EffectComposer.js",
        "examples/js/postprocessing/RenderPass.js",
        "examples/js/postprocessing/ShaderPass.js",
        "examples/js/shaders/CopyShader.js",
        "examples/js/shaders/LuminosityHighPassShader.js",
        "examples/js/postprocessing/UnrealBloomPass.js",
    ]:
        with open(f"{VENDOR}/{path}") as f:
            libs.append(f"<script>\n{f.read()}\n</script>")
    with open(f"{VENDOR}/src/earcut.js") as f:
        ec = f.read()
    ec = ec.replace("module.exports = earcut;", "window.earcut = earcut;")
    ec = ec.replace("module.exports.default = earcut;", "")
    libs.append(f"<script>\n{ec}\n</script>")

    with open(f"{ROOT}/build/template.html") as f:
        html = f.read()
    html = html.replace("<!--LIBS-->", "\n".join(libs))
    html = html.replace("/*PAYLOAD*/", f"const P = {json.dumps(payload)};")

    out = f"{ROOT}/index.html"
    with open(out, "w") as f:
        f.write(html)
    print(f"wrote {out}  ({len(html)/1e6:.2f} MB)")

if __name__ == "__main__":
    sys.exit(main())
