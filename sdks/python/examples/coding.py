# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Run one coding task in a folder and print what the coder did.

    python3 coding.py <folder> "<task>" [--budget 10m] [--command 'bun run /path/to/marina/scripts/marina.ts']

Needs the `marina` CLI (or --command saying how to run it) and a model provider.
"""

from __future__ import annotations

import argparse
import os
import shlex
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from marina import Marina, MarinaError, RunResult  # noqa: E402


def code(marina: Marina, task: str, budget: str = "10m", print_=print) -> RunResult:
    """Run `task`, print each step and the change, approve the change when it was handed in."""
    run = marina.code.run(task, budget=budget)
    for step in run.steps():
        print_(f"  {step.label}")
        for line in step.diff or []:
            print_(f"    {line}")
    result = run.result()
    print_(f"{result.outcome} (checks: {result.verification}): {result.summary or ''}")
    if result.submitted:
        print_(marina.code.diff())
        marina.code.review(result.run_id, "approve")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder")
    parser.add_argument("task")
    parser.add_argument("--budget", default="10m")
    parser.add_argument("--command", help="how to run marina, e.g. 'bun run scripts/marina.ts'")
    options = parser.parse_args()
    try:
        with Marina.local(options.folder, command=shlex.split(options.command) if options.command else None) as marina:
            return 0 if code(marina, options.task, options.budget).submitted else 1
    except MarinaError as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
