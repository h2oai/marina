#!/usr/bin/env python3
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Run the official LongMemEval-V2 harness with Marina's memory backend.

The same steps as the official `evaluation/run_eval.py` (materialize the runtime
questions and haystack, then call `evaluation.harness`), with the `marina`
backend from `marina_memory.py` registered first. Nothing in the harness, the
reader prompt, the evaluator or the scoring is changed.

  python benchmarks/longmemeval/run.py --lme-root <LongMemEval-V2 checkout> \
    --data-root <dataset> --domain web --tier small --output-dir runs/marina_lexical_web_small \
    [--limit N | --question-ids a,b] [--mode lexical|hybrid] [memory budget flags] \
    [--reader-model ... --reader-base-url ... --evaluator-model ... --evaluator-base-url ...]

Run it with the LongMemEval-V2 Python environment. Keys are read from the
environment variables named by --reader-api-key-env / --evaluator-api-key-env.
The leaderboard infers the method from the output directory name
(`<method>_<domain>_<tier>`).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARINA_ROOT = HERE.parents[1]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lme-root", required=True, help="LongMemEval-V2 repository checkout")
    p.add_argument("--data-root", required=True)
    p.add_argument("--domain", choices=["web", "enterprise"], required=True)
    p.add_argument("--tier", choices=["small", "medium"], default="small")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--question-ids", default=None, help="comma-separated question ids")
    # Memory (the system under test).
    p.add_argument(
        "--backend",
        choices=["marina", "no_retrieval"],
        default="marina",
        help="no_retrieval is the official no-memory control (same reader and judge)",
    )
    p.add_argument("--mode", choices=["lexical", "hybrid"], default="lexical")
    p.add_argument("--search-limit", type=int, default=40)
    p.add_argument("--context-bytes", type=int, default=160000)
    p.add_argument("--state-bytes", type=int, default=10000)
    p.add_argument("--episode-bytes", type=int, default=6000)
    p.add_argument("--radius", type=int, default=1)
    p.add_argument("--work-dir", default=None, help="throwaway database directory (default $TMPDIR)")
    p.add_argument("--bun", default="bun")
    # Fixed reader and judge (the board's settings; defaults as in run_eval.py).
    p.add_argument("--reader-model", default=os.getenv("READER_MODEL", "Qwen/Qwen3.5-9B"))
    p.add_argument("--reader-base-url", default=os.getenv("READER_BASE_URL", "http://localhost:8023/v1"))
    p.add_argument("--reader-api-key-env", default="OPENAI_API_KEY")
    p.add_argument("--reader-temperature", type=float, default=0.6)
    p.add_argument("--reader-top-p", type=float, default=0.95)
    p.add_argument("--reader-top-k", type=int, default=20)
    p.add_argument("--reader-max-concurrent-requests", type=int, default=16)
    p.add_argument("--max-completion-tokens", type=int, default=20000)
    p.add_argument("--memory-context-max-tokens", type=int, default=200000)
    p.add_argument(
        "--reader-quantizations",
        default=None,
        help="OpenRouter only: comma-separated provider quantizations for the reader (e.g. bf16, "
        "the paper's unquantized Qwen3.5-9B); sent as the request's `provider` routing preference",
    )
    p.add_argument("--evaluator-model", default=os.getenv("EVALUATOR_MODEL", "gpt-5.2"))
    p.add_argument("--evaluator-base-url", default=None)
    p.add_argument("--evaluator-api-key-env", default="OPENAI_API_KEY")
    p.add_argument("--evaluator-reasoning-effort", choices=["low", "medium", "high"], default="medium")
    p.add_argument("--evaluator-max-completion-tokens", type=int, default=4096)
    p.add_argument("--memory-config-only", action="store_true", help="write runtime inputs and exit")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    lme_root = Path(args.lme_root).expanduser().resolve()
    sys.path.insert(0, str(lme_root))
    sys.path.insert(0, str(HERE))
    from data.public_data import (  # type: ignore[import-not-found]
        materialize_runtime_haystack,
        materialize_runtime_questions,
        write_json,
    )

    import marina_memory  # noqa: F401  (registers memory_type "marina")

    data_root = Path(args.data_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    runtime_dir = output_dir / "runtime_inputs"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    question_ids = [q.strip() for q in (args.question_ids or "").split(",") if q.strip()] or None
    selected = materialize_runtime_questions(
        data_root=data_root,
        domain=args.domain,
        question_ids=question_ids,
        limit=args.limit,
        output_path=runtime_dir / "questions.json",
    )
    materialize_runtime_haystack(
        data_root=data_root,
        tier=args.tier,
        selected_questions=selected,
        output_path=runtime_dir / "haystack.json",
    )
    memory_config: dict[str, object] = {"memory_type": "no_retrieval", "memory_params": {}}
    if args.backend == "marina":
        memory_config = {
            "memory_type": "marina",
            "memory_params": {
                "marina_root": str(MARINA_ROOT),
                "bun": args.bun,
                "mode": args.mode,
                "search_limit": args.search_limit,
                "context_bytes": args.context_bytes,
                "state_bytes": args.state_bytes,
                "episode_bytes": args.episode_bytes,
                "radius": args.radius,
                "work_dir": args.work_dir,
            },
        }
    write_json(runtime_dir / "memory_config.json", memory_config)
    print(json.dumps({"runtime_dir": str(runtime_dir), "questions": len(selected)}), flush=True)
    if args.memory_config_only:
        return

    harness_argv = [
        "evaluation.harness",
        "--domain", args.domain,
        "--questions-path", str(runtime_dir / "questions.json"),
        "--haystack-path", str(runtime_dir / "haystack.json"),
        "--trajectories-path", str(data_root / "trajectories.jsonl"),
        "--memory-config-path", str(runtime_dir / "memory_config.json"),
        "--output-dir", str(output_dir),
        "--model", args.reader_model,
        "--base-url", args.reader_base_url,
        "--api-key-env", args.reader_api_key_env,
        "--temperature", str(args.reader_temperature),
        "--top-p", str(args.reader_top_p),
        "--top-k", str(args.reader_top_k),
        "--max-completion-tokens", str(args.max_completion_tokens),
        "--memory-context-max-tokens", str(args.memory_context_max_tokens),
        "--reader-max-concurrent-requests", str(args.reader_max_concurrent_requests),
        "--prompt-build-max-workers", "1",
        "--evaluator-model", args.evaluator_model,
        "--evaluator-api-key-env", args.evaluator_api_key_env,
        "--evaluator-reasoning-effort", args.evaluator_reasoning_effort,
        "--evaluator-max-completion-tokens", str(args.evaluator_max_completion_tokens),
    ]  # fmt: skip
    if args.evaluator_base_url:
        harness_argv += ["--evaluator-base-url", args.evaluator_base_url]
    sys.argv = harness_argv
    import evaluation.harness as harness  # type: ignore[import-not-found]

    if args.reader_quantizations:
        # Request routing only: the reader model, prompt and sampling are unchanged.
        quantizations = [q.strip() for q in args.reader_quantizations.split(",") if q.strip()]
        build_extra_body = harness.build_extra_body

        def with_provider(ns: argparse.Namespace):  # type: ignore[no-untyped-def]
            body = dict(build_extra_body(ns) or {})
            body["provider"] = {"quantizations": quantizations}
            return body

        harness.build_extra_body = with_provider
    harness.main()


if __name__ == "__main__":
    main()
