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
  retrieval        "unified" (default: Marina's resident retrieval path) or "raw"
                   (ungated search hits, the pilot's arm)
  gate             relevance gate: "off" (default), "observe" or "on" (unified only)
  gate_max         judged records kept at most by the gate (default 8)
  gate_backend     "auto" (default), "decisions", "model" or "mechanical"
  gate_model       chat model for the "model" backend (served by gate_base_url)
  gate_base_url    OpenAI-compatible /v1 for gate_model (default a local Marina)
  gate_api_key_env NAME of the env var holding that endpoint's key (default
                   OPENAI_API_KEY; the key itself never goes on a command line)
  search_limit     ranked records requested per question (default 40)
  context_bytes    reader context budget in bytes (default 160000)
  state_bytes      bytes per state in a retrieved slice (default 10000)
  episode_bytes    bytes per run summary (default 6000)
  radius           neighbouring states shown around a hit (default 1)
  work_dir         where the throwaway databases live (default: $TMPDIR)
  ingest_notes     "off" (default) or "on": write ingest-time notes per trajectory
  notes_model      chat model that writes the notes (served by notes_base_url);
                   unset = Marina's mechanical extractor, no model
  notes_base_url   OpenAI-compatible /v1 for notes_model (default a local Marina,
                   so the spend lands on its ledger)
  notes_api_key_env NAME of the env var holding that endpoint's key (default
                   OPENAI_API_KEY; never the key itself)
  notes_max_bytes  bytes of each trajectory's compact view sent to the writer
                   (default 48000)

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
    "retrieval": "unified",
    "gate": "off",
    "gate_max": 8,
    "gate_backend": "auto",
    "gate_model": None,
    "gate_base_url": "http://localhost:3300/v1",
    "gate_api_key_env": "OPENAI_API_KEY",
    "search_limit": 40,
    "context_bytes": 160000,
    "state_bytes": 10000,
    "episode_bytes": 6000,
    "radius": 1,
    "work_dir": None,
    "ingest_notes": "off",
    "notes_model": None,
    "notes_base_url": "http://localhost:3300/v1",
    "notes_api_key_env": "OPENAI_API_KEY",
    "notes_max_bytes": 48000,
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
        if self.params["retrieval"] not in ("unified", "raw"):
            raise RuntimeError("marina retrieval must be unified or raw")
        if self.params["gate"] not in ("off", "observe", "on"):
            raise RuntimeError("marina gate must be off, observe or on")
        if self.params["gate"] != "off" and self.params["retrieval"] != "unified":
            raise RuntimeError("the marina relevance gate needs retrieval=unified")
        if self.params["gate_backend"] not in ("auto", "decisions", "model", "mechanical"):
            raise RuntimeError("marina gate_backend must be auto, decisions, model or mechanical")
        if self.params["ingest_notes"] not in ("off", "on"):
            raise RuntimeError("marina ingest_notes must be off or on")
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

    def argv(self, db_path: str) -> list[str]:
        """The sidecar command line (no secrets: keys are read from the environment)."""
        p = self.params
        argv = [
            str(p["bun"]),
            str(self.server),
            "--db",
            db_path,
            "--mode",
            str(p["mode"]),
            "--retrieval",
            str(p["retrieval"]),
            "--gate",
            str(p["gate"]),
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
        if p["gate"] != "off":
            argv += [
                "--gate-max",
                str(int(p["gate_max"])),
                "--gate-backend",
                str(p["gate_backend"]),
                "--gate-base-url",
                str(p["gate_base_url"]),
                "--gate-api-key-env",
                str(p["gate_api_key_env"]),
            ]
            if p["gate_model"]:
                argv += ["--gate-model", str(p["gate_model"])]
        if p["ingest_notes"] == "on":
            argv += [
                "--ingest-notes",
                "on",
                "--notes-base-url",
                str(p["notes_base_url"]),
                "--notes-api-key-env",
                str(p["notes_api_key_env"]),
                "--notes-max-bytes",
                str(int(p["notes_max_bytes"])),
            ]
            if p["notes_model"]:
                argv += ["--notes-model", str(p["notes_model"])]
        return argv

    def _start(self) -> subprocess.Popen[str]:
        if self._proc is not None:
            return self._proc
        base = self.params["work_dir"] or os.environ.get("TMPDIR") or None
        self._dir = tempfile.mkdtemp(prefix="marina-lme-", dir=base)
        argv = self.argv(os.path.join(self._dir, "memory.db"))
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
            "retrieval": reply.get("retrieval"),
        }
        relevance = reply.get("relevance")
        if isinstance(relevance, dict):
            # Numbers only: what the gate judged and dropped (or would drop).
            keys = ("mode", "backend", "outcome", "reason", "candidates", "scored", "kept", "none")
            summary = {k: relevance[k] for k in keys if relevance.get(k) is not None}
            summary["dropped"] = len(relevance.get("dropped") or [])
            for k in ("calls", "latencyMs", "costUsd"):
                if relevance.get(k) is not None:
                    summary[k] = relevance[k]
            self.last_query["relevance"] = summary
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
