"""Minimal MCP (streamable HTTP) client for Bitget's read-only `bitget-mcp-server`.

Best effort and deliberately defensive: we do not assume tool parameter names. The first
run captures `tools/list` and `guide` verbatim into data/mcp/ so the real catalog is on
record; later queries use whatever that catalog says. Failures are recorded, never hidden.
"""
from __future__ import annotations

import json

URL = "https://agent.bitget.com/mcp"
HEAD = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


def _parse(resp) -> dict:
    ctype = resp.headers.get("content-type", "")
    if "text/event-stream" in ctype:
        last = None
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                try:
                    last = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    pass
        if last is None:
            raise RuntimeError("empty SSE response")
        return last
    return resp.json()


class Client:
    def __init__(self, url: str = URL):
        import requests

        self.s = requests.Session()
        self.url = url
        self.sid = None
        self._id = 0

    def _rpc(self, method: str, params: dict | None = None, notify: bool = False):
        self._id += 1
        body = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not notify:
            body["id"] = self._id
        h = dict(HEAD)
        if self.sid:
            h["Mcp-Session-Id"] = self.sid
        r = self.s.post(self.url, headers=h, json=body, timeout=60)
        r.raise_for_status()
        if r.headers.get("Mcp-Session-Id"):
            self.sid = r.headers["Mcp-Session-Id"]
        if notify or not r.text.strip():
            return None
        return _parse(r)

    def start(self):
        out = self._rpc(
            "initialize",
            {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "printgap", "version": "0.1"}},
        )
        self._rpc("notifications/initialized", {}, notify=True)
        return out

    def list_tools(self):
        return self._rpc("tools/list", {})

    def call(self, name: str, arguments: dict):
        return self._rpc("tools/call", {"name": name, "arguments": arguments})


def unwrap(result: dict):
    """tools/call -> the JSON the server put in result.content[0].text (or the raw text)."""
    try:
        text = result["result"]["content"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return result
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text
