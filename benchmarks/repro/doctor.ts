// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bun run repro doctor` — prerequisites for reproducing a setup, each with the
 * exact fix. Keys are reported by NAME only, never by value. Every probe goes
 * through an injectable `Probe`, so the checks are unit-tested without touching
 * the machine.
 */

import type { ModelTier } from "./types";

export type CheckStatus = "ok" | "warn" | "missing";

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do, when not ok. */
  fix?: string;
}

/** Everything the doctor reads from the machine. */
export interface Probe {
  env: Record<string, string | undefined>;
  /** True when an executable is on PATH. */
  which(cmd: string): boolean;
  /** stdout of a short command, or undefined when it failed. */
  run(cmd: string[]): string | undefined;
  readFile(path: string): string | undefined;
  /** Free bytes and filesystem type at a path. */
  disk(path: string): { freeBytes: number; fsType: string } | undefined;
  exists(path: string): boolean;
  home: string;
  user: string;
}

/** Vendor keys that put a model behind Marina. Names only. */
export const VENDOR_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "HUGGINGFACE_API_KEY",
] as const;

/** Optional keys that change results; reported so a reproduction can match the original. */
export const OPTIONAL_KEYS: { name: string; effect: string }[] = [
  {
    name: "TAVILY_API_KEY",
    effect: "date-filtered web research (backtests can use keyless asof instead)",
  },
  { name: "ODDS_API_KEY", effect: "sports odds lookups (live only on the free plan)" },
  { name: "FRED_API_KEY", effect: "FRED official series as published at a past cutoff" },
  { name: "HF_TOKEN", effect: "gated Hugging Face datasets (e.g. GPQA)" },
];

const GB = 1024 ** 3;
const has = (env: Probe["env"], k: string) => typeof env[k] === "string" && env[k]!.length > 0;

/** Which intelligence is reachable: decides default models and honest labels. */
export function modelTier(env: Probe["env"]): ModelTier {
  if (has(env, "OPENROUTER_API_KEY")) return "frontier";
  const vendors = VENDOR_KEYS.filter((k) => has(env, k));
  // GEMINI_API_KEY and GOOGLE_API_KEY are the same vendor.
  const distinct = new Set(vendors.map((k) => (k === "GOOGLE_API_KEY" ? "GEMINI_API_KEY" : k)));
  if (distinct.size >= 2) return "frontier";
  if (distinct.size === 1) return "single-provider";
  if (has(env, "LLAMA_BASE_URL") || has(env, "OLLAMA_BASE_URL")) return "single-local";
  return "none";
}

function modelsCheck(p: Probe): Check {
  const tier = modelTier(p.env);
  const detail: Record<ModelTier, string> = {
    frontier: "multi-vendor (OpenRouter or ≥ 2 vendor keys) — published defaults apply",
    "single-provider":
      "one provider — every arm runs, verification is self-check, the judge is the same model",
    "single-local":
      "one local model (llama.cpp / Ollama) — every arm runs, labelled; pass --model llama/<id> or ollama/<id>",
    none: "no model reachable",
  };
  return {
    id: "models",
    title: "Model access",
    status: tier === "none" ? "missing" : tier === "frontier" ? "ok" : "warn",
    detail: `${detail[tier]}`,
    ...(tier === "none"
      ? {
          fix: "set OPENROUTER_API_KEY (or any vendor key) in .env, or run a local model and set OLLAMA_BASE_URL / LLAMA_BASE_URL",
        }
      : {}),
  };
}

function optionalKeysCheck(p: Probe): Check {
  const missing = OPTIONAL_KEYS.filter((k) => !has(p.env, k.name));
  return {
    id: "optional-keys",
    title: "Optional data keys",
    status: missing.length ? "warn" : "ok",
    detail: missing.length
      ? `not set: ${missing.map((k) => `${k.name} (${k.effect})`).join("; ")}`
      : "all set",
    ...(missing.length
      ? { fix: "add the keys you have to .env; results differ without them" }
      : {}),
  };
}

function containerCheck(p: Probe): Check {
  const runtime = p.which("podman") ? "podman" : p.which("docker") ? "docker" : undefined;
  if (!runtime) {
    return {
      id: "container-runtime",
      title: "Container runtime",
      status: "missing",
      detail: "neither podman nor docker is on PATH",
      fix: "install podman (rootless) or docker",
    };
  }
  const socket = p.env.DOCKER_HOST ?? "";
  const podmanSock = `/run/user/${p.env.UID ?? "1000"}/podman/podman.sock`;
  const ok = runtime === "docker" ? true : socket.length > 0 || p.exists(podmanSock);
  return {
    id: "container-runtime",
    title: "Container runtime",
    status: ok ? "ok" : "warn",
    detail: `${runtime}${runtime === "podman" ? (ok ? " (API socket available)" : " (no API socket)") : ""}`,
    ...(ok
      ? {}
      : {
          fix: `systemctl --user enable --now podman.socket && export DOCKER_HOST=unix://${podmanSock}`,
        }),
  };
}

function podmanNetworkCheck(p: Probe): Check {
  if (!p.which("podman")) {
    return {
      id: "podman-network",
      title: "Podman network mode",
      status: "ok",
      detail: "not using podman",
    };
  }
  const conf = p.readFile(`${p.home}/.config/containers/containers.conf`) ?? "";
  const pasta = /netns\s*=\s*"pasta"/.test(conf);
  const bridge = p.run(["podman", "info", "--format", "{{.Host.NetworkBackend}}"]);
  if (pasta) {
    return {
      id: "podman-network",
      title: "Podman network mode",
      status: "ok",
      detail: "netns = pasta",
    };
  }
  return {
    id: "podman-network",
    title: "Podman network mode",
    status: "warn",
    detail: `default network backend ${bridge?.trim() || "unknown"}; kernels without bridge support cannot start containers`,
    fix: `printf '[containers]\\nnetns = "pasta"\\n' >> ~/.config/containers/containers.conf`,
  };
}

/** Width of the user's subordinate UID range in /etc/subuid (0 when absent). */
export function subuidWidth(subuid: string | undefined, user: string): number {
  for (const line of (subuid ?? "").split("\n")) {
    const [name, , count] = line.trim().split(":");
    if (name === user && count) return Number(count) || 0;
  }
  return 0;
}

function subuidCheck(p: Probe): Check {
  const width = subuidWidth(p.readFile("/etc/subuid"), p.user);
  const enough = width >= 300_000;
  return {
    id: "subuid",
    title: "Sub-UID range (some SWE-bench images)",
    status: enough ? "ok" : "warn",
    detail: `${width.toLocaleString("en-US")} sub-UIDs for ${p.user}`,
    ...(enough
      ? {}
      : {
          fix: `sudo usermod --add-subuids 100000-399999 --add-subgids 100000-399999 ${p.user} && podman system migrate   (otherwise a few matplotlib instances are excluded)`,
        }),
  };
}

function tmpdirCheck(p: Probe, runDir: string): Check {
  const tmp = p.env.TMPDIR ?? "/tmp";
  const d = p.disk(tmp);
  const tmpfs = d?.fsType === "tmpfs" || d?.fsType === "ramfs";
  return {
    id: "tmpdir",
    title: "Scratch space",
    status: tmpfs ? "warn" : "ok",
    detail: `TMPDIR=${tmp} (${d?.fsType ?? "?"}, ${d ? (d.freeBytes / GB).toFixed(1) : "?"} GB free)`,
    ...(tmpfs
      ? {
          fix: `runs keep scratch under ${runDir} (on disk) automatically; for other jobs export TMPDIR to a disk path`,
        }
      : {}),
  };
}

function diskCheck(p: Probe, runDir: string, needGb: number): Check {
  const d = p.disk(runDir) ?? p.disk(p.home);
  const free = d ? d.freeBytes / GB : 0;
  return {
    id: "disk",
    title: "Disk for runs and images",
    status: free >= needGb ? "ok" : "warn",
    detail: `${free.toFixed(0)} GB free under ${runDir}`,
    ...(free >= needGb
      ? {}
      : {
          fix: `free space (SWE-bench images need up to ~1.5 TB at full size; run in batches with --limit, then podman image prune)`,
        }),
  };
}

function pythonSwebenchCheck(p: Probe): Check {
  const py = p.env.SWEBENCH_PYTHON ?? "python3";
  const v = p.run([py, "-c", "import swebench, sys; print(swebench.__version__)"]);
  return {
    id: "python-swebench",
    title: "SWE-bench harness",
    status: v ? "ok" : "missing",
    detail: v ? `${py}: swebench ${v.trim()}` : `${py} has no swebench package`,
    ...(v
      ? {}
      : {
          fix: "python3 -m venv ~/.cache/marina-swebench/venv && ~/.cache/marina-swebench/venv/bin/pip install swebench && export SWEBENCH_PYTHON=~/.cache/marina-swebench/venv/bin/python",
        }),
  };
}

function tau2Check(p: Probe): Check {
  const home = p.env.TAU2_HOME;
  const ok = !!home && p.exists(`${home}/.venv/bin/tau2`);
  return {
    id: "tau2",
    title: "τ²-bench",
    status: ok ? "ok" : "missing",
    detail: ok ? `TAU2_HOME=${home}` : "TAU2_HOME not set or has no .venv/bin/tau2",
    ...(ok
      ? {}
      : {
          fix: "git clone https://github.com/sierra-research/tau2-bench ~/.cache/tau2-bench && cd ~/.cache/tau2-bench && python3 -m venv .venv && .venv/bin/pip install -e . && export TAU2_HOME=~/.cache/tau2-bench",
        }),
  };
}

export interface DoctorOptions {
  runDir: string;
  /** Free disk (GB) wanted for the chosen setup. */
  needGb?: number;
  /** Restrict to these check ids (a setup's `requires`); default all. */
  only?: readonly string[];
}

export function doctor(p: Probe, opts: DoctorOptions): { tier: ModelTier; checks: Check[] } {
  const all: Record<string, () => Check> = {
    models: () => modelsCheck(p),
    "optional-keys": () => optionalKeysCheck(p),
    "container-runtime": () => containerCheck(p),
    "podman-network": () => podmanNetworkCheck(p),
    subuid: () => subuidCheck(p),
    tmpdir: () => tmpdirCheck(p, opts.runDir),
    disk: () => diskCheck(p, opts.runDir, opts.needGb ?? 20),
    "python-swebench": () => pythonSwebenchCheck(p),
    tau2: () => tau2Check(p),
  };
  const ids = opts.only?.length
    ? [
        ...new Set([
          ...opts.only,
          "optional-keys",
          ...(opts.only.includes("container-runtime") ? ["subuid"] : []),
        ]),
      ]
    : Object.keys(all);
  return {
    tier: modelTier(p.env),
    checks: ids.filter((id) => all[id]).map((id) => all[id]!()),
  };
}

/** True when nothing a plan requires is missing (warnings do not block). */
export function blocking(checks: readonly Check[]): Check[] {
  return checks.filter((c) => c.status === "missing");
}

export function renderChecks(tier: ModelTier, checks: readonly Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", missing: "MISS" };
  const lines = [`Model tier: ${tier}`, ""];
  for (const c of checks) {
    lines.push(`[${icon[c.status]}] ${c.title} — ${c.detail}`);
    if (c.fix) lines.push(`       fix: ${c.fix}`);
  }
  return lines.join("\n");
}
