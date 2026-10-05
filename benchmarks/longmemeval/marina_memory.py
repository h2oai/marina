# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Marina memory backend for the official LongMemEval-V2 harness.

Marina (https://github.com/h2oai/marina) stores each trajectory as canonical,
versioned memory records in a fresh SQLite database per haystack and answers a
question with retrieved evidence (lexical FTS5 by default; hybrid when the
operator configured an embedding provider). This file is the whole adapter on
the harness side: it starts Marina's memory sidecar
(`benchmarks/longmemeval/memory-server.ts`, run with Bun) and speaks one JSON
object per line over its stdin/stdout.

memory_params:
  marina_root      path to a Marina checkout (default: $MARINA_ROOT)
  bun              Bun executable (default: "bun")
  mode             "lexical" (default) or "hybrid"
  search_limit     ranked records requested per question (default 40)
  context_bytes    reader context budget in bytes (default 160000)
  state_bytes      bytes per state in a retrieved slice (default 10000)
  episode_bytes    bytes per run summary (default 6000)
  radius           neighbouring states shown around a hit (default 1)
  work_dir         where the throwaway databases live (default: $TMPDIR)

The backend sees only what the harness gives every backend: full trajectories
on insert, and the question text (plus an optional image, unused) on query.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

from memory_modules.memory import Memory, MemoryContextItem, register_memory

DEFAULTS: dict[str, Any] = {
    "marina_root": None,
    "bun": "bun",
    "mode": "lexical",
    "search_limit": 40,
    "context_bytes": 160000,
    "state_bytes": 10000,
    "episode_bytes": 6000,
    "radius": 1,
    "work_dir": None,
}


@register_memory
class MarinaMemory(Memory):
    """LongMemEval-V2 backend backed by Marina's canonical memory records."""

    memory_type = "marina"

    def __init__(self, memory_params: dict[str, object]) -> None:
        unknown = set(memory_params) - set(DEFAULTS)
        if unknown:
            raise RuntimeError(f"unknown marina memory_params: {sorted(unknown)}")
        super().__init__(memory_params)
        self.params = {**DEFAULTS, **memory_params}
        if self.params["mode"] not in ("lexical", "hybrid"):
            raise RuntimeError("marina mode must be lexical or hybrid")
        root = self.params["marina_root"] or os.environ.get("MARINA_ROOT")
        if not root:
            raise RuntimeError("set memory_params.marina_root or MARINA_ROOT to a Marina checkout")
        self.root = Path(str(root)).expanduser().resolve()
        self.server = self.root / "benchmarks" / "longmemeval" / "memory-server.ts"
        if not self.server.exists():
            raise RuntimeError(f"Marina memory sidecar not found: {self.server}")
        self._lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None
        self._dir: str | None = None
        self._next_id = 0
        self.last_query: dict[str, Any] = {}

    # -- sidecar -----------------------------------------------------------------

    def _start(self) -> subprocess.Popen[str]:
        if self._proc is not None:
            return self._proc
        base = self.params["work_dir"] or os.environ.get("TMPDIR") or None
        self._dir = tempfile.mkdtemp(prefix="marina-lme-", dir=base)
        p = self.params
        argv = [
            str(p["bun"]),
            str(self.server),
            "--db",
            os.path.join(self._dir, "memory.db"),
            "--mode",
            str(p["mode"]),
            "--search-limit",
            str(int(p["search_limit"])),
            "--context-bytes",
            str(int(p["context_bytes"])),
            "--state-bytes",
            str(int(p["state_bytes"])),
            "--episode-bytes",
            str(int(p["episode_bytes"])),
            "--radius",
            str(int(p["radius"])),
        ]
        self._proc = subprocess.Popen(
            argv,
            cwd=str(self.root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        return self._proc

    def _call(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            proc = self._start()
            self._next_id += 1
            request = {"id": self._next_id, **request}
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError(f"Marina memory sidecar exited (code {proc.poll()})")
            reply = json.loads(line)
            if reply.get("id") != self._next_id:
                raise RuntimeError("Marina memory sidecar replied out of order")
            if not reply.get("ok"):
                raise RuntimeError(f"Marina memory: {reply.get('error')}")
            return reply

    # -- Memory interface ----------------------------------------------------------

    def insert(self, trajectory: dict[str, object]) -> None:
        self._call({"op": "insert", "trajectory": trajectory})

    def query(self, query: str, query_image: str | None = None) -> list[MemoryContextItem]:
        _ = query_image  # retrieval is text-only
        if self.params["mode"] == "hybrid" and not getattr(self, "_drained", False):
            self._call({"op": "drain"})
            self._drained = True
        reply = self._call({"op": "query", "query": query})
        self.last_query = {
            "hits": reply.get("hits"),
            "used_records": len(reply.get("used") or []),
            "degraded": reply.get("degraded") or [],
            "server_ms": reply.get("ms"),
        }
        items: list[MemoryContextItem] = []
        for item in reply.get("items") or []:
            value = item.get("value")
            if item.get("type") == "text" and isinstance(value, str) and value.strip():
                items.append({"type": "text", "value": value})
        return items

    def post_query_hook(self, *, query, query_image, memory_context):  # type: ignore[override]
        return dict(self.last_query)

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                if proc.stdin is not None:
                    proc.stdin.write(json.dumps({"id": -1, "op": "close"}) + "\n")
                    proc.stdin.flush()
                proc.wait(timeout=30)
            except Exception:  # noqa: BLE001 - shutting down regardless
                proc.kill()
        if self._dir:
            shutil.rmtree(self._dir, ignore_errors=True)
            self._dir = None

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:  # noqa: BLE001
            pass
