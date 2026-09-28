"""Download and simplify Morocco's 12 regions for the dashboard map.

One-off helper (the output, energy/data/regions.geojson, is committed):
    pip install shapely requests
    python energy/pipeline/fetch_boundaries.py

Source: geoBoundaries gbOpen MAR ADM1 (CC BY 4.0), which follows the 2015
regional division into 12 regions.
"""
import json

import requests
from shapely.geometry import mapping, shape

from config import DATA, REGIONS

URL = ("https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/"
       "releaseData/gbOpen/MAR/ADM1/geoBoundaries-MAR-ADM1_simplified.geojson")
TOLERANCE = 0.01        # degrees (~1 km); plenty for a national overview map


def rounded(coords, nd=3):
    if isinstance(coords[0], (int, float)):
        return [round(c, nd) for c in coords]
    return [rounded(c, nd) for c in coords]


def main():
    src = requests.get(URL, timeout=60).json()
    by_iso = {r["iso"]: rid for rid, r in REGIONS.items()}
    features = []
    for f in src["features"]:
        iso = f["properties"]["shapeISO"]
        rid = by_iso[iso]
        geom = mapping(shape(f["geometry"]).simplify(TOLERANCE, preserve_topology=True))
        features.append({"type": "Feature",
                         "properties": {"id": rid, "iso": iso, "name": REGIONS[rid]["name"]},
                         "geometry": {"type": geom["type"], "coordinates": rounded(geom["coordinates"])}})
    missing = set(REGIONS) - {f["properties"]["id"] for f in features}
    assert not missing, f"regions missing from boundaries: {missing}"
    out = DATA / "regions.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                              ensure_ascii=False, separators=(",", ":")))
    print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KB, {len(features)} regions)")


if __name__ == "__main__":
    main()
