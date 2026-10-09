"""PrintGap web server: the static site plus a small JSON API. Standard library only.

  python -m pg.serve [--host 127.0.0.1] [--port 8000]

  GET  /api/events    the built dataset (same JSON as site/data/events.json)
  GET  /api/status    dataset age, whether chat is on, state of the last refresh
  POST /api/ask       {"event_id", "question", "history"?}  answered by the server's own model key, evidence only
  POST /api/refresh   re-run the SEC fetch + extraction + build; needs  Authorization: Bearer <PRINTGAP_ADMIN_TOKEN>

The model key never leaves this process. The evidence in the prompt is built here from the dataset, never taken
from the browser, so a caller can only choose an event and a question.

Env (or .env): PRINTGAP_ADMIN_TOKEN (refresh is disabled without it), PRINTGAP_REFRESH_HOURS (auto refresh, 0 = off),
PRINTGAP_ASK_PER_HOUR (per client, default 20), PRINTGAP_ASK_PER_DAY (all clients, default 300),
PRINTGAP_TRUST_PROXY=1 (read the client address from X-Forwarded-For; only behind your own proxy).
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pg import envfile, evidence, llm

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
EVENTS = SITE / "data" / "events.json"
MAX_BODY = 32768
MAX_QUESTION = 500
MAX_TURNS = 6
MAX_TURN_CHARS = 2500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Refresher:
    """Runs fetch_all.py then pg.build in a child process; only one at a time."""

    def __init__(self, root: Path = ROOT, steps=None):
        self.root = root
        self.steps = steps or [[sys.executable, "scripts/fetch_all.py"], [sys.executable, "-m", "pg.build"]]
        self._lock = threading.Lock()
        self.state = {"running": False, "started_at": None, "finished_at": None, "ok": None, "message": None}

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.state)

    def start(self) -> bool:
        with self._lock:
            if self.state["running"]:
                return False
            self.state.update(running=True, started_at=_now(), ok=None, message=None)
        threading.Thread(target=self._run, daemon=True).start()
        return True

    def _run(self) -> None:
        ok, msg = True, "done"
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        try:
            for cmd in self.steps:
                p = subprocess.run(cmd, cwd=self.root, env=env, capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=1800)
                if p.returncode != 0:
                    ok, msg = False, f"step failed: {' '.join(cmd[-2:])}"
                    print(f"[refresh] {msg}\n{p.stderr[-1500:]}", file=sys.stderr)
                    break
        except Exception as e:  # noqa: BLE001
            ok, msg = False, "refresh crashed"
            print(f"[refresh] {e!r}", file=sys.stderr)
        with self._lock:
            self.state.update(running=False, finished_at=_now(), ok=ok, message=msg)


class Limiter:
    """Per-client hourly cap plus one shared daily cap, so a public page cannot drain the model budget."""

    def __init__(self, per_hour: int, per_day: int, clock=time.time):
        self.per_hour, self.per_day, self.clock = per_hour, per_day, clock
        self._hits: dict[str, deque] = defaultdict(deque)
        self._day: deque = deque()
        self._lock = threading.Lock()

    def allow(self, client: str) -> str | None:
        """None if allowed (and counted), else the reason."""
        now = self.clock()
        with self._lock:
            while self._day and now - self._day[0] > 86400:
                self._day.popleft()
            h = self._hits[client]
            while h and now - h[0] > 3600:
                h.popleft()
            if len(self._day) >= self.per_day:
                return "The daily question limit for this site has been reached. Try again tomorrow."
            if len(h) >= self.per_hour:
                return "Too many questions from your address this hour. Try again later."
            h.append(now)
            self._day.append(now)
            return None


def _with_history(history, question: str) -> str:
    """Earlier turns as quoted context. They are the caller's words, so they sit in the user message, never the system prompt."""
    turns = []
    for m in (history if isinstance(history, list) else [])[-MAX_TURNS:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            who = "User" if m["role"] == "user" else "Assistant"
            turns.append(f"{who}: {m['content'].strip()[:MAX_TURN_CHARS]}")
    if not turns:
        return question
    nl = chr(10)
    return "Conversation so far (context only):" + nl + nl.join(turns) + nl + nl + "New question: " + question


class App:
    """Everything the handler needs, so tests can build one with fakes."""

    def __init__(self, provider=None, complete=llm.complete, refresher=None, admin_token="", limiter=None,
                 trust_proxy=False, events_path: Path = EVENTS):
        self.provider, self.complete = provider, complete
        self.refresher = refresher or Refresher()
        self.admin_token = admin_token
        self.limiter = limiter or Limiter(20, 300)
        self.trust_proxy = trust_proxy
        self.events_path = events_path
        self.llm_slots = threading.Semaphore(4)
        self._cache: tuple[float, dict] | None = None

    def dataset(self) -> dict | None:
        try:
            mt = self.events_path.stat().st_mtime
            if not self._cache or self._cache[0] != mt:
                self._cache = (mt, json.loads(self.events_path.read_text(encoding="utf-8")))
            return self._cache[1]
        except (OSError, ValueError):
            return None

    def status(self) -> dict:
        d = self.dataset()
        return {
            "generated_at_utc": d.get("generated_at_utc") if d else None,
            "n_events": d.get("n_events") if d else 0,
            "chat": {"enabled": self.provider is not None, "model": self.provider.label if self.provider else None},
            "refresh": {"enabled": bool(self.admin_token), **self.refresher.snapshot()},
        }

    def _complete_retrying(self, system: str, user: str) -> dict:
        """Providers drop connections now and then (seen with DeepSeek); one quiet retry hides that from the user."""
        import requests  # already a dependency of llm.complete

        try:
            return self.complete(self.provider, system, user, timeout=120, json_mode=False)
        except (requests.ConnectionError, requests.Timeout) as e:
            print(f"[ask] retrying after {e.__class__.__name__}", file=sys.stderr)
            return self.complete(self.provider, system, user, timeout=120, json_mode=False)

    def ask(self, client: str, body: dict) -> tuple[int, dict]:
        if not self.provider:
            return 503, {"error": "Chat is not configured on this server."}
        ev_id, q = body.get("event_id"), body.get("question")
        if not isinstance(ev_id, str) or not isinstance(q, str) or not q.strip():
            return 400, {"error": "Send an event_id and a question."}
        q = q.strip()
        if len(q) > MAX_QUESTION:
            return 400, {"error": f"Keep the question under {MAX_QUESTION} characters."}
        d = self.dataset()
        ev = next((e for e in (d or {}).get("events", []) if e.get("id") == ev_id), None)
        if not ev:
            return 404, {"error": "Unknown event."}
        why = self.limiter.allow(client)
        if why:
            return 429, {"error": why}
        system = evidence.chat_system(evidence.evidence(ev, d.get("analogs")))
        if not self.llm_slots.acquire(timeout=30):
            return 503, {"error": "The model is busy. Try again in a moment."}
        try:
            out = self._complete_retrying(system, _with_history(body.get("history"), q))
        except Exception as e:  # noqa: BLE001  never echo provider internals (or anything key-adjacent) to the browser
            print(f"[ask] {e!r}", file=sys.stderr)
            return 502, {"error": "The model could not answer right now."}
        finally:
            self.llm_slots.release()
        return 200, {"answer": out["raw_text"].strip(), "model": self.provider.label}


class Handler(SimpleHTTPRequestHandler):
    server_version = "PrintGap"

    def __init__(self, *a, app: App, **kw):
        self.app = app
        super().__init__(*a, directory=str(SITE), **kw)

    # --- helpers
    def _json(self, code: int, obj: dict, extra: dict | None = None) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _client(self) -> str:
        if self.app.trust_proxy:
            fwd = self.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[-1].strip()  # last hop = the one our own proxy appended
        return self.client_address[0]

    def _body(self) -> dict | None:
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            j = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        return j if isinstance(j, dict) else None

    # --- routes
    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/events":
            d = self.app.dataset()
            return self._json(200, d) if d else self._json(503, {"error": "No dataset built yet. Run: python -m pg.build"})
        if path == "/api/status":
            return self._json(200, self.app.status())
        if path.startswith("/api/"):
            return self._json(404, {"error": "Not found."})
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/ask":
            body = self._body()
            if body is None:
                return self._json(400, {"error": "Send a small JSON body."})
            code, obj = self.app.ask(self._client(), body)
            return self._json(code, obj)
        if path == "/api/refresh":
            tok = self.app.admin_token
            if not tok:
                return self._json(403, {"error": "Refresh is disabled: set PRINTGAP_ADMIN_TOKEN on the server."})
            got = self.headers.get("Authorization", "")
            if not got.startswith("Bearer ") or not hmac.compare_digest(got[7:].encode(), tok.encode()):
                return self._json(401, {"error": "Missing or wrong token."})
            started = self.app.refresher.start()
            return self._json(202 if started else 409, {"started": started, **self.app.refresher.snapshot()})
        return self._json(404, {"error": "Not found."})

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):  # one short line per request on stderr
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def build_app(env=None) -> App:
    env = os.environ if env is None else env
    provider = llm.resolve(env)
    return App(
        provider=provider,
        refresher=Refresher(),
        admin_token=(env.get("PRINTGAP_ADMIN_TOKEN") or "").strip(),
        limiter=Limiter(int(env.get("PRINTGAP_ASK_PER_HOUR") or 20), int(env.get("PRINTGAP_ASK_PER_DAY") or 300)),
        trust_proxy=(env.get("PRINTGAP_TRUST_PROXY") or "") == "1",
    )


def _schedule(app: App, hours: float) -> None:
    def loop():
        while True:
            time.sleep(hours * 3600)
            app.refresher.start()

    threading.Thread(target=loop, daemon=True).start()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Serve PrintGap: the site plus its API.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args(argv)
    envfile.load(ROOT / ".env")
    app = build_app()
    hours = float(os.environ.get("PRINTGAP_REFRESH_HOURS") or 0)
    if hours > 0:
        _schedule(app, hours)
    srv = ThreadingHTTPServer((a.host, a.port), partial(Handler, app=app))
    chat = app.provider.label if app.provider else "off (no model key)"
    print(f"PrintGap on http://{a.host}:{a.port}  chat: {chat}  refresh API: {'on' if app.admin_token else 'off'}"
          f"  auto refresh: {f'every {hours:g}h' if hours > 0 else 'off'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
