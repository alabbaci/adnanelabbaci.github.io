"""Build data/places.json: cities, provinces, regions, resources, yields and lenses.

Inputs (pipeline/sources, small committed tables; provenance is in each file or in the README):
  cities.json          HCP census populations of cities and urban communes + coordinates
  provinces.json       HCP census populations and areas of the 75 provinces and prefectures
  regions_base.json    the 12 regions (id, ISO 3166-2 code, name)
  regions_stats.json   regional indicators (HCP accounts, employment survey, census ...), with sources
  resources.json       mines, power plants, dams, ports, airports, heritage sites ..., with sources
plus pipeline/.cache/grid.npz written by 01_terrain.py.

Run:  python morocco4x/pipeline/03_places.py
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
import unicodedata
from collections import Counter

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CACHE, COLS, DATA, HEX_AREA_KM2, N, ROWS, SOURCES, XMIN, YMAX, hex_center, hex_index, neighbors, project  # noqa: E402

# Regional capitals (chefs-lieux) under the 2015 regional division (decree 2-15-40).
CAPITALS = {"tta": "Tanger", "ori": "Oujda", "fm": "Fès", "rsk": "Rabat", "bmk": "Béni Mellal", "cs": "Casablanca",
            "ms": "Marrakech", "dt": "Errachidia", "sm": "Agadir", "gon": "Guelmim", "lsh": "Laâyoune", "dod": "Dakhla"}
NATIONAL_CAPITAL = "Rabat"
REGION_COLORS = {"tta": "#4aa3df", "ori": "#e08a3c", "fm": "#9b6bd6", "rsk": "#d64d57", "bmk": "#5fb36a", "cs": "#e6c247",
                 "ms": "#d9627f", "dt": "#c98a5a", "sm": "#3fb8a6", "gon": "#8f9bd9", "lsh": "#d2a85f", "dod": "#6fb7c9"}

RESOURCE_CATS = [
    {"id": "mine", "label": "Mines", "color": "#8d6a4a"},
    {"id": "power", "label": "Power plants", "color": "#d9a514"},
    {"id": "dam", "label": "Dams", "color": "#3f86cf"},
    {"id": "port", "label": "Ports", "color": "#2f6f9f"},
    {"id": "fishing_port", "label": "Fishing ports", "color": "#3aa7a0"},
    {"id": "airport", "label": "Airports", "color": "#7d8aa6"},
    {"id": "unesco", "label": "World Heritage", "color": "#b0503f"},
    {"id": "agri", "label": "Crops & produce", "color": "#6a9a3a"},
    {"id": "landmark", "label": "Industry & landmarks", "color": "#8a62b8"},
]


M = 1e6   # HCP regional accounts are in MAD million

# Derived indicators: sector shares of regional GDP.
DERIVED = [
    ("share_primary_2024", "va_primary_2024_mad_million", "Primary sector share of regional GDP",
     "Value added of agriculture, forestry and fishing as a share of the region's GDP (derived from the HCP regional accounts)."),
    ("share_secondary_2024", "va_secondary_2024_mad_million", "Secondary sector share of regional GDP",
     "Value added of industry, mining, energy, water and construction as a share of the region's GDP (derived from the HCP regional accounts)."),
    ("share_tertiary_2024", "va_tertiary_2024_mad_million", "Tertiary sector share of regional GDP",
     "Value added of market and non-market services as a share of the region's GDP (derived from the HCP regional accounts)."),
]

# Region-level lenses: (lens id, indicator key, label, group, format, ramp, scale, value multiplier, note)
LENSES = [
    ("income", "gdp_per_capita_2024_mad", "GDP per head", "Economy", "madpc", "gold", "linear", 1, "Regional GDP divided by population, 2024, current dirhams, as published by HCP."),
    ("consumption", "household_consumption_per_capita_2024_mad", "Household spending", "Economy", "madpc", "gold", "linear", 1, "Household final consumption spending per resident, 2024, current dirhams."),
    ("gdp", "gdp_2024_mad_million", "Regional GDP", "Economy", "mad", "gold", "log", M, "Gross domestic product of the region, 2024, current dirhams. Colour scale is logarithmic."),
    ("farming", "share_primary_2024", "Farming share", "Economy", "pct", "green", "linear", 1, "Agriculture, forestry and fishing as a share of the region's GDP, 2024."),
    ("industry", "share_secondary_2024", "Industry share", "Economy", "pct", "magma", "linear", 1, "Industry, mining, energy, water and construction as a share of the region's GDP, 2024."),
    ("services", "share_tertiary_2024", "Services share", "Economy", "pct", "blue", "linear", 1, "Services as a share of the region's GDP, 2024."),
    ("tourism", "tourism_nights_2024", "Tourist nights", "Economy", "compact", "magma", "log", 1, "Nights spent in tourist accommodation establishments in 2024. Colour scale is logarithmic."),
    ("unemployment", "unemployment_2024_rgph", "Unemployment", "Work & welfare", "pct", "violet", "linear", 1, "Unemployment rate from the 2024 census, for all 12 regions. It runs higher than the employment-survey rate (13.3% nationally), which counts joblessness more strictly."),
    ("poverty", "poverty_multidim_2024", "Poverty", "Work & welfare", "pct", "red", "linear", 1, "Share of residents in multidimensional poverty (health, education and living conditions), 2024."),
    ("poverty_money", "poverty_monetary_2022", "Monetary poverty", "Work & welfare", "pct", "red", "linear", 1, "Share of residents below the national monetary poverty line, 2022 living-standards survey."),
    ("urban", "urban_rate_2024", "Urban share", "People", "pct", "blue", "linear", 1, "Share of residents living in urban areas, 2024 census."),
    ("schooling", "mean_years_schooling_25plus_2024", "Schooling", "Education", "x1", "teal", "linear", 1, "Average years of schooling of residents aged 25 and over, 2024 census."),
    ("secondary", "secondary_plus_share_25plus_2024", "Secondary or more", "Education", "pct", "teal", "linear", 1, "Share of residents aged 25 and over who reached at least lower-secondary school, 2024 census."),
    ("illiteracy", "illiteracy_2024", "Illiteracy", "Education", "pct", "red", "linear", 1, "Share of residents aged 10 and over who cannot read and write, 2024 census."),
]
QUICK = ["density", "income", "schooling"]

# Top-bar yields: (id, label, icon, colour, indicator key, format, multiplier, lens, definition)
YIELDS = [
    ("food", "Food", "food", "#8fc74a", "va_primary_2024_mad_million", "mad", M, "farming",
     "Value added of the primary sector (agriculture, forestry and fishing) in 2024, current dirhams, from the regional accounts."),
    ("production", "Production", "production", "#e08a45", "va_secondary_2024_mad_million", "mad", M, "industry",
     "Value added of the secondary sector (industry, mining, energy, water and construction) in 2024, current dirhams."),
    ("gold", "Gold (GDP)", "gold", "#f2c94c", "gdp_2024_mad_million", "mad", M, "income",
     "Gross domestic product in 2024, current dirhams, by region where the output is produced. The national total includes a small amount HCP does not assign to any region."),
    ("science", "Science (schooling)", "science", "#5fb0ea", "mean_years_schooling_25plus_2024", "x1", 1, "schooling",
     "Average years of schooling of residents aged 25 and over, from the 2024 census. HCP publishes no count of research or technical workers by region, so schooling stands in for science."),
    ("culture", "Culture (tourist nights)", "culture", "#b98be6", "tourism_nights_2024", "compact", 1, "tourism",
     "Nights spent in tourist accommodation establishments in 2024, by region, as counted by the Ministry of Tourism."),
    ("unemployment", "Unemployment rate", "work", "#e8dcc0", "unemployment_2024_ene", "pct", 1, "unemployment",
     "Unemployed as a share of the labour force aged 15 and over, national employment survey 2024. HCP publishes the three southern regions as one group. The Unemployment lens uses the 2024 census rate instead, which exists for all 12 regions and runs higher."),
]

# What the region panel lists, in order: (indicator key, label, format, multiplier)
REGION_FACTS = [
    ("gdp_2024_mad_million", "GDP, 2024", "mad", M),
    ("gdp_per_capita_2024_mad", "GDP per head, 2024", "madpc", 1),
    ("household_consumption_per_capita_2024_mad", "Household spending per head, 2024", "madpc", 1),
    ("urban_rate_2024", "Urban share, 2024", "pct", 1),
    ("households_2024", "Households, 2024", "int", 1),
    ("unemployment_2024_ene", "Unemployment, survey 2024", "pct", 1),
    ("unemployment_2024_rgph", "Unemployment, census 2024", "pct", 1),
    ("activity_rate_2024", "Activity rate, survey 2024", "pct", 1),
    ("illiteracy_2024", "Illiteracy (age 10+), 2024", "pct", 1),
    ("mean_years_schooling_25plus_2024", "Years of schooling (age 25+), 2024", "x1", 1),
    ("secondary_plus_share_25plus_2024", "Secondary schooling or more (25+), 2024", "pct", 1),
    ("poverty_multidim_2024", "Multidimensional poverty, 2024", "pct", 1),
    ("poverty_monetary_2022", "Monetary poverty, 2022", "pct", 1),
    ("tourism_nights_2024", "Tourist nights, 2024", "compact", 1),
]

SOURCES_LIST = [
    {"name": "HCP, RGPH 2024 (general census of population and housing)", "what": "Population of regions, provinces, cities and urban communes; urban share; households; census unemployment, illiteracy and schooling.", "url": "https://www.hcp.ma/", "license": "Public statistics"},
    {"name": "citypopulation.de", "what": "Compilation of the HCP census tables (1994 to 2024) for cities and provinces, and province areas computed from geospatial data.", "url": "https://www.citypopulation.de/en/morocco/", "license": "Compilation of official figures"},
    {"name": "HCP, regional accounts 2024", "what": "GDP, value added by sector, GDP and household consumption per head, by region.", "url": "https://www.hcp.ma/attachment/2891118/", "license": "Public statistics"},
    {"name": "HCP, national employment survey 2024", "what": "Unemployment, activity and employment rates by region (southern regions grouped).", "url": "https://www.hcp.ma/", "license": "Public statistics"},
    {"name": "HCP, poverty mapping 2024 and living-standards survey 2022", "what": "Multidimensional and monetary poverty rates by region.", "url": "https://www.hcp.ma/", "license": "Public statistics"},
    {"name": "Ministry of Tourism, overnight stays by region", "what": "Nights spent in tourist accommodation establishments, by region.", "url": "https://mtaess.gov.ma/", "license": "Public statistics"},
    {"name": "ESA WorldCover 2021 v200", "what": "Land cover at 10 m: cropland, trees, grass, shrub, bare ground, built-up, water. Drives farmland, desert, forest and oasis hexes.", "url": "https://esa-worldcover.org/", "license": "CC BY 4.0"},
    {"name": "Mapzen / Tilezen terrain tiles (SRTM, GMTED, GEBCO)", "what": "Elevation and sea depth: hills, mountains, snow line, shading.", "url": "https://registry.opendata.aws/terrain-tiles/", "license": "Open data, see attribution list"},
    {"name": "geoBoundaries gbOpen MAR ADM1 and ADM2", "what": "Outlines of the 12 regions and 75 provinces and prefectures.", "url": "https://www.geoboundaries.org/", "license": "CC BY 4.0 / ODbL"},
    {"name": "Overture Maps (OpenStreetMap and partners)", "what": "Motorways, main roads, railways, rivers; coordinates of cities.", "url": "https://overturemaps.org/", "license": "ODbL / CDLA"},
    {"name": "Natural Earth", "what": "Neighbouring countries.", "url": "https://www.naturalearthdata.com/", "license": "Public domain"},
    {"name": "Resources: Global Energy Monitor, Mindat, UNESCO World Heritage Centre, ANP, ONP, ONDA, Wikipedia / Wikidata, OpenStreetMap, press reports", "what": "Positions and figures of power plants, mines, dams, ports, airports, heritage sites and produce. Each site links to its own source.", "url": "https://www.gem.wiki/", "license": "Various, see each entry"},
]


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def load(name, default=None):
    p = SOURCES / name
    if not p.exists():
        return default
    return json.loads(p.read_text())


def ring(c, r, k):
    """Cells within k steps of (c, r), nearest first."""
    seen = {(c, r)}
    frontier = [(c, r)]
    out = []
    for _ in range(k):
        nxt = []
        for cc, rr in frontier:
            for n in neighbors(cc, rr):
                if n not in seen:
                    seen.add(n)
                    nxt.append(n)
                    out.append(n)
        frontier = nxt
    return out


def main():
    g = np.load(CACHE / "grid.npz")
    in_play, province, region = g["in_play"], g["province"], g["region"]
    provs = load("provinces.json")
    regs = load("regions_base.json")
    prov_ids = [p["id"] for p in provs]
    reg_ids = [r["id"] for r in regs]

    def place(lon, lat, taken=None, reach=3):
        """Nearest in-play hex to a lon/lat (optionally one not already taken)."""
        x, y = project(lon, lat)
        i = int(hex_index(x, y))
        if i < 0:
            return None
        c, r = i % COLS, i // COLS
        cx0, cy0 = x, y
        cand = [(c, r)] + ring(c, r, reach)
        best = None
        for cc, rr in cand:
            j = rr * COLS + cc
            if not in_play[j] or (taken is not None and j in taken):
                continue
            hx, hy = hex_center(cc, rr)
            d = (hx - cx0) ** 2 + (hy - cy0) ** 2
            if best is None or d < best[0]:
                best = (d, j)
        return best[1] if best else None

    # A city or site belongs to the province whose outline contains its coordinates;
    # the hex it is drawn on can fall across a border.
    from shapely import STRtree
    from shapely.geometry import Point, shape
    adm2 = json.loads((CACHE / "adm2.geojson").read_text())
    by_shape = {p["shape_name"]: p for p in provs}
    polys = [shape(f["geometry"]) for f in adm2["features"]]
    owners = [by_shape[f["properties"]["shapeName"]] for f in adm2["features"]]
    tree = STRtree(polys)

    def owner(lon, lat, cell):
        hit = tree.query(Point(lon, lat), predicate="within")
        if len(hit):
            p = owners[int(hit[0])]
            return p["id"], p["region"]
        return prov_ids[province[cell] - 1], reg_ids[region[cell] - 1]

    # ---------------- cities
    src_c = load("cities.json")
    cities, taken, ids = [], set(), set()
    for c in sorted(src_c["cities"], key=lambda c: -c["pop2024"]):
        cell = place(c["lon"], c["lat"], taken)
        if cell is None:
            print("  city outside the regions, skipped:", c["name"])
            continue
        taken.add(cell)
        cid = slug(c["name"])
        while cid in ids:
            cid += "-2"
        ids.add(cid)
        cap = 3 if c["name"] == NATIONAL_CAPITAL else 0
        cities.append({"id": cid, "name": c["name"], "kind": c["kind"], "pop2024": c["pop2024"], "pop2014": c["pop2014"],
                       "pop2004": c["pop2004"], "pop1994": c["pop1994"], "lat": c["lat"], "lon": c["lon"], "cell": cell,
                       "province": owner(c["lon"], c["lat"], cell)[0], "region": owner(c["lon"], c["lat"], cell)[1], "capital": cap})
    by_name = {c["name"]: c for c in cities}
    for rid, nm in CAPITALS.items():
        c = by_name[nm]
        assert c["region"] == rid, (nm, c["region"], rid)
        c["capital"] = max(c["capital"], 2)
    print(f"cities: {len(cities)}; in {len({c['province'] for c in cities})} provinces")

    # ---------------- provinces and regions
    prov_out = []
    for p in provs:
        gr = None
        if p["pop2014"]:
            gr = round(((p["pop2024"] / p["pop2014"]) ** 0.1 - 1) * 100, 2)
        prov_out.append({"id": p["id"], "name": p["name"], "kind": p["kind"], "region": p["region"], "area_km2": p["area_km2"],
                         "pop2024": p["pop2024"], "pop2014": p["pop2014"], "pop2004": p["pop2004"], "pop1994": p["pop1994"],
                         "density": round(p["pop2024"] / p["area_km2"], 2), "growth": gr})
    reg_out = []
    for r in regs:
        mine = [p for p in provs if p["region"] == r["id"]]
        tot = lambda k: sum(p[k] or 0 for p in mine)
        reg_out.append({"id": r["id"], "iso": r["iso"], "name": r["name"], "capital": CAPITALS[r["id"]], "color": REGION_COLORS[r["id"]],
                        "area_km2": round(tot("area_km2")), "pop2024": tot("pop2024"), "pop2014": tot("pop2014"),
                        "pop2004": tot("pop2004"), "pop1994": tot("pop1994"),
                        "density": round(tot("pop2024") / tot("area_km2"), 2),
                        "growth": round(((tot("pop2024") / tot("pop2014")) ** 0.1 - 1) * 100, 2)})
    nat_pop = sum(r["pop2024"] for r in reg_out)
    nat14 = sum(r["pop2014"] for r in reg_out)
    print(f"national population 2024: {nat_pop:,} (2014: {nat14:,})")

    # ---------------- regional indicators (research table)
    stats = load("regions_stats.json", {"indicators": {}})
    ind = stats["indicators"]

    def vals(key):
        return ind[key]["values"] if key in ind else None

    def have(key):
        v = vals(key)
        return v is not None and sum(1 for k in reg_ids if v.get(k) is not None) >= 9

    lenses = []
    census = "HCP, censuses of 2014 and 2024 (RGPH 2024)"

    def lens(id_, label, group, level, values, fmt, ramp, scale="linear", note="", source="", url="", year=None, clip=False):
        lenses.append({"id": id_, "label": label, "group": group, "level": level, "fmt": fmt, "ramp": ramp, "scale": scale,
                       "note": note, "source": source, "sourceUrl": url, "year": year, "clip": clip, "values": values})

    lens("density", "Population", "People", "province", {p["id"]: p["density"] for p in prov_out}, "density", "magma", "log",
         "Residents per km², by province or prefecture. Colour scale is logarithmic.", census + "; areas from citypopulation.de", "https://www.hcp.ma/", 2024)
    lens("growth", "Growth", "People", "province", {p["id"]: p["growth"] for p in prov_out}, "signedpct", "diverge", "diverge",
         "Average yearly population change between the 2014 and 2024 censuses, by province. Some changes reflect boundary changes. The scale stops at the 5th and 95th percentiles.", census, "https://www.hcp.ma/", 2024, clip=True)

    def ind_lens(id_, key, label, group, fmt, ramp, scale="linear", transform=None):
        if not have(key):
            return False
        m = ind[key]
        v = {k: (transform(m["values"][k]) if transform and m["values"].get(k) is not None else m["values"].get(k)) for k in reg_ids}
        lens(id_, label, group, "region", v, fmt, ramp, scale, m.get("note") or m.get("label", ""), m.get("source_name", ""), m.get("source_url", ""), m.get("year"))
        return True

    gdp = vals("gdp_2024_mad_million")
    for key, src, label, note in DERIVED:
        if gdp and vals(src):
            m = ind[src]
            ind[key] = {"label": label, "unit": "%", "year": m.get("year"), "source_name": m.get("source_name"), "source_url": m.get("source_url"),
                        "note": note, "national": round(m["national"] / ind["gdp_2024_mad_million"]["national"] * 100, 1),
                        "values": {k: round(m["values"][k] / gdp[k] * 100, 1) for k in reg_ids}}
    for lid, key, label, group, fmt, ramp, scale, mult, note in LENSES:
        if not have(key):
            continue
        m = ind[key]
        v = {k: (m["values"][k] * mult if m["values"].get(k) is not None else None) for k in reg_ids}
        if m.get("chart_only"):
            note += " Some regional values were read from a chart in the HCP note and are not repeated in its text."
        lens(lid, label, group, "region", v, fmt, ramp, scale, note.strip(), m.get("source_name", ""), m.get("source_url", ""), m.get("year"))

    # ---------------- yields (top bar)
    yields = [{"id": "population", "label": "Population", "icon": "pop", "color": "#e8dcc0", "value": nat_pop, "fmt": "compact",
               "definition": "Residents counted by the 2024 general census of population and housing (RGPH 2024), all 12 regions.",
               "source": "HCP, RGPH 2024", "sourceUrl": "https://www.hcp.ma/", "year": 2024, "level": "region",
               "values": {r["id"]: r["pop2024"] for r in reg_out}, "lens": "density"}]
    for yid, label, icon, color, key, fmt, mult, lens_id, definition in YIELDS:
        if key not in ind or ind[key].get("national") is None:
            continue
        m = ind[key]
        v = {k: (m["values"][k] * mult if m["values"].get(k) is not None else None) for k in reg_ids}
        grouped = None
        if m.get("south_grouped") is not None:
            grouped = {"value": m["south_grouped"] * mult, "regions": m.get("south_grouped_regions") or ["gon", "lsh", "dod"], "label": "Southern regions (published together)"}
        yields.append({"id": yid, "label": label, "icon": icon, "color": color, "value": m["national"] * mult, "fmt": fmt,
                       "definition": definition, "source": m.get("source_name", ""), "sourceUrl": m.get("source_url", ""),
                       "year": m.get("year"), "level": "region", "values": v, "lens": lens_id, "grouped": grouped})

    facts = []
    for key, label, fmt, mult in REGION_FACTS:
        if key not in ind:
            continue
        m = ind[key]
        g_ = m.get("south_grouped")
        facts.append({"key": key, "label": label, "fmt": fmt, "source": m.get("source_name", ""), "sourceUrl": m.get("source_url", ""),
                      "national": m["national"] * mult if m.get("national") is not None else None,
                      "values": {k: (m["values"][k] * mult if m["values"].get(k) is not None else None) for k in reg_ids},
                      "grouped": ({"value": g_ * mult, "regions": m.get("south_grouped_regions") or ["gon", "lsh", "dod"]} if g_ is not None else None)})
    sectors = None
    if all(k in ind for k in ("va_primary_2024_mad_million", "va_secondary_2024_mad_million", "va_tertiary_2024_mad_million", "net_taxes_on_products_2024_mad_million")):
        sectors = {k: [ind[x]["values"][k] * M for x in ("va_primary_2024_mad_million", "va_secondary_2024_mad_million",
                                                          "va_tertiary_2024_mad_million", "net_taxes_on_products_2024_mad_million")] for k in reg_ids}

    # ---------------- resources
    res_src = load("resources.json", {"items": []})
    resources, rids = [], set()
    for it in res_src["items"]:
        cell = place(it["lon"], it["lat"], None, reach=2)
        if cell is None:
            print("  resource outside the regions, skipped:", it["name"])
            continue
        rid = slug(f"{it['category']}-{it['name']}")
        while rid in rids:
            rid += "-2"
        rids.add(rid)
        resources.append({"id": rid, "cat": it["category"], "kind": it.get("kind"), "name": it["name"], "lat": it["lat"], "lon": it["lon"],
                          "cell": cell, "status": it.get("status"), "statLabel": it.get("stat_label"), "statValue": it.get("stat_value"),
                          "statUnit": it.get("stat_unit"), "statYear": it.get("stat_year"), "note": it.get("note"),
                          "approx": it.get("confidence") == "medium",
                          "url": it.get("source_url") or it.get("coord_source"),
                          "province": owner(it["lon"], it["lat"], cell)[0], "region": owner(it["lon"], it["lat"], cell)[1]})
    print("resources:", dict(Counter(r["cat"] for r in resources)))

    out = {
        "meta": {"generated": datetime.date.today().isoformat(), "turn": "2024", "turnLabel": "RGPH 2024 census",
                 "hexAreaKm2": round(HEX_AREA_KM2, 1)},
        "national": {"name": "Morocco", "pop2024": nat_pop, "pop2014": nat14, "capital": NATIONAL_CAPITAL,
                     "area_km2": sum(r["area_km2"] for r in reg_out)},
        "yields": yields, "lenses": lenses, "quickLenses": [q for q in QUICK if any(l["id"] == q for l in lenses)],
        "regions": reg_out, "provinces": prov_out, "cities": cities,
        "resources": resources, "resourceCats": RESOURCE_CATS, "facts": facts, "sectors": sectors,
        "sources": SOURCES_LIST,
    }
    (DATA / "places.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote places.json ({(DATA / 'places.json').stat().st_size / 1024:.0f} KB); lenses: {[l['id'] for l in lenses]}; yields: {[y['id'] for y in yields]}")


if __name__ == "__main__":
    main()
