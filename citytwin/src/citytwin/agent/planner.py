"""Planning: turn a question into a bounded, inspectable sequence of tool calls.

The default planner is rule-based on purpose. For a service that answers
questions about a city model, "which query did you run, and against what data"
has to be answerable; a deterministic router is auditable, cheap and testable.
An LLM can be plugged in through ``llm=`` — it must return JSON that is validated
against the same tool schemas, so a hallucinated tool name never executes.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .tools import TOOLS

MAX_STEPS = 3


@dataclass
class Step:
    tool: str
    args: dict[str, Any] = field(default_factory=dict)
    reason: str = ""


@dataclass
class Plan:
    question: str
    steps: list[Step]
    planner: str
    rationale: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "planner": self.planner,
            "rationale": self.rationale,
            "steps": [{"tool": s.tool, "args": s.args, "reason": s.reason} for s in self.steps],
        }


def _bbox_from_text(text: str) -> str | None:
    numbers = re.findall(r"-?\d+\.\d+", text)
    if len(numbers) >= 4:
        return ",".join(numbers[:4])
    return None


def _cell_id(text: str) -> str | None:
    match = re.search(r"\b(cell[-_ ]?\d+|c\d{1,4}|t\d{1,4})\b", text, re.IGNORECASE)
    return match.group(1) if match else None


def plan_with_rules(question: str) -> Plan:
    """Keyword router with explicit precedence; every branch is unit-tested."""
    text = question.lower()
    steps: list[Step] = []

    if any(token in text for token in ("provenance", "audit", "reproduc", "traceab", "hash")):
        steps.append(Step("provenance_check", {}, "the question is about auditability"))
    # stability language wins over the object it mentions ("how stable are the hotspots")
    if any(token in text for token in ("uncertain", "confidence", "how stable", "reliable")):
        steps.append(
            Step("uncertainty_report", {}, "the question is about stability under uncertainty")
        )
    if any(token in text for token in ("hotspot", "hot spot", "heat island", "priority area")):
        steps.append(Step("hotspot_report", {"min_probability": 0.8}, "hotspot question"))
    if any(token in text for token in ("typolog", "cluster", "morpholog", "building type")):
        steps.append(Step("typology_profile", {}, "typology question"))
    if any(token in text for token in ("green", "tree", "plant", "vegetation", "shade")):
        steps.append(Step("greening_candidates", {"top_n": 5}, "greening question"))

    threshold = re.search(r"(?:taller|higher|above)\s+than\s+(\d+(?:\.\d+)?)", text)
    if threshold:
        steps.append(
            Step(
                "list_tall_buildings",
                {"min_height": float(threshold.group(1)), "limit": 10},
                "explicit height threshold in the question",
            )
        )
    elif any(token in text for token in ("tallest", "highest building", "tall building")):
        steps.append(
            Step("list_tall_buildings", {"min_height": 12.0, "limit": 10}, "tall building question")
        )
    elif any(
        token in text
        for token in (
            "height model",
            "height accuracy",
            "height profile",
            "mae",
            "rmse",
            "completeness",
        )
    ):
        steps.append(Step("height_profile", {}, "height quality question"))
    if any(token in text for token in ("what data", "dataset", "collection", "licen", "coverage")):
        steps.append(Step("dataset_card", {}, "dataset question"))

    cell = _cell_id(text)
    if cell and any(token in text for token in ("cell", "explain", "why")):
        steps.insert(
            0, Step("explain_cell", {"cell_id": cell.upper()}, "specific cell in the question")
        )

    if not steps:
        steps.append(
            Step(
                "area_summary",
                {"bbox": _bbox_from_text(text)},
                "default overview of the study area",
            )
        )

    steps = steps[:MAX_STEPS]
    return Plan(
        question=question,
        steps=steps,
        planner="rules",
        rationale="Matched the question against the tool intents; no free-form generation involved.",
    )


def _llm_prompt(question: str) -> str:
    catalogue = "\n".join(f"- {name}: {spec['description']}" for name, spec in TOOLS.items())
    return (
        "You are a planning component for a geospatial digital-twin service.\n"
        "Choose at most three tools from this catalogue and return JSON only:\n"
        '{"rationale": "...", "steps": [{"tool": "...", "args": {...}}]}\n\n'
        f"Tools:\n{catalogue}\n\nQuestion: {question}\n"
    )


def plan_with_llm(question: str, llm: Callable[[str], str]) -> Plan:
    """Ask an LLM for a plan, then validate it against the tool registry."""
    raw = llm(_llm_prompt(question))
    payload = json.loads(raw[raw.find("{") : raw.rfind("}") + 1]) if "{" in raw else {}
    steps: list[Step] = []
    for item in payload.get("steps", [])[:MAX_STEPS]:
        name = item.get("tool")
        if name not in TOOLS:
            raise ValueError(f"planner proposed an unknown tool: {name!r}")
        arguments = item.get("args") or {}
        allowed = set(TOOLS[name]["parameters"].get("properties", {}))
        if set(arguments) - allowed:
            raise ValueError(
                f"planner proposed unknown arguments for {name}: {sorted(set(arguments) - allowed)}"
            )
        for required in TOOLS[name]["parameters"].get("required", []):
            if required not in arguments:
                raise ValueError(f"planner omitted required argument {required!r} for {name}")
        steps.append(Step(name, arguments, item.get("reason", "")))
    if not steps:
        raise ValueError("planner returned no steps")
    return Plan(
        question=question,
        steps=steps,
        planner="llm",
        rationale=payload.get("rationale", ""),
    )


def plan(question: str, llm: Callable[[str], str] | None = None) -> Plan:
    if llm is not None:
        try:
            return plan_with_llm(question, llm)
        except (ValueError, json.JSONDecodeError) as exc:
            fallback = plan_with_rules(question)
            fallback.rationale = f"LLM plan rejected ({exc}); deterministic router used."
            fallback.planner = "rules (llm rejected)"
            return fallback
    return plan_with_rules(question)
