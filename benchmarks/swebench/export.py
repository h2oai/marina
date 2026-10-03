# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Export the SWE-bench task fields an agent may see to JSONL.

    python benchmarks/swebench/export.py <out.jsonl> [dataset] [split]

Only the fields a solver is allowed to read are written: the instance id, the
repository, its base commit, the dataset version and the issue text
(`problem_statement`); for SWE-bench Pro (`ScaleAI/SWE-bench_Pro`) also the
PR's `requirements` and `interface`, which are part of its official task text.
Hints, the gold patch, the test patch and the test lists are NOT exported, so
nothing downstream can read them by accident. The file is written outside the
repository; benchmark content is never committed.
"""

import json
import sys

from datasets import load_dataset

ALLOWED = ("instance_id", "repo", "base_commit", "version", "problem_statement", "created_at")
# Present only in SWE-bench Pro; written only when the dataset has them.
PRO_ALLOWED = ("requirements", "interface", "repo_language")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    out = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else "SWE-bench/SWE-bench_Verified"
    split = sys.argv[3] if len(sys.argv) > 3 else "test"
    rows = load_dataset(name, split=split)
    n = 0
    with open(out, "w", encoding="utf-8") as f:
        for row in rows:
            out_row = {k: row.get(k) for k in ALLOWED}
            out_row.update({k: row[k] for k in PRO_ALLOWED if k in row})
            f.write(json.dumps(out_row) + "\n")
            n += 1
    print(json.dumps({"dataset": name, "split": split, "rows": n, "out": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
