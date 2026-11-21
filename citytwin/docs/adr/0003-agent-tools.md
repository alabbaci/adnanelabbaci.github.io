# ADR 0003 — The agent chooses queries, the tools produce numbers

**Status:** accepted · **Date:** 2026-11-11

## Context

"AI-assisted access to trusted geospatial data" is easy to demo and hard to make
trustworthy. A language model can produce a plausible exposure statistic that no tool
ever computed. For a decision-support product, that is the failure mode that matters.

## Decision

1. All numbers come from ten deterministic, read-only tools over the feature store.
2. The planner may be a rules engine (default) or an LLM, but its output is validated
   against the tool schema: unknown tool names, unknown arguments and out-of-range
   values are rejected, and the planner falls back to rules.
3. Every `ToolResult` carries `answer`, `data`, `evidence`, `caveats`, `sources`.
4. The same tools are exposed over MCP (`citytwin mcp`) so an external client can use
   them without our prompt layer.
5. Evaluation is a fixed set of 12 golden questions with routing and groundedness
   assertions; the report is generated, not written by hand.

## Why

- **Auditability**: an answer can be traced to a SQL query and a metric.
- **Evaluability**: routing and groundedness are cheap, strict and repeatable.
- **Human oversight**: caveats are part of the contract, so the exposure caveat cannot
  be dropped by a chatty model.
- **Portability**: MCP means the tools are usable from other clients, not locked into
  this CLI.

## Consequences

- The agent cannot answer questions outside the tool set; it says so.
- An LLM planner adds latency and failure modes without adding capability for the
  current question set — hence rules by default, LLM as an opt-in with validation.
- The evaluation is small (12 tasks). It catches routing regressions, not subtle
  reasoning errors; a larger set with adversarial prompts is on the roadmap.
