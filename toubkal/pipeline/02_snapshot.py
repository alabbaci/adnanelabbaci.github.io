"""
02_snapshot.py

Saves one week of the live feeds as toubkal/data/snapshot.json. The page
reads Open-Meteo straight from the visitor's browser; the snapshot is only
what it falls back to when that request fails (offline, blocked, rate
limited), so that the scene still plays a real week instead of nothing.

    python 02_snapshot.py                       # last 7 full days, fetched now
    python 02_snapshot.py 2026-11-08 2026-11-14
    python 02_snapshot.py 2026-11-08 2026-11-14 --print-urls
    python 02_snapshot.py 2026-11-08 2026-11-14 --weather w.json --flood f.json

--print-urls shows the two requests instead of sending them; --weather and
--flood build the snapshot from responses saved by other means (useful where
this machine cannot reach open-meteo.com itself).

The requests are the same ones app.js sends, built from scene.json.
Standard library only.
"""

import argparse
import datetime as dt
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
HOURLY = ("temperature_2m,precipitation,snowfall,snow_depth,cloud_cover,wind_speed_10m,wind_direction_10m,"
          "freezing_level_height,wind_speed_700hPa,wind_direction_700hPa,wind_speed_600hPa,wind_direction_600hPa")
FLOOD_HISTORY_DAYS = 90      # the gauge level is read against the median of this many days


def urls(scene, d0, d1):
    pts, gauges = scene["points"], scene["gauges"]
    day = dt.timedelta(days=1)
    weather = ("https://api.open-meteo.com/v1/forecast"
               f"?latitude={','.join(str(p['lat']) for p in pts)}"
               f"&longitude={','.join(str(p['lon']) for p in pts)}"
               f"&elevation={','.join(str(p['elev']) for p in pts)}"
               f"&hourly={HOURLY}&wind_speed_unit=ms&timezone=GMT"
               f"&start_date={d0 - day}&end_date={d1}")
    flood = ("https://flood-api.open-meteo.com/v1/flood"
             f"?latitude={','.join(str(g['cell'][0]) for g in gauges)}"
             f"&longitude={','.join(str(g['cell'][1]) for g in gauges)}"
             f"&daily=river_discharge&start_date={d0 - FLOOD_HISTORY_DAYS * day}&end_date={d1 + day}")
    return weather, flood


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "toubkal-dashboard-snapshot"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("start", nargs="?")
    ap.add_argument("end", nargs="?")
    ap.add_argument("--print-urls", action="store_true")
    ap.add_argument("--weather")
    ap.add_argument("--flood")
    a = ap.parse_args()
    today = dt.datetime.now(dt.timezone.utc).date()
    d1 = dt.date.fromisoformat(a.end) if a.end else today - dt.timedelta(days=1)
    d0 = dt.date.fromisoformat(a.start) if a.start else d1 - dt.timedelta(days=6)
    scene = json.load(open(os.path.join(DATA, "scene.json"), encoding="utf-8"))
    wurl, furl = urls(scene, d0, d1)
    if a.print_urls:
        print(wurl, furl, sep="\n")
        return
    weather = json.load(open(a.weather, encoding="utf-8")) if a.weather else get(wurl)
    flood = json.load(open(a.flood, encoding="utf-8")) if a.flood else get(furl)
    if len(weather) != len(scene["points"]) or len(flood) != len(scene["gauges"]):
        raise SystemExit("response does not match the points in scene.json")
    keep = str(d0 - FLOOD_HISTORY_DAYS * dt.timedelta(days=1))
    for f in flood:                      # a longer saved response is cut back to the window the page uses
        i = next((k for k, t in enumerate(f["daily"]["time"]) if t >= keep), 0)
        f["daily"] = {k: v[i:] for k, v in f["daily"].items()}
    snap = {
        "from": str(d0), "to": str(d1),
        "fetched": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "weather": [{"hourly": w["hourly"]} for w in weather],
        "flood": [{"daily": f["daily"]} for f in flood],
    }
    path = os.path.join(DATA, "snapshot.json")
    json.dump(snap, open(path, "w", encoding="utf-8"), separators=(",", ":"))
    print(f"wrote snapshot.json, {d0} to {d1}, {os.path.getsize(path) / 1024:.0f} kB")


if __name__ == "__main__":
    main()
