"""
rabat3d_build_network.py

Builds the compact transit network used by the Mini Rabat 3D map
(rabat3d/data/network.json) from two raw OpenStreetMap extracts pulled with
the Overpass API:

    data/rabat3d/raw/osm_tram_and_stations.json
        [out:json];
        relation(id:4486847,4486848,5293754,5391136);out geom;
        (node(r:"stop");node(r:"platform");way(r:"platform"););out tags center;
        nwr["railway"~"^(station|halt|tram_stop)$"](33.90,-6.95,34.10,-6.70);out tags center;

    data/rabat3d/raw/osm_main_rail.json
        [out:json];
        way["railway"="rail"]["usage"="main"](33.93,-6.93,34.08,-6.74);out skel geom;

For each tram line the relation's ways are turned into a graph and the
shortest path from the first to the last stop gives one clean centreline;
the main railway is handled the same way between its south-west and
north-east ends. Stations are then projected onto the line to get their
distance along it, which is all the timetable simulation in the browser
needs.

Requirements: networkx
"""

import json
import math
import os
import re

import networkx as nx

ROOT = os.path.join(os.path.dirname(__file__), "..")
RAW = os.path.join(ROOT, "data", "rabat3d", "raw")
OUT = os.path.join(ROOT, "rabat3d", "data", "network.json")

TRAM_LINES = {
    # id: (relation, colour, display name)
    "T1": (4486847, "#f08a24", "Tramway L1"),
    "T2": (4486848, "#2ba3de", "Tramway L2"),
}

# Main-line stations, south-west to north-east. OSM ids from the raw extract.
RAIL_STATIONS = [
    ("way", 1102453328, "Témara", "تمارة"),
    ("node", 11992660877, "Rabat Riad", "الرباط الرياض"),
    ("way", 449071760, "Rabat Agdal", "الرباط أكدال"),
    ("way", 156426654, "Rabat Ville", "الرباط المدينة"),
    ("way", 456791383, "Salé Ville", "سلا المدينة"),
    ("way", 456791384, "Salé Tabriquet", "سلا تابريكت"),
]

ARABIC = re.compile(r"[\u0600-\u06FF]")
ARABIC_LINE_SUFFIX = re.compile(r"\s*الخط (الأول|الثاني)$")
# Stops whose OSM tags carry no Arabic name.
ARABIC_FALLBACK = {
    "Stade Al Madina": "ملعب المدينة",
    "Yacoub El Mansour": "يعقوب المنصور",
    "Oued Dahab": "وادي الذهب",
    "Essalam": "السلام",
    "Al Houria": "الحرية",
}


def haversine(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def key(p):
    return (round(p[0], 7), round(p[1], 7))


def build_graph(ways):
    g = nx.Graph()
    for geom in ways:
        pts = [key((p["lon"], p["lat"])) for p in geom if p]
        for a, b in zip(pts, pts[1:]):
            if a != b:
                g.add_edge(a, b, weight=haversine(a, b))
    return g


def bridge_gaps(g, max_gap_m):
    """Join track pieces that only meet through switches not tagged usage=main."""
    comp = {n: i for i, c in enumerate(nx.connected_components(g)) for n in c}
    for end in [n for n in g.nodes if g.degree(n) == 1]:
        others = [n for n in g.nodes if comp[n] != comp[end]]
        if not others:
            continue
        near = min(others, key=lambda n: haversine(n, end))
        gap = haversine(near, end)
        if gap < max_gap_m:
            g.add_edge(end, near, weight=gap)


def nearest_node(g, p):
    return min(g.nodes, key=lambda n: haversine(n, p))


def cumulative(coords):
    d = [0.0]
    for a, b in zip(coords, coords[1:]):
        d.append(d[-1] + haversine(a, b))
    return d


def project(coords, dist, p, start_at=0.0):
    """Distance along the polyline of the point closest to p (at or after start_at)."""
    best = (float("inf"), 0.0)
    kx = math.cos(math.radians(p[1]))
    for i in range(len(coords) - 1):
        if dist[i + 1] < start_at:
            continue
        (x1, y1), (x2, y2) = coords[i], coords[i + 1]
        dx, dy = (x2 - x1) * kx, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - x1) * kx * dx + (p[1] - y1) * dy) / L2))
        q = (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
        e = haversine(q, p)
        if e < best[0]:
            best = (e, dist[i] + (dist[i + 1] - dist[i]) * t)
    return best[1], best[0]


def simplify(coords, tol_m=1.5):
    """Douglas-Peucker in a local metric frame; keeps curves smooth for animation."""
    lat0 = coords[0][1]
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110540
    pts = [(x * kx, y * ky) for x, y in coords]

    def rec(i, j, keep):
        (x1, y1), (x2, y2) = pts[i], pts[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1e-9
        worst, idx = 0.0, None
        for k in range(i + 1, j):
            d = abs(dy * (pts[k][0] - x1) - dx * (pts[k][1] - y1)) / L
            if d > worst:
                worst, idx = d, k
        if idx is not None and worst > tol_m:
            keep.add(idx)
            rec(i, idx, keep)
            rec(idx, j, keep)

    keep = {0, len(pts) - 1}
    rec(0, len(pts) - 1, keep)
    return [coords[i] for i in sorted(keep)]


def split_name(name, name_ar):
    name = name or ""
    m = ARABIC.search(name)
    fr = name[: m.start()].strip() if m else name.strip()
    ar = name_ar or (name[m.start():].strip() if m else None)
    fr = re.sub(r"\s+L[12]$", "", fr)  # "Place Al Joulane L1" -> one station name
    if ar:
        ar = ARABIC_LINE_SUFFIX.sub("", ar[ARABIC.search(ar).start():]).strip()
    return fr, ar or ARABIC_FALLBACK.get(fr)


def rounded(coords):
    return [[round(x, 6), round(y, 6)] for x, y in coords]


def main():
    tram = json.load(open(os.path.join(RAW, "osm_tram_and_stations.json")))
    rail = json.load(open(os.path.join(RAW, "osm_main_rail.json")))

    tagged = {}
    for e in tram["elements"]:
        if e["type"] != "relation" and e.get("tags"):
            tagged[(e["type"], e["id"])] = e
    relations = {e["id"]: e for e in tram["elements"] if e["type"] == "relation"}

    lines = []
    for line_id, (rel_id, colour, label) in TRAM_LINES.items():
        rel = relations[rel_id]
        stops = [m for m in rel["members"] if m["type"] == "node" and m["role"] == "stop"]
        g = build_graph([m["geometry"] for m in rel["members"] if m["type"] == "way"])
        a = nearest_node(g, (stops[0]["lon"], stops[0]["lat"]))
        b = nearest_node(g, (stops[-1]["lon"], stops[-1]["lat"]))
        coords = simplify(nx.shortest_path(g, a, b, weight="weight"))
        dist = cumulative(coords)

        stations, cursor = [], 0.0
        for m in stops:
            t = tagged[("node", m["ref"])]["tags"]
            fr, ar = split_name(t.get("name"), t.get("name:ar"))
            d, err = project(coords, dist, (m["lon"], m["lat"]), cursor)
            assert err < 40, (line_id, fr, err)
            cursor = d
            stations.append({"name": fr, "ar": ar, "d": round(d, 1)})
        stations[0]["d"], stations[-1]["d"] = 0.0, round(dist[-1], 1)

        lines.append({
            "id": line_id, "type": "tram", "name": label, "color": colour,
            "from": stations[0]["name"], "to": stations[-1]["name"],
            "length": round(dist[-1], 1), "coords": rounded(coords), "stations": stations,
        })
        print(f"{line_id}: {dist[-1] / 1000:.2f} km, {len(stations)} stops, {len(coords)} vertices")

    # Main railway corridor: south-west end (Témara side) to north-east (Kénitra side).
    g = build_graph([w["geometry"] for w in rail["elements"] if w.get("geometry")])
    bridge_gaps(g, max_gap_m=80)
    g = g.subgraph(max(nx.connected_components(g), key=len))
    sw = min(g.nodes, key=lambda n: n[0] + n[1])
    ne = max(g.nodes, key=lambda n: n[0] + n[1])
    coords = simplify(nx.shortest_path(g, sw, ne, weight="weight"), tol_m=2.5)
    dist = cumulative(coords)
    stations, cursor = [], 0.0
    for kind, osm_id, fr, ar in RAIL_STATIONS:
        c = tagged[(kind, osm_id)]
        p = (c["center"]["lon"], c["center"]["lat"]) if "center" in c else (c["lon"], c["lat"])
        d, err = project(coords, dist, p, cursor)
        assert err < 150, (fr, err)
        cursor = d
        stations.append({"name": fr, "ar": ar, "d": round(d, 1)})
    lines.append({
        "id": "ONCF", "type": "rail", "name": "ONCF main line", "color": "#8a8f98",
        "from": "Témara", "to": "Kénitra", "length": round(dist[-1], 1),
        "coords": rounded(coords), "stations": stations,
    })
    print(f"ONCF corridor: {dist[-1] / 1000:.2f} km, {len(coords)} vertices")
    for s in stations:
        print(f"   {s['name']:<16} {s['d'] / 1000:6.2f} km")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({
            "source": "© OpenStreetMap contributors (ODbL), extracted via Overpass API",
            "lines": lines,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
