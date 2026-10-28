// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/** Run a predeclared private task corpus with the same external agent, durable
 * workspace and model limits, with and without a fresh production Marina. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseEnvironment } from "../src/config/environment";
import { MarinaClient } from "../src/sdk/client";
import {
  executeTool,
  fileHashes,
  parseToolArguments,
  requestFailureStatus,
  terminalTurnStatus,
  toolDefinitions,
  type VisibleCheck,
  workspacePath,
} from "./qualification/long-horizon-tools";

interface CaseSpec {
  id: string;
  family: string;
  initial_dir: string;
  phases: { phase: number; input_dir: string; prompt_file: string }[];
  checks_file: string;
  artifact_paths: string[];
}
interface Manifest {
  schema_version: number;
  image_digest: string;
  cases: CaseSpec[];
  run_order: { index: number; case_id: string; arm: "baseline" | "marina"; repetition: number }[];
}
type Message = Record<string, unknown>;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    manifest: { type: "string" },
    directory: { type: "string" },
    model: { type: "string" },
    "provider-env": { type: "string" },
    "runtime-root": { type: "string" },
    "runtime-inventory": { type: "string" },
    "budget-usd": { type: "string" },
    image: { type: "string" },
    catalog: { type: "string" },
    concurrency: { type: "string", default: "2" },
    "crash-after-phase": { type: "string" },
    "output-tokens": { type: "string", default: "16384" },
    "phase-timeout-ms": { type: "string", default: "900000" },
    "calls-per-phase": { type: "string", default: "32" },
  },
});
for (const key of [
  "manifest",
  "directory",
  "model",
  "provider-env",
  "runtime-root",
  "runtime-inventory",
  "budget-usd",
  "image",
  "catalog",
] as const)
  assert(values[key], `--${key} is required`);
const manifestPath = resolve(values.manifest!);
const corpus = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
assert.equal(values.image, manifest.image_digest, "Check image must match the frozen protocol");
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const freeze = JSON.parse(readFileSync(join(corpus, "FROZEN.json"), "utf8")) as {
  schema_version: number;
  manifest_sha256: string;
  files: { path: string; sha256: string; bytes: number }[];
  file_count: number;
  total_bytes: number;
  aggregate_sha256: string;
};
assert.equal(freeze.schema_version, 1);
assert.equal(freeze.manifest_sha256, sha(readFileSync(manifestPath)));
const corpusHashes = fileHashes(corpus);
delete corpusHashes["FROZEN.json"];
assert.deepEqual(
  Object.keys(corpusHashes).sort(),
  freeze.files.map((file) => file.path),
);
assert.equal(freeze.file_count, freeze.files.length);
assert.equal(
  freeze.total_bytes,
  freeze.files.reduce((sum, file) => sum + file.bytes, 0),
);
for (const file of freeze.files) {
  const bytes = readFileSync(workspacePath(corpus, file.path));
  assert.equal(bytes.byteLength, file.bytes, `Frozen size changed: ${file.path}`);
  assert.equal(sha(bytes), file.sha256, `Frozen content changed: ${file.path}`);
}
assert.equal(
  sha(freeze.files.map((file) => `${file.sha256}  ${file.path}\n`).join("")),
  freeze.aggregate_sha256,
);
const directory = resolve(values.directory!);
assert(!existsSync(directory), "Refuse to overwrite a previous attempt");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const model = values.model!;
const runtimeRoot = resolve(values["runtime-root"]!);
const runtimeInventory = JSON.parse(readFileSync(values["runtime-inventory"]!, "utf8")) as {
  provenance: { sources: { file: string; sha256: string }[] };
};
const runtimeSources = runtimeInventory.provenance.sources.filter((source) =>
  /^(?:src\/|worlds\/|config\/|package.json$|bun.lock$)/.test(source.file),
);
assert(runtimeSources.some((source) => source.file === "src/main.ts"));
for (const source of runtimeSources)
  assert.equal(
    sha(readFileSync(workspacePath(runtimeRoot, source.file))),
    source.sha256,
    `Runtime differs from inventory: ${source.file}`,
  );
const budget = Number(values["budget-usd"]);
assert(Number.isFinite(budget) && budget > 0);
const concurrency = Number(values.concurrency);
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4);
const crashAfterPhase = values["crash-after-phase"] ? Number(values["crash-after-phase"]) : null;
assert(crashAfterPhase === null || (Number.isInteger(crashAfterPhase) && crashAfterPhase > 0));
const apiKey = parseEnvironment(readFileSync(values["provider-env"]!, "utf8")).OPENROUTER_API_KEY;
assert(apiKey, "Configured OpenRouter key is required");
const catalog = JSON.parse(readFileSync(values.catalog!, "utf8")) as {
  data: { id: string; pricing: { prompt: string; completion: string } }[];
};
const price = catalog.data.find((row) => row.id === model)?.pricing;
assert(
  price && Number(price.prompt) > 0 && Number(price.completion) > 0,
  "Known selected-model prices required",
);
const json = (path: string, data: unknown) =>
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
for (const key of ["output-tokens", "phase-timeout-ms", "calls-per-phase"] as const)
  assert(
    Number.isSafeInteger(Number(values[key])) && Number(values[key]) > 0,
    `--${key} must be a positive integer`,
  );
const protocol = {
  version: 2,
  model,
  temperature: 0,
  callsPerPhase: Number(values["calls-per-phase"]),
  outputTokens: Number(values["output-tokens"]),
  phaseTimeoutMs: Number(values["phase-timeout-ms"]),
  image: values.image,
  runtimeRoot,
  runtimeInventorySha256: sha(readFileSync(values["runtime-inventory"]!)),
  runtimeSourcesSha256: sha(JSON.stringify(runtimeSources)),
  sdkClientSha256: sha(readFileSync(join(import.meta.dir, "../src/sdk/client.ts"))),
  manifestSha256: sha(readFileSync(manifestPath)),
  freezeSha256: sha(readFileSync(join(corpus, "FROZEN.json"))),
  corpusAggregateSha256: freeze.aggregate_sha256,
  runnerSha256: sha(readFileSync(import.meta.path)),
  toolsSha256: sha(readFileSync(join(import.meta.dir, "qualification/long-horizon-tools.ts"))),
  price,
  budget,
  concurrency,
  crashAfterPhase,
  baseline: "Same persistent files, previous inputs, JOURNAL.md and common tools; no Marina server",
  marina:
    "Same common tools plus allowlisted commands against a new production database; graceful restart every phase unless crashAfterPhase explicitly selects a separate stress treatment",
  contextBoundary:
    "Empty model message history each phase; no prior transcript or scorer feedback supplied",
};
json(join(directory, "protocol.json"), protocol);
cpSync(manifestPath, join(directory, "manifest.json"));
cpSync(join(corpus, "FROZEN.json"), join(directory, "FROZEN.json"));
json(join(directory, "runtime-sources.json"), runtimeSources);
let knownUsd = 0,
  unknownReservedUsd = 0,
  inFlightUsd = 0,
  calls = 0;
const receipts: Record<string, unknown>[] = [];
const results: Record<string, unknown>[] = [];
const upstreamIds = new Set<string>();

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const untilTime = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= untilTime) throw Error("Timed out waiting for production server");
    await Bun.sleep(50);
  }
}

class World {
  client?: MarinaClient;
  private child?: ReturnType<typeof Bun.spawn>;
  private token?: string;
  private port = 0;
  readonly lifecycle: Record<string, unknown>[] = [];
  constructor(private readonly path: string) {
    mkdirSync(path, { recursive: true });
  }
  async start(phase: number) {
    if (!this.port) {
      const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      this.port = listener.port!;
      await listener.stop(true);
    }
    this.child = Bun.spawn([process.execPath, "--no-env-file", join(runtimeRoot, "src/main.ts")], {
      cwd: runtimeRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        WS_HOST: "127.0.0.1",
        WS_PORT: String(this.port),
        MCP_PORT: "0",
        LOG_PORT: "0",
        TELNET_PORT: "0",
        MARINA_WORLD: "empty",
        MARINA_PROFILE: "local",
        MARINA_ROOM_AGENTS: "false",
        AGENT_AUTORESPAWN: "false",
        MARINA_LESSONS: "off",
        MARINA_DECISIONS: "off",
        DB_PATH: join(this.path, "world.db"),
        MARINA_DATA_DIR: this.path,
        ASSETS_DIR: join(this.path, "assets"),
        LOG_LEVEL: "warn",
      },
      stdout: Bun.file(join(this.path, `server-${phase}.stdout`)),
      stderr: Bun.file(join(this.path, `server-${phase}.stderr`)),
    });
    await until(async () => {
      if (this.child!.exitCode !== null)
        throw Error(`Production server exited ${this.child!.exitCode}`);
      try {
        return (
          await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {
        return false;
      }
    });
    this.client = new MarinaClient(`ws://127.0.0.1:${this.port}/ws`, {
      autoReconnect: false,
      pingInterval: 0,
      commandMode: "correlated",
      commandGrammar: "world",
    });
    const session = this.token
      ? await this.client.reconnect(this.token)
      : await this.client.connect("TaskAgent");
    this.token = session.token;
    this.lifecycle.push({
      phase,
      event: "connected",
      pid: this.child.pid,
      reconnected: phase > 1,
      at: Date.now(),
    });
  }
  async stop(phase: number, crash = false) {
    if (!this.child) return;
    this.client?.disconnect();
    this.client = undefined;
    this.child.kill(crash ? "SIGKILL" : "SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exit: number;
    try {
      exit = await Promise.race([
        this.child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("Production shutdown timed out")), 15000);
        }),
      ]);
    } catch (error) {
      this.child.kill("SIGKILL");
      await this.child.exited;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    this.lifecycle.push({
      phase,
      event: crash ? "forced-server-death" : "shutdown",
      exit,
      at: Date.now(),
    });
    this.child = undefined;
    if (!crash) assert.equal(exit, 0, "Production shutdown must succeed");
  }
}

async function run(spec: Manifest["run_order"][number]) {
  const task = manifest.cases.find((row) => row.id === spec.case_id)!;
  assert(task);
  const runId = `${String(spec.index).padStart(2, "0")}-${spec.case_id}-${spec.arm}-${spec.repetition}`;
  const path = join(directory, runId),
    workspace = join(path, "workspace");
  mkdirSync(path);
  cpSync(resolve(corpus, task.initial_dir), workspace, { recursive: true });
  const checks = (
    JSON.parse(readFileSync(resolve(corpus, task.checks_file), "utf8")) as {
      checks: VisibleCheck[];
    }
  ).checks;
  const protectedFiles = new Set(
    Object.keys(fileHashes(workspace)).filter(
      (p) => p.startsWith("tests/") || p === "check_submission.py",
    ),
  );
  const world = spec.arm === "marina" ? new World(join(path, "marina")) : undefined;
  const result: Record<string, unknown> = {
    ...spec,
    runId,
    model,
    family: task.family,
    startedAt: Date.now(),
    humanInterventions: 0,
    phases: [],
    knownUsd: 0,
    unknownReservedUsd: 0,
  };
  const phases = result.phases as Record<string, unknown>[];
  try {
    for (const phase of task.phases) {
      const phaseBegan = Date.now();
      cpSync(resolve(corpus, phase.input_dir), join(workspace, "inputs", `phase-${phase.phase}`), {
        recursive: true,
      });
      const before = fileHashes(workspace);
      for (const file of Object.keys(before))
        if (file.startsWith("inputs/")) protectedFiles.add(file);
      await world?.start(phase.phase);
      const modelBegan = Date.now(),
        deadline = modelBegan + protocol.phaseTimeoutMs;
      const trace: Record<string, unknown>[] = [];
      const phaseReport: Record<string, unknown> = {
        phase: phase.phase,
        startedAt: phaseBegan,
        modelStartedAt: modelBegan,
        calls: 0,
        status: "call-limit",
        toolErrors: 0,
      };
      phases.push(phaseReport);
      const messages: Message[] = [
        {
          role: "system",
          content: `Complete this phase's requested artifacts using the supplied tools. Prior inputs and files persist, but conversation history does not. Read JOURNAL.md and update it before finishing so a successor can resume. Read-only tools may be batched. Keep file writes small: one write per response, use append_file for chunks and edit_file for targeted revisions instead of rewriting large files. Supplied inputs and checks are immutable. Report unknown facts honestly, follow the evidence dates and corrections, and validate your artifacts. A textual promise is not a delivered file. You have at most ${protocol.callsPerPhase} model calls this phase. No hidden scores or solutions are available.`,
        },
        { role: "user", content: readFileSync(resolve(corpus, phase.prompt_file), "utf8") },
      ];
      for (let turn = 0; turn < protocol.callsPerPhase && Date.now() < deadline; turn++) {
        const body = {
          model,
          temperature: protocol.temperature,
          max_tokens: protocol.outputTokens,
          messages,
          tools: toolDefinitions(spec.arm === "marina", checks),
          tool_choice: "auto",
          usage: { include: true },
        };
        const requestJson = JSON.stringify(body);
        assert(Buffer.byteLength(requestJson) < 250000, "Matched input-size bound exceeded");
        const reserve =
          Buffer.byteLength(requestJson) * Number(price!.prompt) +
          protocol.outputTokens * Number(price!.completion);
        assert(
          knownUsd + unknownReservedUsd + inFlightUsd + reserve < budget,
          "Authorized comparison budget exhausted",
        );
        inFlightUsd += reserve;
        const receipt: Record<string, unknown> = {
          id: crypto.randomUUID(),
          runId,
          phase: phase.phase,
          turn,
          requestedModel: model,
          startedAt: Date.now(),
          requestSha256: sha(requestJson),
          reservedUsd: reserve,
        };
        calls++;
        phaseReport.calls = turn + 1;
        let settled = false;
        try {
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: requestJson,
            signal: AbortSignal.timeout(Math.max(1, Math.min(90000, deadline - Date.now()))),
          });
          const payload = (await response.json()) as {
            id?: string;
            model?: string;
            usage?: { cost?: number };
            choices?: { message?: Message; finish_reason?: string }[];
            error?: unknown;
          };
          receipt.httpStatus = response.status;
          receipt.upstreamId = payload.id;
          receipt.actualModel = payload.model;
          receipt.usage = payload.usage;
          const duplicate = !!payload.id && upstreamIds.has(payload.id);
          if (payload.id) upstreamIds.add(payload.id);
          if (duplicate) {
            receipt.duplicateUpstreamId = true;
            settled = true; // The original receipt owns the charge or unresolved reserve.
          }
          if (
            !duplicate &&
            typeof payload.usage?.cost === "number" &&
            Number.isFinite(payload.usage.cost) &&
            payload.usage.cost >= 0
          ) {
            knownUsd += payload.usage.cost;
            result.knownUsd = Number(result.knownUsd) + payload.usage.cost;
            settled = true;
          }
          trace.push({ turn, request: JSON.parse(requestJson), response: payload });
          json(join(path, `phase-${phase.phase}-trace.json`), trace);
          if (!response.ok || payload.error)
            throw Error(`Upstream response ${response.status}: ${JSON.stringify(payload.error)}`);
          assert.equal(payload.model, model, "Provider returned a different model");
          assert(payload.id && !duplicate, "Missing or reused upstream request ID");

          const message = payload.choices?.[0]?.message;
          assert(message, "Missing assistant message");
          messages.push(message);
          const toolCalls = message.tool_calls as
            | { id: string; function: { name: string; arguments: string } }[]
            | undefined;
          if (!toolCalls?.length) {
            phaseReport.status = terminalTurnStatus(
              payload.choices?.[0]?.finish_reason,
              message.content,
            );
            break;
          }
          for (const tool of toolCalls) {
            if (Date.now() >= deadline) {
              phaseReport.status = "deadline";
              break;
            }
            let answer: unknown;
            const toolBegan = Date.now();
            try {
              answer = await executeTool(
                {
                  workspace,
                  protectedFiles,
                  image: values.image!,
                  checks,
                  client: world?.client,
                  deadline,
                },
                tool.function.name,
                parseToolArguments(tool.function.arguments, payload.choices?.[0]?.finish_reason),
              );
            } catch (error) {
              answer = { error: String(error) };
              phaseReport.toolErrors = Number(phaseReport.toolErrors) + 1;
            }
            trace.push({ turn, tool: tool.function, answer, elapsedMs: Date.now() - toolBegan });
            messages.push({ role: "tool", tool_call_id: tool.id, content: JSON.stringify(answer) });
          }
        } catch (error) {
          receipt.error = String(error);
          phaseReport.status = requestFailureStatus(error, deadline);
          phaseReport.error = String(error);
          break;
        } finally {
          inFlightUsd -= reserve;
          if (!settled) {
            unknownReservedUsd += reserve;
            result.unknownReservedUsd = Number(result.unknownReservedUsd) + reserve;
          }
          receipt.completedAt = Date.now();
          receipt.accountingComplete = settled;
          receipts.push(receipt);
          json(join(directory, "receipts.json"), receipts);
          json(join(directory, "spend.json"), {
            knownUsd,
            unknownReservedUsd,
            inFlightUsd,
            calls,
            budget,
          });
        }
      }
      if (Date.now() >= deadline && phaseReport.status === "call-limit")
        phaseReport.status = "deadline";
      phaseReport.modelElapsedMs = Date.now() - modelBegan;
      const after = fileHashes(workspace);
      for (const file of protectedFiles)
        assert.equal(after[file], before[file], `Supplied file changed: ${file}`);
      phaseReport.changedFiles = Object.keys(after).filter((file) => after[file] !== before[file]);
      cpSync(workspace, join(path, "snapshots", `phase-${phase.phase}`), { recursive: true });
      phaseReport.snapshotHashes = after;
      json(join(path, `phase-${phase.phase}-trace.json`), trace);
      await world?.stop(phase.phase, phase.phase === crashAfterPhase);
      phaseReport.elapsedMs = Date.now() - phaseBegan;
      json(join(path, "result.json"), result);
      console.log(
        `${runId} phase${phase.phase}: ${phaseReport.status}, ${phaseReport.calls} calls`,
      );
    }
  } catch (error) {
    result.error = String(error);
  } finally {
    await world?.stop(0).catch((error) => {
      result.cleanupError = String(error);
    });
    result.completedAt = Date.now();
    result.elapsedMs = Number(result.completedAt) - Number(result.startedAt);
    result.lifecycle = world?.lifecycle ?? [];
    json(join(path, "result.json"), result);
    results.push(result);
    json(join(directory, "results.json"), results);
  }
}

let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < manifest.run_order.length) {
      const spec = manifest.run_order[next++]!;
      await run(spec);
    }
  }),
);
json(join(directory, "complete.json"), {
  completedAt: Date.now(),
  runs: results.length,
  planned: manifest.run_order.length,
  knownUsd,
  unknownReservedUsd,
  calls,
  status: "execution-complete-not-scored",
  privateScoringRequired: true,
});
console.log(
  JSON.stringify({ directory, runs: results.length, knownUsd, unknownReservedUsd, calls }),
);
