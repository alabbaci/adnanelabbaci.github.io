"""Agent layer: routing, argument validation, MCP protocol and failure handling."""

from __future__ import annotations

import json

import pytest

from citytwin.agent import planner
from citytwin.agent.mcp_server import handle
from citytwin.agent.tools import TOOLS, call_tool, tool_schemas


@pytest.mark.parametrize(
    "question,tool",
    [
        ("How stable are the hotspots under height uncertainty?", "uncertainty_report"),
        ("Which cells are robust hotspots?", "hotspot_report"),
        ("What is the height model accuracy?", "height_profile"),
        ("Where should we plant trees?", "greening_candidates"),
        ("Describe the building typologies.", "typology_profile"),
        ("Show the tallest buildings.", "list_tall_buildings"),
        ("How many buildings are taller than 15 m?", "list_tall_buildings"),
        ("Can I reproduce the outputs? Check provenance.", "provenance_check"),
        ("What data is in the twin?", "dataset_card"),
        ("Explain cell C12.", "explain_cell"),
    ],
)
def test_router_picks_the_expected_tool(question, tool):
    plan = planner.plan(question)
    assert plan.planner == "rules"
    assert plan.steps[0].tool == tool


def test_router_extracts_threshold_and_bbox():
    plan = planner.plan("How many buildings are taller than 18 m inside 5.97,49.49,5.98,49.50?")
    step = plan.steps[0]
    assert step.tool == "list_tall_buildings"
    assert step.args["min_height"] == 18.0


def test_router_falls_back_to_overview():
    plan = planner.plan("What does this dataset look like?")
    assert plan.steps[0].tool in {"area_summary", "dataset_card"}


def test_llm_plan_is_validated():
    def hallucinating(_prompt: str) -> str:
        return '{"steps": [{"tool": "drop_database", "args": {}}]}'

    with pytest.raises(ValueError):
        planner.plan_with_llm("anything", hallucinating)

    def good(_prompt: str) -> str:
        return '{"rationale": "needs heights", "steps": [{"tool": "height_profile", "args": {}}]}'

    result = planner.plan_with_llm("height accuracy?", good)
    assert result.planner == "llm"
    assert result.steps[0].tool == "height_profile"


def test_llm_failure_falls_back_to_rules():
    def broken(_prompt: str) -> str:
        return "I would query the database."

    plan = planner.plan("Which cells are hotspots?", llm=broken)
    assert plan.steps[0].tool == "hotspot_report"
    assert "rejected" in plan.rationale


def test_tool_arguments_are_validated():
    with pytest.raises(KeyError):
        call_tool("no_such_tool")
    with pytest.raises(ValueError):
        call_tool("hotspot_report", {"min_probability": 0.8, "sql": "drop table"})
    with pytest.raises(ValueError):
        call_tool("explain_cell", {})


def test_tool_schemas_are_mcp_shaped():
    schemas = tool_schemas()
    assert len(schemas) == len(TOOLS)
    for schema in schemas:
        assert schema["name"] and schema["description"]
        assert schema["inputSchema"]["type"] == "object"
        assert isinstance(schema["inputSchema"]["properties"], dict)


def test_mcp_initialize_and_list():
    init = handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert init["result"]["serverInfo"]["name"] == "citytwin"
    assert "tools" in init["result"]["capabilities"]

    listing = handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert len(listing["result"]["tools"]) == len(TOOLS)

    assert handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None

    unknown = handle({"jsonrpc": "2.0", "id": 3, "method": "nope/nope"})
    assert unknown["error"]["code"] == -32601


def test_mcp_tool_call_returns_evidence():
    reply = handle(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "height_profile", "arguments": {}},
        }
    )
    assert reply["result"]["isError"] is False
    payload = json.loads(reply["result"]["content"][0]["text"])
    assert "evidence" in payload
    assert "caveats" in payload


def test_mcp_tool_error_is_reported_not_faked():
    reply = handle(
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "explain_cell", "arguments": {}},
        }
    )
    assert reply["result"]["isError"] is True
