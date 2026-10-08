"""Provider layer: the same extraction prompt can run on Anthropic, OpenAI, DeepSeek or any
OpenAI-compatible endpoint (for example the Qwen endpoint the hackathon provides).

Choice of provider (first match wins):
  PRINTGAP_PROVIDER = anthropic | openai | deepseek | qwen | compatible   (explicit)
  otherwise whichever key exists, in this order:
  ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, QWEN_API_KEY, LLM_API_KEY (+ PRINTGAP_BASE_URL, PRINTGAP_MODEL)
PRINTGAP_MODEL overrides the default model of the chosen provider.
Keys are only ever sent to the provider's own endpoint and are never written to disk or logs.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULTS = {
    # name: (default model, base url)
    "anthropic": ("claude-sonnet-5-5", "https://api.anthropic.com"),
    "openai": ("gpt-6-luna", "https://api.openai.com/v1"),
    "deepseek": ("deepseek-flash", "https://api.deepseek.com"),
    # Hackathon-provided Qwen endpoint and model, from the S2 handbook (override with PRINTGAP_BASE_URL / PRINTGAP_MODEL)
    "qwen": ("qwen3.8-max", "https://hackathon.bitgetops.com/v1"),
    "compatible": (None, None),
}
# Output budget per provider. Reasoning models (OpenAI GPT-6, DeepSeek thinking mode) spend part of
# this on hidden reasoning, so it is generous; an extraction itself is only a couple of thousand tokens.
MAX_OUT = {"anthropic": 4096, "openai": 16000, "deepseek": 8000, "qwen": 8000, "compatible": 8000}
KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "qwen": "QWEN_API_KEY",
    "compatible": "LLM_API_KEY",
}
ORDER = ["anthropic", "openai", "deepseek", "qwen", "compatible"]


@dataclass(frozen=True)
class Provider:
    name: str
    model: str
    api_key: str = ""
    base_url: str = ""

    @property
    def label(self) -> str:
        return f"{self.name}:{self.model}"


def _clean(v: str | None) -> str | None:
    v = (v or "").strip()
    return v or None


def resolve(env=None) -> Provider | None:
    """Pick a provider from the environment. None if no key is set (cached extractions still work)."""
    env = os.environ if env is None else env
    want = (_clean(env.get("PRINTGAP_PROVIDER")) or "").lower()
    model = _clean(env.get("PRINTGAP_MODEL"))
    if want and want not in DEFAULTS:
        raise ValueError(f"PRINTGAP_PROVIDER must be one of {', '.join(ORDER)} (got '{want}')")
    for name in [want] if want else ORDER:
        key = _clean(env.get(KEY_ENV[name]))
        if not key:
            if want:
                raise ValueError(f"PRINTGAP_PROVIDER={want} but {KEY_ENV[name]} is not set")
            continue
        d_model, d_base = DEFAULTS[name]
        base = (_clean(env.get("PRINTGAP_BASE_URL")) or d_base) if name in ("qwen", "compatible") else d_base
        m = model or d_model
        if name == "compatible" and not (base and m):
            raise ValueError("compatible provider needs PRINTGAP_BASE_URL and PRINTGAP_MODEL")
        return Provider(name=name, model=m, api_key=key, base_url=(base or "").rstrip("/"))
    return None


def build_request(p: Provider, system: str, user: str, max_tokens: int | None = None):
    """Return (url, headers, json_body). Pure, so it can be tested without a network."""
    max_tokens = max_tokens or MAX_OUT[p.name]
    if p.name == "anthropic":
        return (
            f"{p.base_url}/v1/messages",
            {"x-api-key": p.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            {"model": p.model, "max_tokens": max_tokens, "temperature": 0, "system": system,
             "messages": [{"role": "user", "content": user}]},
        )
    body = {
        "model": p.model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
    }
    if p.name == "openai":
        body["max_completion_tokens"] = max_tokens  # newer models reject max_tokens; they also reject temperature
    else:
        body["max_tokens"] = max_tokens
        body["temperature"] = 0
    return (f"{p.base_url}/chat/completions", {"Authorization": f"Bearer {p.api_key}", "content-type": "application/json"}, body)


def parse_response(p: Provider, body: dict) -> tuple[str, dict | None]:
    cut = "the answer was cut off at the output limit (the model may have spent it on reasoning); lower the reasoning effort or use a smaller model"
    if p.name == "anthropic":
        if body.get("stop_reason") == "max_tokens":
            raise ValueError(f"{p.name}: {cut}")
        text = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
        return text, body.get("usage")
    try:
        choice = body["choices"][0]
        text = choice["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as e:
        raise ValueError(f"unexpected {p.name} response shape") from e
    if choice.get("finish_reason") == "length":
        raise ValueError(f"{p.name}: {cut}")
    return text, body.get("usage")


def complete(p: Provider, system: str, user: str, max_tokens: int | None = None, timeout: int = 300) -> dict:
    import requests  # lazy: the offline build needs no network libraries

    url, headers, body = build_request(p, system, user, max_tokens)
    r = requests.post(url, headers=headers, json=body, timeout=timeout)
    if r.status_code != 200:
        # the response body never contains our key; still cap it
        raise RuntimeError(f"{p.name} returned HTTP {r.status_code}: {r.text[:300]}")
    text, usage = parse_response(p, r.json())
    return {"raw_text": text, "usage": usage}
