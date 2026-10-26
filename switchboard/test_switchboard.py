# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright 2026 Rahul Vats, Cerevia
"""Checks for switchboard.py. No network, no keys.   python test_switchboard.py"""
from __future__ import annotations

import contextvars
from concurrent.futures import ThreadPoolExecutor

import switchboard as sb


def fresh():
    sb.reset_for_tests()


def check_a_call_is_recorded_with_feature_model_time_and_tokens():
    fresh()
    sb.record("prov_b", "drafts", True, 840, model="some-model", tin=1200, tout=3400)
    s = sb.snapshot({"prov_b": {"provider": "prov_b", "enabled": True, "has_key": True}})
    r = s["providers"][0]
    assert r["calls"] == 1 and r["tokens_in"] == 1200 and r["tokens_out"] == 3400 and r["avg_ms"] == 840, r
    assert r["by_feature"]["drafts"]["tokens"] == 4600 and s["totals"]["tokens"] == 4600
    print("  ok  a call is kept with its feature, model, milliseconds and tokens")


def check_an_outage_cools_a_provider_but_a_real_refusal_does_not():
    fresh()
    sb.record("a", "ideas", False, 45000, error="The read operation timed out")
    assert sb.is_cooling("a") and sb.cooling()["a"]["why"] == "it was too slow"
    sb.record("b", "x", False, 900, error="It declined: not enough evidence", outage=False)
    assert not sb.is_cooling("b")
    sb.record("c", "x", False, 300, error="HTTP 404: model not found for account")
    assert sb.cooling()["c"]["seconds"] > 1000          # a model that is gone is not retried for half an hour
    sb.record("a", "ideas", True, 800)
    assert not sb.is_cooling("a")
    print("  ok  a timeout cools, a 404 cools for half an hour, a refusal on substance cools nothing, a good answer clears it")


def check_repeated_failures_cool_for_longer_up_to_a_cap():
    fresh()
    secs = []
    for _ in range(6):
        sb.record("x", "ideas", False, 1, error="HTTP 503: unavailable")
        secs.append(sb.cooling()["x"]["seconds"])
    assert secs[0] < secs[2] <= 900 and max(secs) <= 900, secs
    print(f"  ok  cool-down grows with repeated failures and stops at 15 minutes ({secs[0]}s ... {max(secs)}s)")


def check_a_503_unavailable_cools_and_broken_json_cools_only_when_it_repeats():
    fresh()
    sb.record("g", "x", False, 11000, error="503 UNAVAILABLE. This model is overloaded")
    assert sb.is_cooling("g")
    sb.record("h", "x", False, 43000, error="unparseable output: '{ posts: ['")
    assert not sb.is_cooling("h")
    sb.record("h", "x", False, 40000, error="unparseable output: '{ posts: ['")
    assert sb.is_cooling("h") and sb.cooling()["h"]["why"] == "it kept returning broken answers"
    sb.record("h", "x", True, 900)
    assert not sb.is_cooling("h")
    print("  ok  '503 UNAVAILABLE' is an outage; broken output cools a provider only the second time in a row")


def check_the_three_modes_order_a_chain_as_they_say():
    fresh()
    chain = [(object(), "prov_a"), (object(), "prov_b"), (object(), "prov_c")]
    sb.record("prov_b", "t", True, 3000)
    sb.record("prov_c", "t", True, 400)
    sb.record("prov_a", "t", False, 1, error="HTTP 503 down")
    assert [c[1] for c in sb.order(chain)] == ["prov_b", "prov_c", "prov_a"]
    sb.set_mode("fastest")
    assert [c[1] for c in sb.order(chain)] == ["prov_c", "prov_b", "prov_a"]
    sb.set_mode("fixed")
    assert [c[1] for c in sb.order(chain)] == ["prov_a", "prov_b", "prov_c"] and not sb.should_skip("prov_a", chain)
    try:
        sb.set_mode("turbo")
        raise AssertionError("an unknown mode was accepted")
    except ValueError:
        pass
    print("  ok  Auto moves the broken one back, Fastest sorts by measured speed, Fixed leaves it alone, unknown modes are refused")


def check_if_every_provider_is_cooled_none_is_skipped():
    fresh()
    chain = [(object(), "a"), (object(), "b")]
    sb.record("a", "t", False, 1, error="timed out")
    sb.record("b", "t", False, 1, error="timed out")
    assert not sb.should_skip("a", chain) and not sb.should_skip("b", chain)
    print("  ok  when every provider is cooling, all are still tried, so a request is never refused without asking anyone")


def check_a_visitor_sees_only_their_own_tokens_even_from_worker_threads():
    fresh()
    sb.SESSION.set("visitor-a")
    sb.record("m", "drafts", True, 100, tin=1000, tout=500)
    parent = contextvars.copy_context()
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda i: parent.copy().run(sb.record, "m", "other", True, 50, tin=100, tout=50), range(3)))
    sb.SESSION.set("visitor-b")
    sb.record("m", "ideas", True, 100, tin=40, tout=10)
    a, b = sb.session_totals("visitor-a"), sb.session_totals("visitor-b")
    assert a["tokens"] == 1950 and a["calls"] == 4 and b["tokens"] == 50 and b["calls"] == 1, (a, b)
    assert sb.session_totals("nobody")["tokens"] == 0
    sb.SESSION.set("")
    print("  ok  each visitor's counter holds only their own calls, including calls made in worker threads")


if __name__ == "__main__":
    checks = [v for k, v in sorted(globals().items()) if k.startswith("check_")]
    for c in checks:
        c()
    fresh()
    print(f"\n{len(checks)} checks passed")
