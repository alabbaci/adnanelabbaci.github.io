"""
01_build_zones.py

Builds the analysis zones of the Dakhla urban observatory and their
indicators, from layers already in this repository:

    data/processed/dakhla_buildings_3d.geojson   footprints + heights (scripts/01)
    dakhla/data/sectors.geojson                  peninsula land (dakhla/pipeline/01)
    dakhla/data/roads.geojson                    streets (dakhla/pipeline/02)

Exports:

    observatory/data/zones.geojson   zones with every indicator as a property
    observatory/data/city.json       city totals, indicator catalogue, method notes

Dakhla has no openly published neighbourhood boundaries or neighbourhood
statistics. The zones are therefore drawn from the buildings themselves:
footprints are clustered (k-means on centroids), each cluster takes the land
nearest to its centre, and the result is clipped to the built-up area.
They are analysis units, not administrative districts.

Requirements: geopandas, shapely, numpy
"""

import json
import os

import geopandas as gpd
import numpy as np
import shapely
from shapely.geometry import MultiPoint, Point

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
OUT = os.path.join(HERE, "..", "data")
UTM = "EPSG:32628"
N_ZONES = 18
BUILT_BUFFER_M = 220          # a zone reaches this far beyond its outermost buildings
TOTAL_POPULATION = 161_723    # RGPH 2024, Dakhla (same figure as scripts/03)
NON_RESIDENTIAL = {"religious", "commercial", "industrial", "education", "outbuilding",
                   "civic", "entertainment", "medical", "transportation", "service", "agricultural"}
SEED = 7
COMPASS = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"]


def kmeans(xy, k, seed, iters=200):
    rng = np.random.default_rng(seed)
    centres = [xy[rng.integers(len(xy))]]
    for _ in range(k - 1):                      # k-means++ seeding
        d = np.min([((xy - c) ** 2).sum(1) for c in centres], axis=0)
        centres.append(xy[rng.choice(len(xy), p=d / d.sum())])
    centres = np.array(centres)
    for _ in range(iters):
        lab = np.argmin(((xy[:, None, :] - centres[None]) ** 2).sum(2), axis=1)
        new = np.array([xy[lab == i].mean(0) if (lab == i).any() else centres[i] for i in range(k)])
        if np.allclose(new, centres, atol=0.5):
            break
        centres = new
    return centres


def main():
    bld = gpd.read_file(os.path.join(ROOT, "data", "processed", "dakhla_buildings_3d.geojson")).to_crs(UTM)
    sectors = gpd.read_file(os.path.join(ROOT, "dakhla", "data", "sectors.geojson")).to_crs(UTM)
    roads = gpd.read_file(os.path.join(ROOT, "dakhla", "data", "roads.geojson")).to_crs(UTM)
    land = sectors[sectors["kind"] == "peninsula"].union_all().buffer(15).buffer(-15)

    cen = bld.geometry.centroid
    xy = np.column_stack([cen.x, cen.y])
    centres = kmeans(xy, N_ZONES, SEED)
    built = shapely.union_all(bld.geometry.buffer(BUILT_BUFFER_M).values).intersection(land)
    cells = shapely.voronoi_polygons(MultiPoint(centres), extend_to=built.envelope.buffer(5000))
    zones = []
    for cell in cells.geoms:
        g = cell.intersection(built)
        parts = [p for p in getattr(g, "geoms", [g]) if p.geom_type == "Polygon" and p.area > 5000]
        if parts:
            zones.append(shapely.union_all(parts))
    z = gpd.GeoDataFrame(geometry=zones, crs=UTM)

    # Order the zones south to north along the peninsula and number them.
    axis = np.array([0.626, 0.780])               # unit vector tip -> neck in UTM 28N
    z["along"] = [float(axis @ np.array(g.centroid.coords[0])) for g in z.geometry]
    z = z.sort_values("along").reset_index(drop=True)
    z["id"] = [f"Z{i + 1:02d}" for i in range(len(z))]

    # Every building belongs to the zone it sits in (nearest zone for edge cases).
    b = gpd.GeoDataFrame({"area": bld.geometry.area, "height": bld["calculated_height"],
                          "res": ~bld["subtype"].isin(NON_RESIDENTIAL)}, geometry=cen, crs=UTM)
    b = gpd.sjoin_nearest(b, z[["id", "geometry"]], how="left")
    b = b[~b.index.duplicated()]
    b["res_volume"] = np.where(b["res"], b["area"] * b["height"], 0.0)
    b["pop"] = b["res_volume"] / b["res_volume"].sum() * TOTAL_POPULATION
    agg = b.groupby("id").agg(buildings=("area", "size"), footprint_m2=("area", "sum"),
                              population=("pop", "sum"), height_mean=("height", "mean"))

    centre = Point(xy[:, 0].mean(), xy[:, 1].mean())    # centre of gravity of the built city
    named = roads[roads["name"].notna() & ~roads["name"].str.fullmatch(r"(Rue|Rue No|Rue \d+)")]
    rows = []
    for _, r in z.iterrows():
        g, a = r.geometry, agg.loc[r["id"]]
        km2 = g.area / 1e6
        inside = roads.geometry.intersection(g)
        street = named.assign(l=named.geometry.intersection(g).length).groupby("name")["l"].sum()
        street = street[street > 150].sort_values(ascending=False)
        c = g.centroid
        dx, dy = c.x - centre.x, c.y - centre.y
        dist = float(np.hypot(dx, dy))
        where = "centre" if dist < 700 else COMPASS[int(((np.degrees(np.arctan2(dy, dx)) + 22.5) % 360) // 45)]
        rows.append({
            "id": r["id"],
            "name": f"{r['id']} · {street.index[0]}" if len(street) else f"{r['id']} · {dist / 1000:.1f} km {where}",
            "position": where, "km_from_centre": round(dist / 1000, 1),
            "area_km2": round(km2, 3),
            "buildings": int(a.buildings),
            "population": int(round(a.population)),
            "density": int(round(a.population / km2)),
            "built_share": round(100 * a.footprint_m2 / g.area, 1),
            "street_density": round(float(inside.length.sum()) / 1000 / km2, 1),
            "height_mean": round(float(a.height_mean), 1),
            "geometry": g,
        })
    out = gpd.GeoDataFrame(rows, crs=UTM)
    out["geometry"] = out.geometry.simplify(4)
    out.to_crs(4326).to_file(os.path.join(OUT, "zones.geojson"), driver="GeoJSON", COORDINATE_PRECISION=5)

    total_km2 = float(out.area_km2.sum())
    city = {
        "name": "Dakhla",
        "zones": len(out),
        "population": TOTAL_POPULATION, "population_year": 2024,
        "population_source": "RGPH 2024 city total, distributed by residential building volume",
        "area_km2": round(total_km2, 2),
        "buildings": int(out.buildings.sum()),
        "centre": [round(v, 5) for v in gpd.GeoSeries([centre], crs=UTM).to_crs(4326).iloc[0].coords[0]],
        "bbox": [round(float(v), 5) for v in out.to_crs(4326).total_bounds],
        "city_values": {
            "population": TOTAL_POPULATION,
            "density": int(round(TOTAL_POPULATION / total_km2)),
            "built_share": round(100 * float(b["area"].sum()) / (total_km2 * 1e6), 1),
            "street_density": round(float(roads.geometry.intersection(out.union_all()).length.sum()) / 1000 / total_km2, 1),
        },
    }
    json.dump(city, open(os.path.join(OUT, "city.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(city, indent=1))
    print(out.drop(columns="geometry").to_string())


if __name__ == "__main__":
    main()
