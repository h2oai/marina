# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Run the official Mind2Web 2 judge (run_eval.py) — or its page cacher — under a hard spend cap.

Usage (from the official checkout's virtualenv):

    python judge_capped.py --official <checkout> --cap-usd 15 --cost-file cost.json \
        -- --agent_name marina-single --answer_folder ... --cache_root ... \
           --eval_results_root ... --eval_scripts_root ... --eval_version dev_set

Every judge request goes through the official client's backoff wrappers; this
script wraps them to price each response from its token usage (list prices
below) and to write the running total to --cost-file after every call. Once the
total reaches --cap-usd the process exits at once (status 3) instead of raising:
an exception inside an eval script would be scored as a failed check, while an
exit leaves the unfinished answers without a result (not scored).
"""

from __future__ import annotations

import argparse
import json
import os
import runpy
import sys
import threading

# USD per million tokens (input, output); OpenAI list prices.
PRICES = {
    "o4-mini": (1.10, 4.40),
    "gpt-4.1": (2.00, 8.00),
    "gpt-6-luna": (0.10, 0.50),
}


def main() -> None:
    argv = sys.argv[1:]
    if "--" in argv:
        split = argv.index("--")
        own, passthrough = argv[:split], argv[split + 1 :]
    else:
        own, passthrough = argv, []
    p = argparse.ArgumentParser()
    p.add_argument("--official", required=True)
    p.add_argument("--cap-usd", type=float, required=True)
    p.add_argument("--cost-file", required=True)
    p.add_argument(
        "--script",
        default="run_eval.py",
        help="official entry point to run (run_eval.py, or batch_answer_cache.py for the page cacher)",
    )
    args = p.parse_args(own)

    official = os.path.abspath(args.official)
    sys.path.insert(0, official)
    from mind2web2.llm_client import openai_client as oc  # noqa: E402

    lock = threading.Lock()
    state = {"usd": 0.0, "calls": 0, "input_tokens": 0, "output_tokens": 0, "unpriced": 0}

    def account(resp, model: str) -> None:
        usage = getattr(resp, "usage", None)
        if usage is None:
            return
        tin = getattr(usage, "prompt_tokens", 0) or 0
        tout = getattr(usage, "completion_tokens", 0) or 0
        base = next((k for k in PRICES if model == k or model.startswith(k + "-")), None)
        with lock:
            state["calls"] += 1
            state["input_tokens"] += tin
            state["output_tokens"] += tout
            if base is None:
                state["unpriced"] += 1
            else:
                pin, pout = PRICES[base]
                state["usd"] += (tin * pin + tout * pout) / 1_000_000
            with open(args.cost_file, "w") as fp:
                json.dump({**state, "cap_usd": args.cap_usd}, fp)
            over = state["usd"] >= args.cap_usd
        if over:
            sys.stderr.write(f"judge spend cap ${args.cap_usd} reached (${state['usd']:.2f}); stopping\n")
            sys.stderr.flush()
            os._exit(3)

    def check() -> None:
        if state["usd"] >= args.cap_usd:
            os._exit(3)

    sync_inner = oc.completion_with_backoff
    async_inner = oc.acompletion_with_backoff

    def completion(client, **kwargs):
        check()
        resp = sync_inner(client, **kwargs)
        account(resp, str(kwargs.get("model", "")))
        return resp

    async def acompletion(client, **kwargs):
        check()
        resp = await async_inner(client, **kwargs)
        account(resp, str(kwargs.get("model", "")))
        return resp

    oc.completion_with_backoff = completion
    oc.acompletion_with_backoff = acompletion

    with open(args.cost_file, "w") as fp:
        json.dump({**state, "cap_usd": args.cap_usd}, fp)
    script = os.path.join(official, args.script)
    sys.argv = [script, *passthrough]
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
