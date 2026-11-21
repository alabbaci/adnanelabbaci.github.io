"""A minimal MCP server over stdio (JSON-RPC 2.0, one message per line).

Why hand-rolled: the point is to show what an MCP tool surface looks like when it
sits on top of a governed data layer — capabilities, input schemas, and results
that carry their own evidence. It has no dependencies and can be launched by any
MCP client:

    python -m citytwin.agent.mcp_server

Supported methods: ``initialize``, ``tools/list``, ``tools/call``, ``ping``.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from .tools import call_tool, tool_schemas

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "citytwin", "version": "0.5.0"}


def _response(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    """Handle one JSON-RPC message; returns None for notifications."""
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}

    if method == "initialize":
        return _response(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
                "instructions": (
                    "Read-only tools over the citytwin digital twin (Dakhla). "
                    "Every result carries evidence and caveats; cite them in your answer."
                ),
            },
        )
    if method in ("notifications/initialized", "initialized"):
        return None
    if method == "ping":
        return _response(request_id, {})
    if method == "tools/list":
        return _response(request_id, {"tools": tool_schemas()})
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}
        try:
            result = call_tool(name, arguments)
        except (KeyError, ValueError, FileNotFoundError) as exc:
            return _response(
                request_id,
                {
                    "content": [{"type": "text", "text": f"tool error: {exc}"}],
                    "isError": True,
                },
            )
        return _response(
            request_id,
            {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            result.as_dict(), indent=2, ensure_ascii=False, default=str
                        ),
                    }
                ],
                "isError": False,
            },
        )
    if request_id is None:
        return None
    return _error(request_id, -32601, f"method not found: {method!r}")


def serve(stdin=None, stdout=None) -> None:
    """Line-delimited stdio loop."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            stdout.write(json.dumps(_error(None, -32700, "parse error")) + "\n")
            stdout.flush()
            continue
        reply = handle(message)
        if reply is not None:
            stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            stdout.flush()


if __name__ == "__main__":
    serve()
