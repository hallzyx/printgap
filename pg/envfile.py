"""Tiny .env reader (standard library only). Real environment variables always win over the file."""
from __future__ import annotations

import os
from pathlib import Path


def parse(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        elif " #" in v:
            v = v.split(" #", 1)[0].rstrip()
        if k:
            out[k] = v
    return out


def load(path, environ=None) -> list:
    """Load KEY=VALUE pairs from path into environ without overriding existing non-empty values. Returns the keys set."""
    environ = os.environ if environ is None else environ
    p = Path(path)
    if not p.is_file():
        return []
    set_keys = []
    for k, v in parse(p.read_text(encoding="utf-8")).items():
        if v and not (environ.get(k) or "").strip():
            environ[k] = v
            set_keys.append(k)
    return set_keys
