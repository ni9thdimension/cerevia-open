# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Ninth Dimension
"""switchboard.py: a ledger of every model call and an automatic switcher between providers. Standard library only.

An application that talks to several model providers (hosted ones, or a model of your own) usually learns
which one is broken the slow way: a call hangs for two minutes, the next feature tries the same dead provider first, and nobody can
say which model answered what or how many tokens it cost. This module is the small piece that fixes that.

What it does, and only this:
  * record(): remember each call: feature, provider label, model, ok or not, milliseconds, tokens in and out, the plain error
  * keep a health record per provider: consecutive failures, a cool-down after an OUTAGE (timeout, 5xx, 429, 404), a smoothed latency
  * order(): order a provider chain for the caller. Auto (your order, broken providers moved to the back), Fastest (healthy providers
    by measured speed) or Fixed (exactly as given, nothing skipped)
  * snapshot(): report all of it, for a status panel
  * per-session totals through a context variable, so each visitor can be shown their own tokens and not everybody's

What it does not do: it holds no prompts, no answers and never a key. A model that answered but declined on substance is a real
opinion, not an outage, so it is not cooled. Counts live in this process only. On a serverless host each instance keeps its own.

Typical use:

    import switchboard as sb
    for provider in sb.order(chain):                     # chain: [(client, "provider-a"), (client, "provider-b"), ...]
        if sb.should_skip(provider[1], chain): continue
        t0 = time.time()
        try:
            out = call(provider)
            sb.record(provider[1], "drafts", True, (time.time() - t0) * 1000, model="m", tin=1200, tout=3400)
            break
        except Exception as exc:
            sb.record(provider[1], "drafts", False, (time.time() - t0) * 1000, error=str(exc))
"""
from __future__ import annotations

import collections
import contextvars
import threading
import time
from typing import Any, Iterable

STARTED = time.time()
MODES = ("auto", "fastest", "fixed")
_LOCK = threading.RLock()
_RECENT: collections.deque = collections.deque(maxlen=80)
_STATS: dict[str, dict[str, Any]] = {}
_COOLED: dict[str, tuple[float, str]] = {}       # label -> (resume at epoch seconds, plain reason)
_MODE = "auto"

# Whose call it is. The application sets this from the page's own session id, and it follows the call into worker threads, so the header
# can show the visitor THEIR tokens, not everybody's. Only counts are kept per session, never what was asked or answered.
SESSION: contextvars.ContextVar[str] = contextvars.ContextVar("llm_session", default="")
_SESSIONS: "collections.OrderedDict[str, dict[str, int]]" = collections.OrderedDict()
_SESSIONS_MAX = 400

# cool-down seconds by kind of outage; repeated failures double it, capped
_COOL = {"gone": 1800, "limit": 90, "slow": 150, "down": 120, "soft": 120}
_COOL_CAP = 900


def mode() -> str:
    return _MODE


def set_mode(m: str) -> str:
    global _MODE
    if m not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    _MODE = m
    return _MODE


def outage_kind(error: str) -> str:
    """Classify a failure message. '' means a real answer or a substance failure, which is NOT an outage."""
    e = (error or "").lower()
    if not e:
        return ""
    if "http 404" in e or "http 410" in e or "not found for account" in e:
        return "gone"
    if "http 429" in e or "rate limit" in e or "too many requests" in e or "api error 429" in e or "resource_exhausted" in e or "quota" in e:
        return "limit"
    if "timed out" in e or "timeout" in e or "read operation" in e:
        return "slow"
    if ("http 5" in e or "api error 5" in e or "connection" in e or "request failed" in e or "reset by peer" in e
            or "unavailable" in e or "overloaded" in e or any(f"{c} " in e[:12] for c in ("500", "502", "503", "504"))):
        return "down"
    if "unparseable output" in e or "returned reasoning but no answer" in e:
        return "soft"      # it answered, but not in a usable shape: cooled only if it keeps happening
    return ""


def _row(label: str) -> dict[str, Any]:
    r = _STATS.get(label)
    if r is None:
        r = _STATS[label] = {"label": label, "model": "", "calls": 0, "ok": 0, "failed": 0, "tokens_in": 0, "tokens_out": 0,
                             "ms_total": 0, "ewma_ms": None, "streak": 0, "last_error": "", "last_at": 0.0, "by_feature": {}}
    return r


def record(label: str, feature: str, ok: bool, ms: float, *, model: str = "", tin: int = 0, tout: int = 0,
           error: str = "", outage: bool | None = None) -> None:
    """One call. `outage` None means decide from the error text; False means a real answer or a substance failure."""
    now = time.time()
    with _LOCK:
        r = _row(label)
        if model:
            r["model"] = model
        r["calls"] += 1
        r["tokens_in"] += int(tin or 0)
        r["tokens_out"] += int(tout or 0)
        r["ms_total"] += float(ms)
        r["last_at"] = now
        f = r["by_feature"].setdefault(feature or "other", {"calls": 0, "tokens": 0})
        f["calls"] += 1
        f["tokens"] += int(tin or 0) + int(tout or 0)
        kind = outage_kind(error) if outage is None else (outage_kind(error) or "down" if outage else "")
        if ok:
            r["ok"] += 1
            r["streak"] = 0
            r["last_error"] = ""
            r["ewma_ms"] = float(ms) if r["ewma_ms"] is None else 0.7 * r["ewma_ms"] + 0.3 * float(ms)
            _COOLED.pop(label, None)
        else:
            r["failed"] += 1
            r["last_error"] = (error or "")[:200]
            if kind:
                r["streak"] += 1
                if kind != "soft" or r["streak"] >= 2:
                    n = r["streak"] - (1 if kind == "soft" else 0)
                    secs = min(_COOL_CAP if kind != "gone" else _COOL["gone"], _COOL[kind] * (2 ** max(0, n - 1)))
                    _COOLED[label] = (now + secs, {"gone": "this model is not available to this account", "limit": "it hit a rate limit",
                                                   "slow": "it was too slow", "down": "it did not answer",
                                                   "soft": "it kept returning broken answers"}[kind])
        sid = SESSION.get()
        if sid:
            s = _SESSIONS.get(sid)
            if s is None:
                s = _SESSIONS[sid] = {"calls": 0, "tokens_in": 0, "tokens_out": 0}
                while len(_SESSIONS) > _SESSIONS_MAX:
                    _SESSIONS.popitem(last=False)
            _SESSIONS.move_to_end(sid)
            s["calls"] += 1
            s["tokens_in"] += int(tin or 0)
            s["tokens_out"] += int(tout or 0)
        _RECENT.appendleft({"at": now, "feature": feature or "other", "label": label, "model": model or r["model"], "ok": bool(ok),
                            "ms": int(ms), "tokens_in": int(tin or 0), "tokens_out": int(tout or 0), "error": (error or "")[:160],
                            "outage": kind})


def cooling() -> dict[str, dict[str, Any]]:
    now = time.time()
    with _LOCK:
        return {k: {"seconds": max(1, round(t - now)), "why": why} for k, (t, why) in _COOLED.items() if t > now}


def is_cooling(label: str) -> bool:
    with _LOCK:
        c = _COOLED.get(label)
        return bool(c and c[0] > time.time())


def clear(label: str | None = None) -> None:
    with _LOCK:
        if label is None:
            _COOLED.clear()
        else:
            _COOLED.pop(label, None)


def order(chain: list[tuple[Any, str]]) -> list[tuple[Any, str]]:
    """Order a provider chain for one call. Cooled providers go to the back, never vanish: if all are cooled the caller still tries them."""
    if _MODE == "fixed":
        return list(chain)
    healthy = [c for c in chain if not is_cooling(c[1])]
    cooled = [c for c in chain if is_cooling(c[1])]
    if _MODE == "fastest":
        with _LOCK:
            healthy.sort(key=lambda c: (_STATS.get(c[1], {}).get("ewma_ms") or 12000.0))
    return healthy + cooled


def should_skip(label: str, chain: Iterable[tuple[Any, str]]) -> bool:
    """Skip a cooled provider only while another one is healthy, and never in Fixed mode."""
    if _MODE == "fixed" or not is_cooling(label):
        return False
    return any(not is_cooling(l) for _, l in chain)


def snapshot(configured: dict[str, dict[str, Any]], recent: int = 20) -> dict[str, Any]:
    """`configured`: label -> {provider, enabled, has_key, in_chain}. Returns what the Models panel draws."""
    now = time.time()
    with _LOCK:
        rows = []
        labels = list(dict.fromkeys(list(configured) + list(_STATS)))
        cool = cooling()
        for lab in labels:
            cfg = configured.get(lab, {})
            s = _STATS.get(lab)
            enabled, has_key = cfg.get("enabled", True), cfg.get("has_key", True)
            state = "off" if not enabled else "nokey" if not has_key else "cooling" if lab in cool else "ready"
            rows.append({"label": lab, "provider": cfg.get("provider") or lab.split(":")[0], "model": (s or {}).get("model") or cfg.get("model", ""),
                         "state": state, "cooling_s": cool.get(lab, {}).get("seconds", 0), "cooling_why": cool.get(lab, {}).get("why", ""),
                         "calls": (s or {}).get("calls", 0), "ok": (s or {}).get("ok", 0), "failed": (s or {}).get("failed", 0),
                         "tokens_in": (s or {}).get("tokens_in", 0), "tokens_out": (s or {}).get("tokens_out", 0),
                         "avg_ms": round((s or {}).get("ewma_ms") or 0), "last_error": (s or {}).get("last_error", ""),
                         "by_feature": {k: dict(v) for k, v in ((s or {}).get("by_feature") or {}).items()}})
        tin = sum(r["tokens_in"] for r in rows)
        tout = sum(r["tokens_out"] for r in rows)
        return {"since": STARTED, "uptime_s": round(now - STARTED), "mode": _MODE, "providers": rows,
                "totals": {"calls": sum(r["calls"] for r in rows), "tokens_in": tin, "tokens_out": tout, "tokens": tin + tout},
                "recent": [dict(x, ago_s=round(now - x["at"])) for x in list(_RECENT)[:recent]],
                "note": "Counts are for this server since it started. On a serverless host each instance keeps its own."}


def session_totals(sid: str) -> dict[str, int]:
    with _LOCK:
        s = _SESSIONS.get(sid) or {"calls": 0, "tokens_in": 0, "tokens_out": 0}
        return {**s, "tokens": s["tokens_in"] + s["tokens_out"]}


def reset_for_tests() -> None:
    global _MODE
    with _LOCK:
        _SESSIONS.clear()
        _RECENT.clear()
        _STATS.clear()
        _COOLED.clear()
        _MODE = "auto"
