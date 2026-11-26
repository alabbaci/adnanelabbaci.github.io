"""Build the line layers drawn over the terrain: data/lines.json.

Source: Overture Maps (release pinned below), GeoParquet on AWS S3, anonymous.
  * transportation/segment: roads of class motorway, trunk and primary; railways.
  * base/water: rivers (OpenStreetMap waterway=river), merged into river systems.

Everything is projected to the map's km frame, merged, simplified and rounded
to 100 m, and only what lies inside the 12 regions is kept.

Run:  python morocco4x/pipeline/02_lines.py     (after 01_terrain.py)
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString
from shapely.ops import linemerge, unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CACHE, COLS, DATA, XMIN, YMAX, hex_index, project  # noqa: E402

OVERTURE_RELEASE = "2026-11-18.0"
BBOX = (-17.3, 20.6, -0.9, 36.0)          # lon/lat window around the 12 regions
RAIL_SKIP = {"tram", "subway", "light_rail", "funicular", "monorail"}


def overture(theme: str, typ: str, extra, columns, name: str):
    """Read one Overture type for the bbox (cached as parquet)."""
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import pyarrow.parquet as pq

    path = CACHE / f"{name}.parquet"
    if path.exists():
        return pq.read_table(path)
    import s3fs

    fs = s3fs.S3FileSystem(anon=True, client_kwargs={"region_name": "us-west-2"})
    d = ds.dataset(f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme={theme}/type={typ}", filesystem=fs, format="parquet")
    bb = ((pc.field("bbox", "xmax") > BBOX[0]) & (pc.field("bbox", "xmin") < BBOX[2])
          & (pc.field("bbox", "ymax") > BBOX[1]) & (pc.field("bbox", "ymin") < BBOX[3]))
    tb = d.to_table(filter=bb & extra, columns=columns)
    pq.write_table(tb, path)
    return tb


def to_km(geom):
    """shapely geometry in lon/lat -> same geometry in frame km (+y south)."""
    def f(c):
        x, y = project(c[:, 0], c[:, 1])
        return np.column_stack([x - XMIN, YMAX - y])
    return shapely.transform(geom, f)


def in_play_mask():
    g = np.load(CACHE / "grid.npz")
    return g["in_play"]


def keep_inside(lines, in_play, min_share=0.5):
    """Keep lines that lie mostly inside the 12 regions (sampled along the line)."""
    out = []
    for ln in lines:
        n = max(2, int(ln.length / 4))
        pts = [ln.interpolate(k / (n - 1), normalized=True) for k in range(n)]
        xy = np.array([[p.x, p.y] for p in pts])
        idx = hex_index(xy[:, 0] + XMIN, YMAX - xy[:, 1])
        ok = (idx >= 0) & in_play[np.clip(idx, 0, None)]
        if ok.mean() >= min_share:
            out.append(ln)
    return out


def merged(geoms, tol, min_km, dedupe_km=0.0):
    """Join segments that share end points, simplify, drop short pieces.

    With dedupe_km, a line running alongside an already kept longer line (the other
    carriageway of a motorway, mapped a few metres away) is dropped.
    """
    if not geoms:
        return []
    m = linemerge(geoms) if len(geoms) > 1 else geoms[0]
    parts = [p for p in (m.geoms if hasattr(m, "geoms") else [m]) if p.geom_type == "LineString"]
    out = []
    for p in sorted(parts, key=lambda p: -p.length):
        p = p.simplify(tol, preserve_topology=False)
        if p.length < min_km:
            continue
        out.append(p)
    if dedupe_km and out:
        kept, cover = [], None
        for p in out:
            if cover is not None and p.intersection(cover).length > 0.8 * p.length:
                continue
            kept.append(p)
            buf = p.buffer(dedupe_km)
            cover = buf if cover is None else cover.union(buf)
        out = kept
    return out


def latin(name):
    """OSM names often carry Tifinagh and Arabic after the Latin form: keep the Latin part."""
    import re
    m = re.match(r"[^\u0600-\u06FF\u2D30-\u2D7F]+", name or "")
    return m.group(0).strip() if m and m.group(0).strip() else name


def coords(ln):
    return [round(v, 1) for xy in ln.coords for v in xy]


def main():
    import pyarrow.compute as pc

    in_play = in_play_mask()

    seg = overture("transportation", "segment",
                   (pc.field("subtype") == "rail") | pc.field("class").isin(["motorway", "trunk", "primary"]),
                   ["id", "subtype", "class", "geometry"], "ov_segments")
    geoms = shapely.from_wkb(seg["geometry"].to_numpy(zero_copy_only=False))
    sub = seg["subtype"].to_pylist()
    cls = seg["class"].to_pylist()
    groups = defaultdict(list)
    for g, s, c in zip(geoms, sub, cls):
        if g is None or g.geom_type != "LineString":
            continue
        if s == "rail":
            if c in RAIL_SKIP:
                continue
            groups["rail"].append(g)
        elif c == "motorway":
            groups["motorway"].append(g)
        elif c in ("trunk", "primary"):
            groups["main"].append(g)
    print({k: len(v) for k, v in groups.items()})

    roads = []
    for key, c, tol, min_km in (("motorway", 0, 0.3, 2.0), ("main", 1, 0.45, 5.0)):
        km = [to_km(g) for g in groups[key]]
        lines = keep_inside(merged(km, tol, min_km, dedupe_km=0.3), in_play)
        roads += [{"c": c, "p": coords(ln)} for ln in lines]
        print(f"{key}: {len(lines)} lines, {sum(l.length for l in lines):,.0f} km")
    rails = keep_inside(merged([to_km(g) for g in groups["rail"]], 0.35, 8.0, dedupe_km=0.2), in_play)
    print(f"rail: {len(rails)} lines, {sum(l.length for l in rails):,.0f} km")

    # ---- rivers: connected systems of OSM river lines
    wt = overture("base", "water", (pc.field("subtype") == "river") & (pc.field("class") == "river"),
                  ["id", "names", "geometry", "is_intermittent"], "ov_rivers")
    wg = shapely.from_wkb(wt["geometry"].to_numpy(zero_copy_only=False))
    names = [(n or {}).get("primary") for n in wt["names"].to_pylist()]
    inter = wt["is_intermittent"].to_pylist()
    items = [(to_km(g), nm, bool(it)) for g, nm, it in zip(wg, names, inter) if g is not None and g.geom_type == "LineString"]
    parent = {}

    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    key = lambda c: (round(c[0], 2), round(c[1], 2))
    for g, _, _ in items:
        a, b = find(key(g.coords[0])), find(key(g.coords[-1]))
        if a != b:
            parent[a] = b
    comp = defaultdict(list)
    for it in items:
        comp[find(key(it[0].coords[0]))].append(it)
    rivers = []
    for members in comp.values():
        total = sum(g.length for g, _, _ in members)
        if total < 90:
            continue
        nm = Counter()
        for g, n, _ in members:
            if n:
                nm[n] += g.length
        dry = sum(g.length for g, _, it in members if it) / total
        lines = keep_inside(merged([g for g, _, _ in members], 0.45, 12.0), in_play, 0.6)
        if not lines:
            continue
        kept = sum(l.length for l in lines)
        rank = 2 if kept >= 600 else 1 if kept >= 280 else 0
        for ln in lines:
            # tributaries of a big system are drawn thinner than its main stems
            rivers.append({"n": latin(nm.most_common(1)[0][0]) if nm else None, "w": rank if ln.length >= 60 else max(0, rank - 1),
                           "i": int(dry > 0.5), "p": coords(ln)})
    print(f"rivers: {len(rivers)} lines in {len({r['n'] for r in rivers})} named systems, {sum(len(r['p']) for r in rivers) // 2} points")
    top = Counter()
    for r in rivers:
        top[r["n"]] += len(r["p"])
    print("  largest:", [n for n, _ in top.most_common(14)])

    out = {"roads": roads, "rail": [{"p": coords(ln)} for ln in rails], "rivers": rivers,
           "source": f"Overture Maps {OVERTURE_RELEASE} (transportation segments, base water); (c) OpenStreetMap contributors, Overture Maps Foundation"}
    (DATA / "lines.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote lines.json ({(DATA / 'lines.json').stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
