"""Run one sweep: newest ECMWF run -> highlights -> site/data/feed.json and scene files.

    uv run python -m sweep                 # newest run; exit code 3 if it is already published
    uv run python -m sweep --force         # rebuild even if published
    uv run python -m sweep --run 20261026T00Z
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import shutil
import sys
from pathlib import Path

from . import config, detect, fetch, fields, overview, scenes, text
from .geo import Geo

log = logging.getLogger("sweep")
ROOT = Path(__file__).resolve().parents[1]


def scene_json(sc: scenes.Scene) -> dict:
    out = {"title": sc.title, **sc.meta, "isobars": sc.isobars, "particles": sc.particles,
           "bbox": list(sc.bbox), "captions": sc.captions, "focus": sc.focus,
           "package": sc.package, "bytes": sc.nbytes}
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sweep", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT / "site" / "data")
    ap.add_argument("--cache", type=Path, default=ROOT / ".cache")
    ap.add_argument("--run", help="a specific run, e.g. 20261026T00Z")
    ap.add_argument("--force", action="store_true", help="rebuild even if this run is already published")
    ap.add_argument("--no-ai", action="store_true", help="compatibility flag; text is generated from forecast rules")
    ap.add_argument("--keep-runs", type=int, default=4, help="scene folders of older runs to keep for shared links")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")

    if args.run:
        base = dt.datetime.strptime(args.run, "%Y%m%dT%HZ")
        run = fetch.Run(base, config.SOURCES[0])
    else:
        run = fetch.latest_run()
    feed_path = args.out / "feed.json"
    if feed_path.exists() and not args.force:
        old = json.loads(feed_path.read_text(encoding="utf-8"))
        if old.get("run") == run.tag:
            log.info("run %s is already published; nothing to do", run.tag)
            return 3
    log.info("sweeping run %s", run.tag)

    fc = fields.load(run, args.cache / run.tag)
    geo = Geo(fc.lsm)
    found = detect.find(fc, geo)
    log.info("%d highlights: %s", len(found), ", ".join(f"{it.primary.hazard}" for it in found))

    pkg_root = args.out / "p" / run.tag
    if pkg_root.exists():
        shutil.rmtree(pkg_root)
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    items, ids = [], set()
    for item in found:
        d = text.describe(item, fc, geo, now)
        base_id = text.item_id(fc, item, geo)
        iid, n = base_id, 2
        while iid in ids:
            iid, n = f"{base_id}-{n}", n + 1
        ids.add(iid)
        planned = scenes.plan(fc, item)
        for k, sc in enumerate(planned):
            text.scene_text(item, sc, fc, geo)
            scenes.write(fc, sc, pkg_root / f"{iid}-{k}", f"p/{run.tag}/{iid}-{k}")
        if item.primary.hazard == "tropical-cyclone":
            track = [[round(q["lat"], 2), round(q["lon"], 2), text.iso(fc.times[q["k"]]), round(q["p"])]
                     for q in item.primary.info["track"]]
            for sc in planned:
                sc.meta["track"] = track
        d.update(id=iid, kind="event", hazards=item.hazards, score=round(item.score, 2),
                 scenes=[scene_json(sc) for sc in planned])
        d["where"]["bbox"] = list(planned[0].bbox)
        items.append(d)

    ex, ex_scenes = overview.build(fc, geo)
    ex["id"] = f"{run.base:%Y-%m-%d}-rain-belt"
    for k, sc in enumerate(ex_scenes):
        scenes.write(fc, sc, pkg_root / f"{ex['id']}-{k}", f"p/{run.tag}/{ex['id']}-{k}")
    ex["scenes"] = [scene_json(sc) for sc in ex_scenes]
    ex["where"]["bbox"] = list(overview.BBOX)
    items.append(ex)

    written_by = "rules"
    for rank, it in enumerate(items, 1):
        it["rank"] = rank
    feed = {
        "generated_utc": text.iso(now),
        "run": run.tag,
        "run_time": text.iso(run.base),
        "written_by": written_by,
        "attribution": config.ATTRIBUTION,
        "domain": [config.WEST, config.SOUTH, config.EAST, config.NORTH],
        "items": items,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    tmp = feed_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(feed, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(feed_path)
    (args.out / "archive").mkdir(exist_ok=True)
    shutil.copy(feed_path, args.out / "archive" / f"feed-{run.tag}.json")

    runs = sorted(p.name for p in (args.out / "p").iterdir() if p.is_dir())
    for old in runs[:-args.keep_runs]:
        shutil.rmtree(args.out / "p" / old)
        (args.out / "archive" / f"feed-{old}.json").unlink(missing_ok=True)
    total = sum(f.stat().st_size for f in pkg_root.rglob("*") if f.is_file())
    log.info("published %d items for %s (%.1f MB of scenes)", len(items), run.tag, total / 1e6)
    return 0


if __name__ == "__main__":
    sys.exit(main())
