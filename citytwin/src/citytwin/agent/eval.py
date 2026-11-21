"""Evaluation harness for the agent layer: golden questions with grounded checks.

The checks assert that the answer contains the quantity the tool actually
returned — a cheap but real guard against confident-sounding output that is not
backed by data. Routing accuracy and evidence coverage are reported separately so
a failure tells you whether the planner or the tool was wrong.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import BUILD_DIR, REPO_ROOT
from .runner import AgentRun, run


@dataclass
class GoldenTask:
    id: str
    question: str
    expected_tools: list[str]
    check: Callable[[AgentRun], bool]
    check_label: str


def _contains(run_result: AgentRun, needle: str) -> bool:
    return needle.lower() in run_result.answer.lower()


GOLDEN: list[GoldenTask] = [
    GoldenTask(
        "G01",
        "How stable are the heat hotspots once height uncertainty is propagated?",
        ["uncertainty_report"],
        lambda r: _contains(r, "jaccard"),
        "mentions the Jaccard overlap of the hotspot sets",
    ),
    GoldenTask(
        "G02",
        "Which cells are robust hotspots at 80% probability?",
        ["hotspot_report"],
        lambda r: _contains(r, "robust") and _contains(r, "cells"),
        "reports the count of robust hotspot cells",
    ),
    GoldenTask(
        "G03",
        "What is the height model accuracy and why was it chosen?",
        ["height_profile"],
        lambda r: _contains(r, "mae"),
        "reports MAE from the recorded metrics",
    ),
    GoldenTask(
        "G04",
        "Where should new tree planting be prioritised?",
        ["greening_candidates"],
        lambda r: _contains(r, "hei"),
        "names cells with exposure index values",
    ),
    GoldenTask(
        "G05",
        "What building typologies exist in the study area?",
        ["typology_profile"],
        lambda r: _contains(r, "silhouette") or _contains(r, "cluster"),
        "reports cluster count or silhouette",
    ),
    GoldenTask(
        "G06",
        "Show me the tallest buildings.",
        ["list_tall_buildings"],
        lambda r: _contains(r, "m tall") or _contains(r, "highest"),
        "reports a height in metres",
    ),
    GoldenTask(
        "G07",
        "Can I reproduce these outputs from the provenance record?",
        ["provenance_check"],
        lambda r: _contains(r, "hash") or _contains(r, "match"),
        "reports a hash verification outcome",
    ),
    GoldenTask(
        "G08",
        "What data is in the twin and under which licence?",
        ["dataset_card"],
        lambda r: _contains(r, "collections"),
        "lists the stored collections",
    ),
    GoldenTask(
        "G09",
        "Summarise exposure across the whole study area.",
        ["area_summary"],
        lambda r: _contains(r, "exposure"),
        "reports a mean exposure value",
    ),
    GoldenTask(
        "G10",
        "Explain cell C12.",
        ["explain_cell"],
        lambda r: _contains(r, "c12") or _contains(r, "exposure"),
        "returns a cell-level explanation",
    ),
    GoldenTask(
        "G11",
        "Is the exposure index sensitive to the weights I chose?",
        ["area_summary", "typology_profile", "hotspot_report", "uncertainty_report"],
        lambda r: _contains(r, "exposure"),
        "answers with a stored exposure statistic (no weight-sensitivity tool exists yet)",
    ),
    GoldenTask(
        "G12",
        "How many buildings are taller than 15 m?",
        ["list_tall_buildings"],
        lambda r: _contains(r, "footprints"),
        "reports a building count",
    ),
]


def evaluate(questions: list[GoldenTask] | None = None) -> dict[str, Any]:
    tasks = questions or GOLDEN
    rows = []
    for task in tasks:
        started = time.perf_counter()
        try:
            agent_run = run(task.question, write_trace=False)
            error = None
        except Exception as exc:
            agent_run = None
            error = str(exc)
        elapsed = time.perf_counter() - started
        called = [step.tool for step in agent_run.steps] if agent_run else []
        routed = called[0] in task.expected_tools if called else False
        passed = bool(agent_run and task.check(agent_run)) if not error else False
        rows.append(
            {
                "id": task.id,
                "question": task.question,
                "planner": agent_run.plan.planner if agent_run else "-",
                "expected": task.expected_tools,
                "called": called,
                "routed": routed,
                "grounded": passed,
                "check": task.check_label,
                "seconds": round(elapsed, 2),
                "error": error,
            }
        )

    routed = sum(1 for row in rows if row["routed"])
    grounded = sum(1 for row in rows if row["grounded"])
    steps = [len(row["called"]) for row in rows if row["called"]]
    summary = {
        "tasks": len(rows),
        "routing_accuracy": round(routed / len(rows), 3),
        "grounded_pass_rate": round(grounded / len(rows), 3),
        "mean_steps": round(sum(steps) / len(steps), 2) if steps else 0,
        "mean_seconds": round(sum(row["seconds"] for row in rows) / len(rows), 2),
        "deterministic_planner_share": round(
            sum(1 for row in rows if row["planner"] == "rules") / len(rows), 3
        ),
    }
    return {"summary": summary, "rows": rows}


def write_report(result: dict[str, Any], path: Path | None = None) -> Path:
    target = path or (REPO_ROOT / "docs" / "agent_eval.md")
    summary = result["summary"]
    table = "\n".join(
        f"| {row['id']} | {row['question']} | {row['called'][0] if row['called'] else '—'} | "
        f"{'yes' if row['routed'] else 'no'} | {'yes' if row['grounded'] else 'no'} | {row['seconds']:.2f} s |"
        for row in result["rows"]
    )
    text = f"""# Agent evaluation

`citytwin eval` runs the golden questions below against the built feature store.
Routing is scored against the expected first tool; groundedness asserts that the
answer contains the quantity the tool returned. Both are deliberately strict and
cheap: they catch a planner that picks the wrong query and an answer that does not
carry its own numbers.

| Metric | Value |
|---|---|
| Tasks | {summary["tasks"]} |
| Routing accuracy | {summary["routing_accuracy"]:.0%} |
| Grounded pass rate | {summary["grounded_pass_rate"]:.0%} |
| Mean tool calls per question | {summary["mean_steps"]} |
| Mean latency (s) | {summary["mean_seconds"]} |
| Share answered by the deterministic planner | {summary["deterministic_planner_share"]:.0%} |

| ID | Question | First tool | Routed | Grounded | Time |
|---|---|---|---|---|---|
{table}

## What is not evaluated

- Free-form LLM answers. The LLM hook in `citytwin.agent.planner` is optional and its
  output is validated against the tool schemas before execution; without a key the
  deterministic router is used and this table is reproducible in CI.
- Spatial correctness of the index itself. That is covered by the analytics tests
  and the model card, not by the agent harness.
- Multi-turn dialogue. The runner answers single questions; state is passed by the
  client, not accumulated by the service.

## Reading the failures

A routing miss means the question did not match any tool intent — the honest fix is
a new tool or a better description, not a looser keyword list. A groundedness miss
with correct routing means the tool answered a different question than the one
asked; that is the case worth investigating first.
"""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    (BUILD_DIR / "agent_eval.json").write_text(
        json.dumps(result, indent=2, default=str), encoding="utf-8"
    )
    return target
