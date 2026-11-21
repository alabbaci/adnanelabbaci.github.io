"""Execution loop: plan → call tools → assemble an answer → write a trace.

The runner is deliberately boring. Every step is recorded with its arguments, the
sha256 of its result, and its wall-clock time, so an answer can be reconstructed
after the fact. The tool set is read-only; there is no action the agent can take
on the city, only questions it can answer.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..config import BUILD_DIR
from .planner import Plan, plan
from .tools import ToolResult, call_tool


@dataclass
class StepRecord:
    tool: str
    args: dict[str, Any]
    reason: str
    seconds: float
    answer: str
    evidence: list[str]
    caveats: list[str]
    result_hash: str


@dataclass
class AgentRun:
    question: str
    plan: Plan
    steps: list[StepRecord] = field(default_factory=list)
    answer: str = ""
    trace_path: Path | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "planner": self.plan.planner,
            "rationale": self.plan.rationale,
            "steps": [record.__dict__ for record in self.steps],
            "answer": self.answer,
            "trust": {
                "read_only": True,
                "human_oversight": "every step is inspectable before use; no write operations exist",
                "deterministic_planner_default": True,
            },
        }


def run(
    question: str, llm: Callable[[str], str] | None = None, *, write_trace: bool = True
) -> AgentRun:
    """Answer a question and record how."""
    agent_plan = plan(question, llm=llm)
    result = AgentRun(question=question, plan=agent_plan)

    for step in agent_plan.steps:
        started = datetime.now(UTC)
        try:
            tool_result: ToolResult = call_tool(step.tool, step.args)
        except (KeyError, ValueError, FileNotFoundError) as exc:
            tool_result = ToolResult(
                tool=step.tool,
                args=step.args,
                answer=f"The tool {step.tool!r} could not answer: {exc}",
                caveats=[
                    "A failed tool call is reported as a failure, never filled in by the model."
                ],
            )
        elapsed = (datetime.now(UTC) - started).total_seconds()
        payload = json.dumps(tool_result.as_dict(), sort_keys=True, default=str)
        result.steps.append(
            StepRecord(
                tool=step.tool,
                args=step.args,
                reason=step.reason,
                seconds=round(elapsed, 3),
                answer=tool_result.answer,
                evidence=tool_result.evidence,
                caveats=tool_result.caveats,
                result_hash=hashlib.sha256(payload.encode()).hexdigest()[:16],
            )
        )

    result.answer = _compose(result)
    if write_trace:
        result.trace_path = _write_trace(result)
    return result


def _compose(run_result: AgentRun) -> str:
    lines = [run_result.steps[0].answer] if run_result.steps else ["No tool was run."]
    for record in run_result.steps[1:]:
        lines.append(record.answer)
    caveats = sorted({caveat for record in run_result.steps for caveat in record.caveats})
    if caveats:
        lines.append("Caution: " + " ".join(caveats))
    return "\n".join(lines)


def _write_trace(run_result: AgentRun) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    slug = "".join(ch if ch.isalnum() else "-" for ch in run_result.question.lower())[:48].strip(
        "-"
    )
    directory = BUILD_DIR / "agent_trace"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{stamp}-{slug or 'question'}.json"
    path.write_text(json.dumps(run_result.as_dict(), indent=2, default=str), encoding="utf-8")
    return path
