# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Grade SWE-bench Pro (v2) predictions locally with the benchmark's own verifier.

    python benchmarks/swebench/pro_grade.py --tasks <SWE-bench_Pro-os>/v2/tasks \
        --predictions <predictions.jsonl> --out <dir> [--runtime podman] [--workers 2] \
        [--gold | --empty]   # self-checks: the reference patch must pass, an empty one must fail

A local replay of the harness's `PatchReplayAgent` for hosts where Harbor's own
container backends cannot run (e.g. rootless Podman without bridge networking).
Per instance, in a FRESH container of the task's pristine image:

  1. copy the task's `tests/` directory to `/tests` (unmodified: `test.sh`,
     `run_script.sh`, `parser.py`, `config.json`, `test_patch.patch`);
  2. apply the predicted patch with the replay agent's exact fallback chain
     (`git apply --verbose` → `git apply --3way` → `patch --fuzz=3 -p1`) in
     `/app` (or `/testbed`); an empty patch applies nothing;
  3. run `bash /tests/test.sh` (the verifier: resets the test surface, applies
     the hidden tests, runs them, checks fail_to_pass ∪ pass_to_pass);
  4. read `/logs/verifier/reward.txt` (1 resolved, 0 not).

The task's declared limits are honoured (verifier timeout, CPUs, memory). Writes
`<out>/report.json` (`resolved_ids`, `unresolved_ids`, `error_ids`) and one log
per instance. An infrastructure failure (image pull, container start, missing
reward file) is an error, never a 0. Nothing here is submitted anywhere.
"""

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import tomllib

APPLY = (
    "cd /app 2>/dev/null || cd /testbed; git apply --verbose /tmp/replay.patch "
    "|| git apply --3way /tmp/replay.patch || patch --fuzz=3 -p1 -i /tmp/replay.patch"
)


def sh(argv, timeout=None, stdin=None):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, input=stdin)


def task_meta(task_dir):
    with open(os.path.join(task_dir, "task.toml"), "rb") as f:
        t = tomllib.load(f)
    env = t.get("environment", {})
    return {
        "image": env["docker_image"],
        "cpus": env.get("cpus", 1),
        "memory_mb": env.get("memory_mb", 4096),
        "timeout": float(t.get("verifier", {}).get("timeout_sec", 3000)),
    }


def gold_patch(task_dir):
    p = os.path.join(task_dir, "solution", "gold_patch.diff")
    return open(p).read() if os.path.exists(p) else ""


def grade_one(rt, task_dir, iid, patch, out):
    meta = task_meta(task_dir)
    # Instance ids share long version suffixes, so name containers by a hash of the whole id.
    name = f"marina-pro-grade-{hashlib.sha256(iid.encode()).hexdigest()[:16]}-{os.getpid()}"
    log = [f"# {iid}", f"image {meta['image']}"]
    result = {"instance_id": iid, "status": "error"}
    try:
        r = sh([rt, "image", "exists", meta["image"]])
        if r.returncode != 0:
            r = sh([rt, "pull", "-q", meta["image"]], timeout=3600)
            log.append(f"pull rc {r.returncode} {r.stderr[-400:]}")
            if r.returncode != 0:
                return result, log
        r = sh([rt, "create", "--name", name, "--entrypoint", "sleep",
                "--cpus", str(meta["cpus"]), "--memory", f"{meta['memory_mb']}m",
                meta["image"], "infinity"])
        if r.returncode != 0:
            log.append(f"create failed: {r.stderr[-600:]}")
            return result, log
        sh([rt, "start", name])
        r = sh([rt, "cp", os.path.join(task_dir, "tests"), f"{name}:/tests"])
        if r.returncode != 0:
            log.append(f"cp tests failed: {r.stderr[-400:]}")
            return result, log
        if patch.strip():
            with tempfile.NamedTemporaryFile("w", suffix=".patch", delete=False) as f:
                f.write(patch if patch.endswith("\n") else patch + "\n")
                pf = f.name
            sh([rt, "cp", pf, f"{name}:/tmp/replay.patch"])
            os.unlink(pf)
            r = sh([rt, "exec", name, "bash", "-c", APPLY], timeout=300)
            log.append(f"apply rc {r.returncode}\n{(r.stdout + r.stderr)[-3000:]}")
            result["apply_rc"] = r.returncode
        else:
            log.append("empty patch: nothing applied")
            result["apply_rc"] = None
        try:
            r = sh([rt, "exec", name, "bash", "/tests/test.sh"], timeout=meta["timeout"])
            log.append(f"verifier rc {r.returncode}\n{(r.stdout + r.stderr)[-6000:]}")
        except subprocess.TimeoutExpired:
            log.append(f"verifier timed out after {meta['timeout']} s")
            result["status"] = "unresolved"
            result["timeout"] = True
            return result, log
        r = sh([rt, "exec", name, "cat", "/logs/verifier/reward.txt"])
        reward = r.stdout.strip()
        if reward not in ("0", "1"):
            log.append(f"no reward file ({r.stderr.strip()[-200:]})")
            return result, log
        result["status"] = "resolved" if reward == "1" else "unresolved"
        return result, log
    except subprocess.TimeoutExpired as e:
        log.append(f"infrastructure timeout: {e}")
        return result, log
    finally:
        sh([rt, "rm", "-f", "-t", "5", name])
        os.makedirs(os.path.join(out, "logs"), exist_ok=True)
        with open(os.path.join(out, "logs", f"{iid}.log"), "w") as f:
            f.write("\n".join(log) + f"\nstatus {result['status']}\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--predictions")
    ap.add_argument("--ids", help="file of instance ids (with --gold/--empty)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--runtime", default="podman")
    ap.add_argument("--workers", type=int, default=2)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--gold", action="store_true", help="self-check: grade the reference patch")
    mode.add_argument("--empty", action="store_true", help="self-check: grade an empty patch")
    a = ap.parse_args()
    if a.gold or a.empty:
        ids = [x for x in open(a.ids).read().split() if x]
        preds = {i: (gold_patch(os.path.join(a.tasks, i)) if a.gold else "") for i in ids}
    else:
        preds = {}
        for line in open(a.predictions):
            if line.strip():
                p = json.loads(line)
                preds[p["instance_id"]] = p.get("model_patch") or ""
    missing = [i for i in preds if not os.path.isdir(os.path.join(a.tasks, i))]
    if missing:
        print(f"unknown task ids: {missing[:5]}", file=sys.stderr)
        return 2
    os.makedirs(a.out, exist_ok=True)
    results = []
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(grade_one, a.runtime, os.path.join(a.tasks, i), i, p, a.out): i
                for i, p in preds.items()}
        for fut in cf.as_completed(futs):
            res, _ = fut.result()
            results.append(res)
            print(f"{res['instance_id']}: {res['status']}", flush=True)
    by = lambda s: sorted(r["instance_id"] for r in results if r["status"] == s)  # noqa: E731
    report = {
        "grader": "swebench-pro-v2 verifier (tests/test.sh), local patch replay",
        "submitted_instances": len(preds),
        "resolved_ids": by("resolved"),
        "unresolved_ids": by("unresolved"),
        "error_ids": by("error"),
        "timeouts": sorted(r["instance_id"] for r in results if r.get("timeout")),
    }
    with open(os.path.join(a.out, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: len(v) if isinstance(v, list) else v for k, v in report.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
