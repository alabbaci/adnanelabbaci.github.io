"""The standing explainer: Africa's rain belt and the big picture for the coming week."""
from __future__ import annotations

import numpy as np

from .fetch import LATS, LONS
from .fields import Forecast
from .geo import Geo
from .scenes import Scene
from .text import day, iso, join, km2, season

# Mainland Africa and Madagascar, at half resolution to keep the files small.
BBOX = (-20.0, -36.0, 54.0, 38.0)
STRIDE = 2

WHY = {
    "SON": "In October and November the tropical rain belt follows the sun south. The rains are ending in the Sahel and Sudan, the 'short rains' are starting in East Africa, and the first summer storms are reaching southern Africa.",
    "DJF": "From December to February the rain belt is furthest south, bringing the main wet season to southern Africa and Madagascar. West Africa and the Sahel are dry, and the Harmattan blows dust towards the Gulf of Guinea.",
    "MAM": "From March to May the rain belt moves back north. East Africa's 'long rains' fall, the rains return to the Gulf of Guinea coast, and southern Africa starts to dry out.",
    "JJA": "From June to September the West African monsoon reaches its furthest north, bringing the Sahel its only rains of the year. The Ethiopian Highlands get the rains that feed the Nile, while southern Africa has its dry winter.",
}


def _deg(lat: float) -> str:
    return f"{abs(lat):.0f}°{'N' if lat >= 0 else 'S'}"


def build(fc: Forecast, geo: Geo) -> tuple[dict, list[Scene]]:
    total = np.nansum(fc["rain6"][1:], axis=0)
    wet = geo.african_land & (total >= 25)
    t0, t1 = fc.times[0], fc.times[-1]
    lat2d = LATS[:, None] * np.ones_like(total)
    if wet.any():
        lats = lat2d[wet]
        w = total[wet]
        order = np.argsort(lats)
        cum = np.cumsum(w[order]) / w.sum()
        south, north = lats[order][np.searchsorted(cum, 0.1)], lats[order][min(np.searchsorted(cum, 0.9), len(lats) - 1)]
        i, j = np.unravel_index(np.argmax(np.where(geo.african_land, total, -1)), total.shape)
        wettest = geo.place_at(float(LATS[i]), float(LONS[j]))
        countries = geo.countries_in(geo.african_land & (total >= 50), total, limit=4)
        summary = (f"Over the next six days ({day(t0)} to {day(t1)}), most of Africa's rain falls between about "
                   f"{_deg(south)} and {_deg(north)}. The wettest spot in HRES is {wettest}, with about "
                   f"{total[i, j]:.0f} mm in total.")
        if countries:
            summary += f" The largest areas with more than 50 mm are in {join(countries)}."
        summary += f" Rain of 25 mm or more covers about {km2(float(geo.area[wet].sum()))} of land."
    else:
        summary = f"Africa stays mostly dry from {day(t0)} to {day(t1)} in HRES."
    item = {
        "kind": "explainer",
        "title": "Africa's rain belt this week",
        "hazards": ["explainer"],
        "where": {"label": "Africa", "centre": [1.0, 17.0]},
        "when": {"start": iso(t0), "peak": iso(fc.times[len(fc.times) // 2]), "end": iso(t1)},
        "status": "forecast",
        "summary": summary,
        "why_interesting": WHY[season(t0)],
        "evidence": [{"kind": "field", "text": f"HRES total rain {day(t0)} to {day(t1)}; 25 mm or more over "
                                               f"{km2(float(geo.area[wet].sum()))} of African land"}],
        "talking_points": ["What is the tropical rain belt (the ITCZ), and why does it follow the sun?",
                           "Why do some places get two rainy seasons a year and others only one?",
                           "Where does the moisture for Africa's rain come from?"],
        "confidence": "high for the broad pattern; individual storms are less certain",
    }
    first = iso(t0)
    scenes = [
        Scene("rain6", True, False, BBOX, fc.steps[1:], title="The rain belt in 6-hour steps",
              captions=[{"at": iso(fc.times[1]), "text": "Rain falls in a broad belt that follows the sun"},
                        {"at": iso(fc.times[len(fc.times) // 2]), "text": "Afternoon storms flare up over land each day"}]),
        Scene("tcwv", True, True, BBOX, fc.steps, title="Moist tropical air and dry desert air",
              captions=[{"at": first, "text": "Purple and red: deep moisture. Grey and green: dry air"}]),
        Scene("t2", False, False, BBOX, fc.steps, title="Day and night across the continent",
              captions=[{"at": first, "text": "Watch the deserts heat up by day and cool at night"}]),
    ]
    for s in scenes:
        s.stride = STRIDE
    return item, scenes
