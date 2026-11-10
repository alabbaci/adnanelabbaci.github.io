"""Words for each highlight, written from the numbers: title, summary, why it matters, evidence, captions.

Titles, evidence and explanations are generated from detected model fields and regional rules.
"""
from __future__ import annotations

import datetime as dt
import re
import unicodedata

import numpy as np

from .detect import Candidate, Item, _ij
from .fields import Forecast
from .geo import Geo, sea_name
from .scenes import LAYERS, Scene


def day(t: dt.datetime) -> str:
    return t.strftime("%a %d %b").replace(" 0", " ")


def when(t: dt.datetime) -> str:
    return f"{day(t)}, {t:%H} UTC"


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%MZ")


def span(t0: dt.datetime, t1: dt.datetime) -> str:
    """'on Tue 27 Oct' or 'between Tue 27 Oct and Fri 30 Oct'."""
    return f"on {day(t0)}" if day(t0) == day(t1) else f"between {day(t0)} and {day(t1)}"


def kmh(ms: float) -> int:
    return int(round(ms * 3.6))


def km2(a: float) -> str:
    if a >= 1e6:
        return f"{a / 1e6:.1f} million km²"
    return f"{int(round(a, -3)):,} km²"


def join(names: list[str]) -> str:
    names = [n for n in names if n]
    if len(names) <= 1:
        return names[0] if names else ""
    return ", ".join(names[:-1]) + " and " + names[-1]


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48]


def region_of(lat: float, lon: float) -> str:
    if lat >= 27 and lon < 12:
        return "maghreb"
    if lat >= 22 and lon >= 12:
        return "north-east"
    if lat >= 18:
        return "sahara"
    if lat >= 10 and lon < 38:
        return "sahel"
    if lat >= 4 and lon < 15:
        return "west-coast"
    if lat >= -12 and lon >= 38:
        return "horn-east"
    if lat >= -12 and lon >= 29:
        return "east"
    if lat >= -12:
        return "central"
    if lon >= 42:
        return "madagascar-swio"
    return "southern"


def season(t: dt.datetime) -> str:
    return {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
            6: "JJA", 7: "JJA", 8: "JJA"}.get(t.month, "SON")


# Why a highlight is interesting: (hazard, region, season), then (hazard, region), then (hazard,).
WHY = {
    ("heat", "southern", "SON"): "In much of southern Africa, October and November are the hottest months. The sun is high and the ground is still dry before the summer rains, so heat builds day after day until the first storms break it.",
    ("heat", "southern"): "Southern Africa's interior plateaus heat quickly under clear skies and dry ground. The Kalahari and the low-lying Zambezi and Limpopo valleys are usually the hotspots.",
    ("heat", "sahel", "SON"): "Across the Sahel the year has two hot peaks: the big one in April to June before the monsoon, and a smaller one in October once the rains have retreated and the ground dries out. This is that second peak.",
    ("heat", "sahel", "MAM"): "April to June is the Sahel's hottest time of year, just before the monsoon rains arrive. Nights stay very warm, which gives the body little chance to recover.",
    ("heat", "sahel"): "The Sahel sits between the Sahara and the wet tropics, so its heat rises and falls with the monsoon. Very warm nights are often as dangerous as hot afternoons.",
    ("heat", "sahara"): "The Sahara is one of the hottest places on Earth. What stands out here is how far the heat reaches beyond its usual season or towards populated areas.",
    ("heat", "maghreb"): "When winds blow from the Sahara (the chergui in Morocco, the sirocco further east), desert heat can reach coasts that are usually tempered by the sea.",
    ("heat", "north-east"): "Hot desert air flowing north towards the Mediterranean (the khamsin in Egypt, the ghibli in Libya) can send temperatures soaring on the coast.",
    ("heat",): "Heat is one of Africa's deadliest weather hazards, but it is under-reported because its toll shows up later in health records. Hot nights and long spells matter as much as the highest afternoon temperature.",
    ("humid-heat",): "When it is both hot and humid, sweat stops cooling the body well. A heat index above about 41 °C is considered dangerous even for healthy adults, especially with physical work outdoors.",
    ("rain", "horn-east", "SON"): "October to December is the 'short rains' season in East Africa. How strong it is depends a lot on Indian Ocean temperatures (the Indian Ocean Dipole), so heavy episodes often come in clusters.",
    ("rain", "east", "SON"): "October to December brings the 'short rains' to East Africa. Heavy falls on saturated or steep ground around the lakes and highlands can cause floods and landslides.",
    ("rain", "southern", "SON"): "The summer rains are just starting over southern Africa. The first heavy storms of the season fall on hard, dry ground, so runoff and flash flooding can be worse than the totals suggest.",
    ("rain", "southern"): "Southern Africa gets most of its rain from summer thunderstorms and from cut-off lows. Cut-off lows can sit over one area for days and bring some of the region's worst floods.",
    ("rain", "west-coast", "SON"): "Along the Gulf of Guinea coast, September to November brings the second rainy season of the year. Fast-growing coastal cities with limited drainage are especially prone to flash floods.",
    ("rain", "sahel", "JJA"): "July to September is the height of the West African monsoon. Squall lines sweep from east to west across the Sahel, often bringing a season's worth of rain in a few big storms.",
    ("rain", "maghreb"): "Most of North Africa's rain comes from Atlantic and Mediterranean storms in autumn and winter. On steep slopes and in dry wadis, even moderate rain can turn into flash floods.",
    ("rain", "north-east"): "Rain is rare along the north-east coast of Africa, so drainage is limited. When a Mediterranean storm does bring a downpour, flash floods can follow quickly, as in Libya's Storm Daniel in 2023.",
    ("rain", "sahara"): "Rain this heavy is unusual for such a dry region. Dry riverbeds can carry sudden floods, and the ground absorbs little water.",
    ("rain", "madagascar-swio"): "Madagascar's steep eastern slopes wring heavy rain out of moist air from the Indian Ocean, and floods and landslides follow quickly.",
    ("rain",): "Heavy rain is the weather hazard that affects the most people in Africa, through floods, landslides and disease. Fast-growing cities with limited drainage are especially exposed.",
    ("tropical-cyclone", "madagascar-swio"): "The south-west Indian Ocean cyclone season runs from November to April and peaks from January to March. Storms that reach Madagascar, the Mascarenes or the Mozambique Channel can bring destructive wind, surge and flooding rain.",
    ("tropical-cyclone", "horn-east"): "Cyclones in the western Arabian Sea and the Gulf of Aden are rare, but they can bring a year's rain in a day to Somalia, as Cyclone Gati did in November 2020.",
    ("tropical-cyclone",): "Tropical cyclones are Africa's most concentrated weather hazard. Wind does the most visible damage, but flooding rain and storm surge usually cause the most harm.",
    ("wind", "southern"): "Southern Africa's coasts lie close to the westerly storm track of the Southern Ocean. Cold fronts and strong pressure gradients can bring damaging gales, and they fan wildfires in the dry season.",
    ("wind",): "Strong winds bring down trees and power lines, lift dust and fan wildfires, and they can whip up dangerous seas for small boats.",
    ("dust", "sahel", "DJF"): "This is the Harmattan, the dry north-easterly wind that blows from the Sahara across West Africa in the dry season. It carries dust that hazes the sky, grounds flights and worsens breathing problems.",
    ("dust",): "The Sahara and the other African deserts are the largest source of mineral dust on Earth. Strong, gusty winds over dry ground can raise dust storms that cut visibility and affect health far downwind.",
    ("storms", "southern", "SON"): "Spring is the season for severe thunderstorms on South Africa's Highveld, where moist air and strong winds aloft combine to produce large hail.",
    ("storms",): "Thunderstorm energy (CAPE) shows how strongly air could rise in a storm. High values with a trigger such as a front or hills can mean intense downpours, hail, lightning and strong outflow winds.",
    ("waves", "southern"): "The coast of South Africa faces the Southern Ocean's storm track. Long-period swells made by storms far to the south-west can arrive with little local wind and surprise people on rocks and beaches.",
    ("waves", "maghreb"): "North Atlantic storms send long-period swells to the Atlantic coast of Morocco, where they can flood harbours and coastal roads.",
    ("waves",): "Big waves are a danger to fishing boats, ports and coastal communities, and they erode beaches. Long wave periods mean more energy reaching the shore.",
    ("snow", "maghreb"): "Snow in Africa sounds unusual, but the Atlas Mountains of Morocco and Algeria get it most winters. Heavy falls cut off mountain villages and close passes.",
    ("snow", "southern"): "The highlands of Lesotho and the Drakensberg get snow most winters, and occasionally a cold snap brings it down to lower ground in South Africa.",
    ("snow",): "Snow is rare in Africa, which makes it newsworthy when it falls, and it can strand travellers on unprepared mountain roads.",
}

TALK = {
    "heat": ["Why do warm nights make a heatwave more dangerous?",
             "How do the ensemble anomaly charts tell 'hot for the time of year' from simply 'hot'?",
             "Why does dry ground let temperatures climb higher?"],
    "humid-heat": ["Why is humid heat harder on the body than dry heat?",
                   "What is the difference between temperature, dew point and heat index?"],
    "rain": ["What lifts the moist air enough to make this much rain?",
             "Why can a forecast be confident about heavy rain but not about exactly where it falls?",
             "Why do cities flood more easily than the countryside?"],
    "tropical-cyclone": ["What makes a tropical low turn into a cyclone?",
                         "Why is flooding rain often deadlier than the wind?",
                         "How does the shape of a coast affect storm surge?"],
    "wind": ["What do tightly packed isobars tell you about the wind?",
             "Why are gusts so much stronger than the average wind?"],
    "dust": ["How much dust does the Sahara send across the Atlantic each year?",
             "Why can't this forecast show the dust itself?"],
    "storms": ["What is CAPE and why doesn't high CAPE always mean storms?",
               "Where do the triggers for these storms come from?"],
    "waves": ["Why can big swells arrive on a calm, sunny day?",
              "What does the wave period tell you about how dangerous waves are?"],
    "snow": ["How cold must it be for snow to settle on African mountains?",
             "How does the snow:water ratio change the depth of fresh snow?"],
}


def why(hazard: str, lat: float, lon: float, t: dt.datetime) -> str:
    reg = region_of(lat, lon)
    return WHY.get((hazard, reg, season(t))) or WHY.get((hazard, reg)) or WHY[(hazard,)]


def cyclone_label(vmax: float) -> str:
    if vmax >= 33:
        return "Tropical cyclone"
    if vmax >= 17:
        return "Tropical storm"
    return "Tropical low"


def mountains(countries: list[str]) -> str:
    if any(c in ("Morocco", "Algeria", "Tunisia") for c in countries):
        return "Atlas Mountains"
    if any(c in ("Lesotho", "South Africa") for c in countries):
        return "Lesotho highlands and the Drakensberg"
    if "Ethiopia" in countries:
        return "Ethiopian Highlands"
    return f"mountains of {join(countries[:1])}"


def _value_at(fc: Forecast, name: str, lat: float, lon: float, k0: int, k1: int) -> float:
    i, j = _ij(lat, lon)
    v = fc[name][k0:k1 + 1, i, j]
    return float(np.nanmax(v)) if np.isfinite(v).any() else float("nan")


def _where(item: Item, fc: Forecast, geo: Geo, n: int = 3) -> list[str]:
    p = item.primary
    weight = np.nan_to_num(np.nanmax(fc[_FIELD.get(p.hazard, "t2")], axis=0)) if p.hazard in _FIELD else None
    names = geo.countries_in(item.foot, weight, limit=n)
    home = geo.country_at(p.lat, p.lon)
    if home:
        names = [home] + [c for c in names if c != home]
    return names[:n]


_FIELD = {"heat": "tmax", "humid-heat": "hi", "rain": "rain24", "wind": "gust", "dust": "gust",
          "storms": "cape", "waves": "swh", "snow": "snow6"}


def describe(item: Item, fc: Forecast, geo: Geo, now: dt.datetime) -> dict:
    """Title, where/when, summary, why, evidence, talking points and confidence for one highlight."""
    p = item.primary
    times = fc.times
    t_peak, t0, t1 = times[p.k_peak], times[item.k0], times[item.k1]
    run_name = f"{fc.run.base:%H} UTC {day(fc.run.base)} run"
    countries = _where(item, fc, geo)
    place = geo.place_at(p.lat, p.lon)
    over_sea = not geo.land[_ij(p.lat, p.lon)]
    sea = sea_name(p.lat, p.lon)
    where_short = join(countries[:2]) or sea
    evidence: list[dict] = []
    info = p.info

    if p.hazard == "tropical-cyclone":
        track = info["track"]
        label = cyclone_label(info["vmax"])
        lf = info.get("landfall")
        first, last = track[0], track[-1]
        hours = max(fc.steps[last["k"]] - fc.steps[first["k"]], 6)
        from .geo import compass, km_between
        speed = km_between(first["lat"], first["lon"], last["lat"], last["lon"]) / hours
        heading = compass(first["lat"], first["lon"], last["lat"], last["lon"])
        title = f"{label} heads for {geo.place_at(lf['lat'], lf['lon'], short=True)}" if lf else \
            f"{label} over {sea_name(first['lat'], first['lon'])}"
        summary = (f"HRES has a {label.lower()} over {sea_name(first['lat'], first['lon'])} deepening to "
                   f"{p.peak:.0f} hPa by {when(t_peak)}, with sustained winds up to {info['vmax']:.0f} m/s "
                   f"({kmh(info['vmax'])} km/h) and gusts to {info['gust']:.0f} m/s. It tracks {heading} at about "
                   f"{speed:.0f} km/h.")
        if lf:
            summary += f" The centre reaches land {geo.place_at(lf['lat'], lf['lon'])} around {when(fc.times[lf['k']])}."
        summary += (f" Up to {info['rain24']:.0f} mm of rain in 24 h falls near the track. Model storms are "
                    f"often too weak at this resolution, so check the official advisories.")
        evidence += [
            {"kind": "field", "text": f"HRES low {first['p']:.0f} hPa near {_ll(first['lat'], first['lon'])} at "
                                      f"{when(fc.times[first['k']])}, deepest {p.peak:.0f} hPa near {_ll(p.lat, p.lon)} "
                                      f"at {when(t_peak)} ({run_name})"},
            {"kind": "field", "text": f"HRES 10 m wind up to {info['vmax']:.0f} m/s, gusts {info['gust']:.0f} m/s; "
                                      f"24 h rain up to {info['rain24']:.0f} mm near the track"},
        ]
        if info.get("p_rain50"):
            evidence.append({"kind": "ensemble", "text": f"ENS: up to {info['p_rain50']:.0f} % chance of more than "
                                                         f"50 mm in 24 h over land near the track"})
        if p.lon > 30 and p.lat < 0:
            evidence.append({"kind": "official", "text": "RSMC La Réunion (Météo-France), the official centre for "
                                                         "south-west Indian Ocean cyclones",
                             "url": "https://meteofrance.re/fr/cyclone"})
        confidence = "medium: HRES track and intensity; check official advisories before acting"

    elif p.hazard == "heat":
        pw = info.get("p_warm2", 0)
        days = (t1 - t0).total_seconds() / 86400
        title = ("Extreme heat" if p.peak >= 44 else "Unusual heat" if pw >= 60 else
                 "Prolonged heat" if days >= 4 else "Intense heat") + f" in {where_short}"
        summary = (f"HRES has afternoon highs up to {p.peak:.0f} °C {place} on {day(t_peak)}. ")
        if info.get("area40", 0) > 5000:
            summary += f"Temperatures of 40 °C or more cover about {km2(info['area40'])} "
        else:
            summary += "The heat covers "
            summary += f"about {km2(p.area_km2)} "
        summary += f"{span(t0, t1)}."
        if pw >= 30:
            summary += (f" Up to {pw:.0f} % of ensemble members put the air about 1.5 km up (850 hPa) more than two "
                        f"standard deviations warmer than normal for the time of year, so this is unusual heat, "
                        f"not just the hot season.")
        else:
            summary += " The ensemble does not flag the air aloft as unusually warm, so this is hot-season heat at its peak."
        evidence.append({"kind": "field", "text": f"HRES highest 3-hourly maximum {p.peak:.1f} °C near "
                                                  f"{_ll(p.lat, p.lon)} on {when(t_peak)} ({run_name})"})
        towns = geo.towns_in(item.foot, np.nanmax(fc["tmax"], axis=0), limit=4)
        if towns:
            vals = sorted(((_value_at(fc, "tmax", t["lat"], t["lon"], item.k0, item.k1), t["name"]) for t in towns), reverse=True)
            evidence.append({"kind": "field", "text": "HRES highs: " + ", ".join(f"{n} {v:.0f} °C" for v, n in vals)})
        if pw:
            evidence.append({"kind": "ensemble", "text": f"ENS: up to {pw:.0f} % chance that 850 hPa temperature is "
                                                         f"more than 2 SD above normal"})
        confidence = ("high: the ensemble strongly agrees the warmth is unusual" if pw >= 70 else
                      "medium: HRES heat with partial ensemble support" if pw >= 30 else
                      "medium: HRES heat; typical for the season according to the ensemble")

    elif p.hazard == "humid-heat":
        title = f"Oppressive humid heat in {where_short}"
        summary = (f"HRES has a heat index (how hot it feels) up to {p.peak:.0f} °C {place} on {when(t_peak)}: "
                   f"an air temperature of {info['t']:.0f} °C with a dew point of {info['td']:.0f} °C. "
                   f"Values above 41 °C are dangerous for outdoor work, and they stay high into the evening.")
        evidence.append({"kind": "field", "text": f"HRES heat index {p.peak:.1f} °C near {_ll(p.lat, p.lon)} at "
                                                  f"{when(t_peak)} ({run_name})"})
        confidence = "medium: HRES temperature and humidity; local sea breezes can change it"

    elif p.hazard == "rain":
        p50, p100 = info.get("p_rain50", 0), info.get("p_rain100", 0)
        reg = region_of(p.lat, p.lon)
        title = ("Very heavy rain" if p.peak >= 150 else "Unusual downpours" if reg in ("sahara", "north-east")
                 else "Heavy rain") + f" for {where_short}"
        summary = (f"HRES gives up to {p.peak:.0f} mm of rain in 24 h {place}, in the 24 hours to {when(t_peak)}. "
                   f"Heavy rain covers about {km2(p.area_km2)} {span(t0, t1)}.")
        if p50 >= 20:
            summary += f" Up to {p50:.0f} % of ensemble members give more than 50 mm in a day here"
            summary += f", and {p100:.0f} % more than 100 mm." if p100 >= 10 else "."
        summary += " Flash flooding is possible, especially in towns and on steep ground."
        evidence.append({"kind": "field", "text": f"HRES 24 h rain up to {p.peak:.0f} mm near {_ll(p.lat, p.lon)} "
                                                  f"ending {when(t_peak)} ({run_name})"})
        towns = geo.towns_in(item.foot, np.nanmax(np.nan_to_num(fc["rain24"]), axis=0), limit=3)
        if towns:
            vals = sorted(((_value_at(fc, "rain24", t["lat"], t["lon"], item.k0, item.k1), t["name"]) for t in towns), reverse=True)
            evidence.append({"kind": "field", "text": "HRES wettest 24 h: " + ", ".join(f"{n} {v:.0f} mm" for v, n in vals)})
        if p50:
            evidence.append({"kind": "ensemble", "text": f"ENS: {p50:.0f} % chance of more than 50 mm in 24 h"
                                                         + (f", {p100:.0f} % of more than 100 mm" if p100 else "")})
        confidence = ("high: ensemble and HRES agree on heavy rain" if p50 >= 70 else
                      "medium: HRES heavy rain with some ensemble support" if p50 >= 30 else
                      "low: an HRES signal the ensemble only partly supports")

    elif p.hazard == "wind":
        pg = info.get("p_gust25", 0)
        title = (f"Gales off {where_short}" if over_sea else f"Damaging gusts for {where_short}")
        summary = (f"HRES has gusts up to {p.peak:.0f} m/s ({kmh(p.peak)} km/h) {place} around {when(t_peak)}, "
                   f"with strong winds {span(t0, t1)}.")
        if pg >= 20:
            summary += f" Up to {pg:.0f} % of ensemble members have gusts above 25 m/s (90 km/h)."
        evidence.append({"kind": "field", "text": f"HRES gusts up to {p.peak:.0f} m/s near {_ll(p.lat, p.lon)} at "
                                                  f"{when(t_peak)} ({run_name})"})
        if pg:
            evidence.append({"kind": "ensemble", "text": f"ENS: {pg:.0f} % chance of gusts over 25 m/s"})
        confidence = ("high: ensemble and HRES agree" if pg >= 70 else
                      "medium: some ensemble support" if pg >= 30 else "low: mainly an HRES signal")

    elif p.hazard == "dust":
        u = float(np.nanmean(np.where(item.foot, fc["u10"][p.k_peak], np.nan)))
        v = float(np.nanmean(np.where(item.foot, fc["v10"][p.k_peak], np.nan)))
        harmattan = 5 <= p.lat <= 25 and fc.run.base.month in (11, 12, 1, 2, 3) and u < 0 and v < 0
        title = ("Harmattan winds over " if harmattan else "Dust-raising winds over ") + where_short
        summary = (f"HRES has winds of {info['wind10']:.0f} m/s with gusts to {p.peak:.0f} m/s ({kmh(p.peak)} km/h) "
                   f"{place} around {when(t_peak)}, blowing over very dry ground. Winds like this can lift dust and "
                   f"sand over about {km2(p.area_km2)} {span(t0, t1)}. ECMWF open data has no dust "
                   f"forecast, so this is about the wind, not the dust itself.")
        evidence.append({"kind": "field", "text": f"HRES gusts up to {p.peak:.0f} m/s, 10 m wind {info['wind10']:.0f} m/s, "
                                                  f"near {_ll(p.lat, p.lon)} at {when(t_peak)} ({run_name})"})
        evidence.append({"kind": "official", "text": "Copernicus (CAMS) dust forecasts",
                         "url": "https://atmosphere.copernicus.eu/charts/packages/cams/"})
        confidence = "low-medium: inferred from wind and dryness; no dust field in the open data"

    elif p.hazard == "storms":
        title = f"Severe thunderstorm risk for {where_short}"
        summary = (f"HRES has thunderstorm energy (MUCAPE) up to {p.peak:.0f} J/kg {place} around {when(t_peak)}, "
                   f"with up to {info['rain6']:.0f} mm of rain in 6 h. That is enough fuel for intense storms with "
                   f"hail, lightning and strong gusts where they form.")
        evidence.append({"kind": "field", "text": f"HRES MUCAPE {p.peak:.0f} J/kg near {_ll(p.lat, p.lon)} at "
                                                  f"{when(t_peak)} ({run_name})"})
        confidence = "medium: high storm energy in HRES; individual storms are hit and miss"

    elif p.hazard == "waves":
        title = f"Big swells for the coast of {join(countries[:2]) or sea}"
        summary = (f"The ECMWF wave model has significant wave heights up to {p.peak:.1f} m {place} around "
                   f"{when(t_peak)}")
        summary += f", with peak periods near {info['period']:.0f} s." if info.get("period") else "."
        summary += " Individual waves can be nearly twice the significant height."
        evidence.append({"kind": "field", "text": f"Wave model significant height {p.peak:.1f} m near "
                                                  f"{_ll(p.lat, p.lon)} at {when(t_peak)} ({run_name})"})
        confidence = "medium-high: ECMWF wave model"

    else:  # snow
        title = f"Snow for the {mountains(countries)}"
        summary = (f"HRES has up to {p.peak:.0f} cm of fresh snow (at a 10:1 snow-to-water ratio) {place} by "
                   f"{when(t_peak)}. Mountain roads and passes may be affected.")
        evidence.append({"kind": "field", "text": f"HRES snowfall {p.peak:.0f} cm (water equivalent "
                                                  f"{p.peak:.0f} mm) near {_ll(p.lat, p.lon)} ({run_name})"})
        confidence = "medium: HRES snowfall; depth depends on temperature and terrain"

    for other in item.others:
        if other.hazard != p.hazard:
            evidence.append({"kind": "field", "text": _secondary(other, fc, geo)})

    return {
        "title": title,
        "where": {"label": join(countries) or sea, "centre": [round(p.lat, 2), round(p.lon, 2)]},
        "when": {"start": iso(t0), "peak": iso(t_peak), "end": iso(t1)},
        "status": "ongoing" if t0 <= now else "forecast",
        "summary": summary,
        "why_interesting": why(p.hazard, p.lat, p.lon, t_peak),
        "evidence": evidence,
        "talking_points": TALK[p.hazard][:3],
        "confidence": confidence,
    }


def _ll(lat: float, lon: float) -> str:
    return f"{abs(lat):.1f}{'N' if lat >= 0 else 'S'} {abs(lon):.1f}{'E' if lon >= 0 else 'W'}"


def _secondary(c: Candidate, fc: Forecast, geo: Geo) -> str:
    t = when(fc.times[c.k_peak])
    near = geo.place_at(c.lat, c.lon)
    return {
        "rain": f"Also heavy rain: up to {c.peak:.0f} mm in 24 h {near} ({t})",
        "wind": f"Also strong gusts: up to {c.peak:.0f} m/s ({kmh(c.peak)} km/h) {near} ({t})",
        "waves": f"Also big waves: up to {c.peak:.1f} m {near} ({t})",
        "storms": f"Also thunderstorm energy up to {c.peak:.0f} J/kg {near} ({t})",
        "dust": f"Also dust-raising winds, gusts to {c.peak:.0f} m/s {near} ({t})",
        "heat": f"Also heat: highs up to {c.peak:.0f} °C {near} ({t})",
        "humid-heat": f"Also humid heat: heat index up to {c.peak:.0f} °C {near} ({t})",
        "snow": f"Also snow: up to {c.peak:.0f} cm {near} ({t})",
        "tropical-cyclone": f"Also a tropical low, {c.peak:.0f} hPa {near} ({t})",
    }[c.hazard]


SCENE_TITLES = {
    "tmax": "Afternoon heat", "t2": "Hot days, warm nights", "ens_warm2": "Ensemble: how unusual is the warmth?",
    "hi": "How hot it feels", "td2": "Humid air and dry air", "rain6": "Where the rain falls",
    "rain24": "24-hour rain totals", "tcwv": "Moisture feeding the rain",
    "ens_rain50": "Ensemble: chance of more than 50 mm in a day", "ens_rain100": "Ensemble: chance of more than 100 mm",
    "gust": "Strongest gusts", "wind10": "The wind flow", "ens_gust25": "Ensemble: chance of damaging gusts",
    "cape": "Thunderstorm fuel", "swh": "Wave heights", "snow6": "Fresh snow",
}
SCENE_OVERRIDES = {
    ("dust", "wind10"): "Dust-raising winds", ("dust", "td2"): "Bone-dry desert air",
    ("tropical-cyclone", "tcwv"): "The storm and its moisture", ("tropical-cyclone", "gust"): "Winds around the centre",
    ("tropical-cyclone", "rain6"): "Rain along the track", ("waves", "wind10"): "The winds that raise the sea",
    ("snow", "t2"): "Cold air", ("storms", "rain6"): "Storm rain",
}


def scene_text(item: Item, scene: Scene, fc: Forecast, geo: Geo) -> None:
    """Title, captions and labelled places for one scene."""
    p = item.primary
    scene.title = SCENE_OVERRIDES.get((p.hazard, scene.fill), SCENE_TITLES[scene.fill])
    frames = [fc.run.valid(s) for s in scene.frames]

    def at(k: int) -> str:
        t = fc.times[min(max(k, 0), len(fc.times) - 1)]
        return iso(min(frames, key=lambda f: abs((f - t).total_seconds())))

    place = geo.place_at(p.lat, p.lon, short=True)
    caps: list[tuple[str, str]] = []
    first = iso(frames[0])
    unit = {"heat": "°C", "humid-heat": "°C", "rain": "mm in 24 h", "wind": "m/s", "dust": "m/s",
            "storms": "J/kg", "waves": "m", "snow": "cm", "tropical-cyclone": "hPa"}[p.hazard]
    peak_txt = f"{p.peak:.0f} {unit}" if p.hazard != "waves" else f"{p.peak:.1f} m"

    if scene.fill.startswith("ens_"):
        name = LAYERS[scene.fill]["source"][1]
        if scene.windows:
            best = max(scene.windows, key=lambda w: float(np.nanmax(np.where(item.foot, fc.ens[name][w], 0))))
            pmax = float(np.nanmax(np.where(item.foot, fc.ens[name][best], 0)))
            caps += [(first, "Each frame is the 24 hours ending at the time shown"),
                     (iso(fc.run.valid(best[1])), f"Highest: {pmax:.0f} % of 51 members")]
        else:
            best = max(scene.frames, key=lambda s: float(np.nanmax(np.where(item.foot, fc.warm[name][s], 0))))
            pmax = float(np.nanmax(np.where(item.foot, fc.warm[name][best], 0)))
            caps += [(first, "Chance that the air 1.5 km up is far warmer than normal"),
                     (iso(fc.run.valid(best)), f"Up to {pmax:.0f} % of members")]
    elif p.hazard == "tropical-cyclone":
        track = p.info["track"]
        caps += [(at(track[0]["k"]), f"{cyclone_label(track[0]['vmax'])} forms, {track[0]['p']:.0f} hPa"),
                 (at(p.k_peak), f"Deepest in HRES: {p.peak:.0f} hPa")]
        lf = p.info.get("landfall")
        if lf:
            caps.append((at(lf["k"]), f"Centre over land near {geo.place_at(lf['lat'], lf['lon'], short=True)}"))
    else:
        intro = {
            "tmax": "Each frame shows the highest temperature in the past 6 hours",
            "t2": "Watch the daily swing between hot afternoons and warm nights",
            "hi": "Heat index combines temperature and humidity",
            "td2": "Green and blue: humid air. Brown: very dry air",
            "rain6": "Rain in 6-hour steps; isobars every 4 hPa",
            "tcwv": "Purple and red: deep moisture that can fuel heavy rain",
            "gust": "Strongest gust in each 6-hour period",
            "wind10": "Moving streaks follow the 10 m wind",
            "cape": "High values (purple) mean fuel for strong storms",
            "swh": "Significant wave height: the average of the highest third of waves",
            "snow6": "Fresh snow in each 6-hour period (10:1 ratio)",
        }.get(scene.fill)
        if intro:
            caps.append((first, intro))
        if scene.fill == _FIELD.get(p.hazard) or (scene.fill, p.hazard) in (("rain6", "rain"), ("wind10", "dust"),
                                                                            ("tmax", "heat")):
            caps.append((at(p.k_peak), f"Peak: {peak_txt}, {place}" if place.startswith("about") else
                         f"Peak near {place}: {peak_txt}"))
        if item.k1 < len(fc.steps) - 3 and scene.fill in ("tmax", "rain6", "gust", "wind10", "swh", "hi"):
            caps.append((at(item.k1 + 1), "Easing"))

    seen, out = set(), []
    for t, text in sorted(caps, key=lambda c: c[0]):
        if t not in seen:
            seen.add(t)
            out.append({"at": t, "text": text})
    scene.captions = out

    values = None
    if p.hazard in _FIELD:
        values = np.nan_to_num(np.nanmax(fc[_FIELD[p.hazard]], axis=0))
    towns = geo.towns_in(item.foot, values, limit=3, min_pop=40000)
    focus = [{"lat": t["lat"], "lon": t["lon"], "label": t["name"]} for t in towns]
    lf = p.info.get("landfall") if p.hazard == "tropical-cyclone" else None
    if lf:
        focus.insert(0, {"lat": round(lf["lat"], 2), "lon": round(lf["lon"], 2),
                         "label": geo.place_at(lf["lat"], lf["lon"], short=True).split(" of ")[-1]})
    w, s, e, n = scene.bbox
    focus = [f for f in focus if w <= f["lon"] <= e and s <= f["lat"] <= n]
    if not focus:
        near = geo.nearest_place(p.lat, p.lon)
        if w <= near["lon"] <= e and s <= near["lat"] <= n:
            focus = [{"lat": near["lat"], "lon": near["lon"], "label": near["name"]}]
    scene.focus = focus[:3]


def item_id(fc: Forecast, item: Item, geo: Geo) -> str:
    p = item.primary
    name = geo.place_at(p.lat, p.lon, short=True).split(" of ")[-1]
    return f"{fc.run.base:%Y-%m-%d}-{p.hazard}-{slug(name)}"
