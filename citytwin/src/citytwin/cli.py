"""Command line interface: ``citytwin <command>``.

Each command is a thin wrapper over a library function, so the same behaviour is
available from a notebook, from CI or from the container. Nothing in here holds
state that cannot be rebuilt from ``data/`` and ``configs/``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config import BUILD_DIR, DEFAULT_AOI, WEB_DIR, aoi_from_slug
from .exporters.charts import benchmark_chart
from .exporters.cityjson import buildings_to_cityjson, validate_cityjson
from .exporters.tiles3d import buildings_to_3dtiles, validate_glb
from .ingest.overture import fetch_overture, parse_overture, raw_paths, write_layers
from .pipeline import run_pipeline
from .provenance import Provenance


def _fmt(value: object) -> str:
    return f"{value}" if not isinstance(value, float) else f"{value:.2f}"


def cmd_build(args: argparse.Namespace) -> int:
    result = run_pipeline(
        args.aoi,
        refresh=args.refresh,
        n_draws=args.draws,
        n_sensitivity=args.sensitivity,
        run_benchmark=not args.no_benchmark,
    )
    metrics = result.metrics
    counts = metrics["data"].get("counts", {})
    print(f"study area        {result.aoi_name}")
    print(
        f"buildings         {counts.get('buildings', 'n/a')} ({counts.get('buildings_with_height', 0)} labelled)"
    )
    print(f"grid cells        {metrics['exposure']['cells']} ({metrics['exposure']['area_ha']} ha)")
    print(
        f"mean exposure     {metrics['exposure']['mean_hei']} (hotspot threshold {metrics['exposure']['hotspot_threshold']})"
    )
    print(
        f"height strategy   {metrics['height']['strategy']}  MAE {metrics['height']['metrics']['mae']} m"
    )
    benchmark = metrics["height"].get("benchmark")
    if benchmark:
        print(
            f"height benchmark  model MAE {benchmark['model']['mae']} m vs rule "
            f"{benchmark['rule']['mae']} m → {benchmark['decision']} shipped"
        )
    print(
        f"cityjson          {metrics['artefacts']['cityjson_buildings']} buildings, "
        f"{metrics['artefacts']['cityjson_open_shells']} open shells"
    )
    print(
        f"3d tiles          {metrics['artefacts']['glb_triangles']} triangles, "
        f"{metrics['artefacts']['glb_bytes'] / 1e6:.2f} MB"
    )
    print(f"viewer            {result.paths['viewer'].relative_to(BUILD_DIR.parent)}")
    print(f"provenance        {result.paths['provenance'].relative_to(BUILD_DIR.parent)}")
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    aoi = aoi_from_slug(args.aoi)
    paths = fetch_overture(aoi, refresh=args.refresh)
    layers = parse_overture(paths, aoi)
    write_layers(layers, Path("data") / "processed")
    print(f"Overture release {layers.metadata['release']}")
    for name in ("buildings", "green", "trees", "streets"):
        print(f"  {name:<9} {len(getattr(layers, name))}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("citytwin.api.main:app", host=args.host, port=args.port, reload=args.reload)
    return 0


def cmd_agent(args: argparse.Namespace) -> int:
    from .agent import run

    result = run(args.question, write_trace=args.trace)
    print(result.answer)
    print()
    print(
        f"plan: {result.plan.planner} — "
        + "; ".join(f"{step.tool}({json.dumps(step.args)})" for step in result.plan.steps)
    )
    for record in result.steps:
        print(f"  {record.tool:<20} {record.seconds:6.2f} s  result {record.result_hash}")
    for record in result.steps:
        for item in record.evidence:
            print(f"  evidence: {item}")
    if result.trace_path:
        print(f"trace: {result.trace_path}")
    return 0


def cmd_mcp(args: argparse.Namespace) -> int:
    from .agent.mcp_server import serve

    serve()
    return 0


def cmd_eval(args: argparse.Namespace) -> int:
    from .agent.eval import evaluate, write_report

    result = evaluate()
    report = write_report(result)
    summary = result["summary"]
    print(f"tasks              {summary['tasks']}")
    print(f"routing accuracy   {summary['routing_accuracy']:.0%}")
    print(f"grounded pass rate {summary['grounded_pass_rate']:.0%}")
    print(f"mean steps         {summary['mean_steps']}")
    print(f"report             {report}")
    failed = [row for row in result["rows"] if not (row["routed"] and row["grounded"])]
    for row in failed:
        print(
            f"  FAIL {row['id']}: called {row['called']} expected {row['expected']} {row['error'] or ''}"
        )
    return 0 if not failed else 1


def cmd_verify(args: argparse.Namespace) -> int:
    problems: list[str] = []
    provenance = BUILD_DIR / "provenance.json"
    if provenance.exists():
        problems.extend(Provenance.verify(provenance))
        document = json.loads(provenance.read_text(encoding="utf-8"))
        print(
            f"provenance   {len(document.get('entity', {}))} entities, "
            f"{len(document.get('activity', {}))} activities"
        )
    else:
        problems.append("no provenance record")

    cityjson = BUILD_DIR / "cityjson" / f"{DEFAULT_AOI.slug}_lod1.city.json"
    if cityjson.exists():
        validation = validate_cityjson(cityjson)
        print(
            f"cityjson     {validation['buildings']} buildings, {validation['open_shells']} open shells, "
            f"ok={validation['ok']}"
        )
        if validation["open_shells"]:
            problems.extend(validation["problems"][:5])
    else:
        problems.append("no CityJSON export")

    glb = BUILD_DIR / "3dtiles" / "buildings.glb"
    if glb.exists():
        validation = validate_glb(glb)
        print(
            f"3d tiles     {validation['vertices']} vertices, {validation['triangles']} triangles, "
            f"ok={validation['ok']}"
        )
        problems.extend(validation["problems"][:5])
    else:
        problems.append("no 3D Tiles export")

    if problems:
        print("\nproblems:")
        for problem in problems[:10]:
            print(f"  - {problem}")
        return 1
    print("\nall checks passed")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    """Re-export CityJSON, 3D Tiles and the viewer from processed layers."""
    import geopandas as gpd

    processed = Path("data") / "processed"
    buildings = gpd.read_file(processed / "buildings_enriched.geojson")
    cells = gpd.read_file(processed / "cells.geojson").to_crs(buildings.crs)
    green_path = processed / "green.geojson"
    green = gpd.read_file(green_path) if green_path.exists() else None
    streets_path = processed / "streets.geojson"
    streets = gpd.read_file(streets_path) if streets_path.exists() else None

    from .exporters.viewer import build_viewer

    cityjson = buildings_to_cityjson(
        buildings,
        BUILD_DIR / "cityjson" / f"{DEFAULT_AOI.slug}_lod1.city.json",
        aoi_name=DEFAULT_AOI.name,
    )
    print(f"cityjson     {cityjson}")
    tiles = buildings_to_3dtiles(buildings, BUILD_DIR / "3dtiles")
    print(f"3d tiles     {tiles['content']}")
    viewer = build_viewer(
        buildings,
        cells,
        green,
        streets,
        out_path=WEB_DIR / "index.html",
        meta={"strategy": "rule", "labelled": int(buildings["has_height_label"].sum())},
    )
    print(f"viewer       {viewer}")
    return 0


def cmd_benchmark(args: argparse.Namespace) -> int:
    from .features import build_features
    from .ingest.overture import parse_overture
    from .model import benchmark_heights, write_model_card

    layers = parse_overture(raw_paths(aoi_from_slug(args.aoi)), aoi_from_slug(args.aoi))
    features = build_features(layers)
    benchmark = benchmark_heights(features.buildings)
    here = Path(__file__).resolve().parents[2]
    write_model_card(benchmark, here / "docs" / "model_card.md", aoi_from_slug(args.aoi).name)
    benchmark_chart(benchmark, here / "docs" / "assets" / "height_benchmark.svg")
    print(json.dumps({k: benchmark[k] for k in ("decision", "delta_mae_m")}, indent=2))
    print(f"rule  MAE {benchmark['rule']['metrics']['mae']} m")
    print(f"model MAE {benchmark['model']['metrics']['mae']} m")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="citytwin", description="Geospatial digital twin toolkit")
    parser.add_argument("--version", action="version", version=f"citytwin {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build", help="run the full pipeline and write all artefacts")
    build.add_argument("--aoi", default=None, help="study area slug (default: dakhla)")
    build.add_argument("--refresh", action="store_true", help="re-download the Overture extract")
    build.add_argument("--draws", type=int, default=200, help="Monte Carlo draws for uncertainty")
    build.add_argument(
        "--sensitivity", type=int, default=500, help="samples for weight sensitivity"
    )
    build.add_argument(
        "--no-benchmark", action="store_true", help="skip the learned-height benchmark"
    )
    build.set_defaults(function=cmd_build)

    fetch = subparsers.add_parser("fetch", help="download and normalise the Overture extract only")
    fetch.add_argument("--aoi", default=None)
    fetch.add_argument("--refresh", action="store_true")
    fetch.set_defaults(function=cmd_fetch)

    serve = subparsers.add_parser("serve", help="serve the OGC API (FastAPI)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--reload", action="store_true")
    serve.set_defaults(function=cmd_serve)

    agent = subparsers.add_parser("agent", help="answer one question through the tool-using agent")
    agent.add_argument("question")
    agent.add_argument("--trace", action="store_true", help="write a JSON trace of the run")
    agent.set_defaults(function=cmd_agent)

    mcp = subparsers.add_parser("mcp", help="run the MCP server on stdio")
    mcp.set_defaults(function=cmd_mcp)

    ev = subparsers.add_parser("eval", help="run the golden-question evaluation")
    ev.set_defaults(function=cmd_eval)

    verify = subparsers.add_parser("verify", help="verify provenance, CityJSON shells and the GLB")
    verify.set_defaults(function=cmd_verify)

    export = subparsers.add_parser("export", help="re-export CityJSON, 3D Tiles and the viewer")
    export.set_defaults(function=cmd_export)

    benchmark = subparsers.add_parser(
        "benchmark", help="re-run the height benchmark and model card"
    )
    benchmark.add_argument("--aoi", default=None)
    benchmark.set_defaults(function=cmd_benchmark)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.function(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # a CLI should print a reason, not a stack trace
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
