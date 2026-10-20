// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Native task runner — the sweep's lane method for generated instances.
 *
 * Against a running server it (1) reads the crew roster from the world DB,
 * (2) generates the instance for that roster, (3) applies the setup as the
 * Operator over one WebSocket session (pool create / pool add / private
 * `tell`s; files are written into the code workspace directory), (4)
 * dispatches with `crew dispatch <crew> <text>`, (5) polls the deliverable
 * pool in the DB exactly like lane.sh's `count_notes`, waits SETTLE seconds
 * for the protocol tail, and (6) scores the FIRST matching note with the
 * generator's oracle. Optional fault: `agent stop <member>` mid-task.
 *
 * Every live run then (7) scores the crew's formation adherence over the run
 * window from the live brief (`CREW_BRIEFS`, `formation-adherence.ts`) and
 * (8) files the run into the server's benchmark ledger as a `crew` run
 * (`POST /v1/benchmarks/runs`, key `MARINA_LEDGER_API_KEY`), so resident work
 * reaches route evidence, promotion and formation lessons like every harness
 * run. `--no-file` turns filing off; `--file-to <url>` files elsewhere.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { cachedParticipantToken, saveParticipantToken } from "../../scripts/session-cache";
import { formatPerception } from "../../src/net/formatter";
import { MarinaAgent } from "../../src/sdk/client";
import { loadTranscript, scoreWindow, summarizeAdherence } from "../formation-adherence";
import { type LedgerFileOutcome, postLedgerBody } from "../ledger-file";
import { GENERATORS } from "./index";
import type { GenerateOptions, NativeInstance, NativeScore, NativeTaskId } from "./shared";

export interface DeliverableNote {
  id: number;
  content: string;
  created_at: number;
}

/** Crew roster from the world DB: lead first, then by name. */
export function loadCrewMembers(dbPath: string, crew: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT m.agent_name AS name, m.role AS role FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE c.name = ?",
      )
      .all(crew) as { name: string; role: string }[];
    return rows
      .sort((a, b) =>
        a.role === "lead" ? -1 : b.role === "lead" ? 1 : a.name.localeCompare(b.name),
      )
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

/** The crew's current formation in the world DB, or undefined (no such crew). */
export function loadCrewFormation(dbPath: string, crew: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT formation FROM crews WHERE name = ?").get(crew) as {
      formation?: string | null;
    } | null;
    return row?.formation ?? undefined;
  } catch {
    // An older DB without the column (or the table): the formation is unknown.
    return undefined;
  } finally {
    db.close();
  }
}

/** Notes in `pool` whose content matches `pattern` (lane.sh `count_notes` semantics). */
export function readDeliverables(dbPath: string, pool: string, pattern: string): DeliverableNote[] {
  const re = new RegExp(pattern);
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT n.id AS id, n.content AS content, n.created_at AS created_at FROM numeric_notes n JOIN memory_pools p ON n.pool_id = p.id WHERE p.name = ? ORDER BY n.id",
      )
      .all(pool) as DeliverableNote[];
    return rows.filter((r) => re.test(r.content ?? ""));
  } catch {
    // The deliverable pool may not exist yet; nothing deposited.
    return [];
  } finally {
    db.close();
  }
}

/** One Operator WebSocket session, identity-preserving like scripts/connect.ts. */
export class OperatorSession {
  private constructor(
    private readonly agent: MarinaAgent,
    readonly url: string,
  ) {}

  static async open(url: string, name = "Operator"): Promise<OperatorSession> {
    const agent = new MarinaAgent(url, { autoReconnect: false });
    const cached = cachedParticipantToken(name, url);
    let session: Awaited<ReturnType<MarinaAgent["connect"]>>;
    if (cached) {
      try {
        session = await agent.reconnect(cached);
      } catch {
        session = await agent.connect(name);
      }
    } else session = await agent.connect(name);
    if (session.token) {
      try {
        saveParticipantToken(name, url, session.token);
      } catch {
        // Non-fatal: the next run logs in fresh.
      }
    }
    return new OperatorSession(agent, url);
  }

  async cmd(text: string): Promise<string> {
    const out = await this.agent.command(text);
    return out
      .map((p) => formatPerception(p, "plaintext"))
      .filter(Boolean)
      .join("\n");
  }

  close(): void {
    this.agent.disconnect();
  }
}

function safeJoin(root: string, rel: string): string {
  const full = resolve(root, rel);
  const r = relative(resolve(root), full);
  if (isAbsolute(r) || r.startsWith("..")) throw new Error(`path escapes workspace: ${rel}`);
  return full;
}

/** Apply an instance's setup steps. Returns a log of what was done. */
export async function applySetup(
  session: OperatorSession,
  inst: NativeInstance<unknown>,
  workspace?: string,
): Promise<string[]> {
  const log: string[] = [];
  const created = new Set<string>();
  const ensurePool = async (pool: string) => {
    if (created.has(pool)) return;
    created.add(pool);
    log.push(`pool create ${pool}: ${(await session.cmd(`pool create ${pool}`)).split("\n")[0]}`);
  };
  await ensurePool(inst.pool);
  for (const step of inst.setup) {
    if (step.kind === "pool") await ensurePool(step.pool);
    else if (step.kind === "pool-note") {
      await ensurePool(step.pool);
      log.push(
        `pool add ${step.pool}: ${(await session.cmd(`pool ${step.pool} add ${step.text}`)).split("\n")[0]}`,
      );
    } else if (step.kind === "private") {
      log.push(
        `tell ${step.member}: ${(await session.cmd(`tell ${step.member} ${step.text}`)).split("\n")[0]?.slice(0, 80)}`,
      );
    } else if (step.kind === "file") {
      if (!workspace) throw new Error(`task ${inst.task} writes files: pass --workspace <dir>`);
      const full = safeJoin(workspace, step.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, step.content);
      log.push(`file ${step.path} (${step.content.length} B)`);
    }
  }
  return log;
}

export function readScoreFiles(
  inst: NativeInstance<unknown>,
  workspace?: string,
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const p of inst.scoreFiles ?? []) {
    if (!workspace) continue;
    try {
      files[p] = readFileSync(safeJoin(workspace, p), "utf8");
    } catch {
      // Missing file: the oracle reports it unreadable.
    }
  }
  return files;
}

export interface RunOptions {
  task: NativeTaskId;
  seed: number;
  port: number;
  db: string;
  crew?: string;
  formation?: string;
  members?: string[];
  workspace?: string;
  crash?: boolean;
  deadlineSec?: number;
  pollSec?: number;
  settleSec?: number;
  hab?: string;
  win?: string;
  log?: (s: string) => void;
  /** Ledger to file into (default: the server the run used, `http://localhost:<port>`). */
  fileTo?: string;
  /** Never file the run. */
  noFile?: boolean;
  /** Ledger credential (default `MARINA_LEDGER_API_KEY`). */
  ledgerKey?: string;
  /** Ledger replicate group for the run. */
  group?: string;
}

/** Formation adherence of the run window (brief steps headline; conventions diagnostic). */
export interface NativeAdherence {
  formation: string;
  brief: number | null;
  convention: number | null;
  /** Brief steps left to a judge (scored null here). */
  judgeSteps: number;
}

export interface RunResult {
  task: NativeTaskId;
  seed: number;
  tag: string;
  formation: string;
  members: string[];
  found: boolean;
  elapsedSec: number;
  notes: number;
  start: number;
  end: number;
  deliverable?: string;
  fault?: { member: string; afterSeconds: number; reply?: string };
  result: NativeScore;
  adherence?: NativeAdherence;
  ledger?: LedgerFileOutcome;
}

/** The crew's adherence to its formation's live brief over `[start, end]` (epoch s). */
export function nativeAdherence(o: {
  db: string;
  crew: string;
  formation: string;
  pool: string;
  start: number;
  end: number;
}): NativeAdherence | undefined {
  try {
    const tr = loadTranscript(o.db, {
      crew: o.crew,
      since: o.start * 1000,
      until: o.end * 1000,
      pool: o.pool,
    });
    const results = scoreWindow(tr, o.formation);
    return {
      formation: o.formation,
      ...summarizeAdherence(results),
      judgeSteps: results.filter((r) => r.method === "judge").length,
    };
  } catch {
    // Unknown formation or an unreadable window: the run is still scored and filed.
    return undefined;
  }
}

/**
 * The ledger body for one native run: a `crew` target (crew, formation,
 * members), one item (the instance tag, the oracle's verdict and score), the
 * oracle as judge, the adherence summary in the config. Ids and numbers only —
 * never the deliverable text.
 */
export function nativeLedgerBody(
  res: RunResult,
  o: { crew: string; label?: string; group?: string },
) {
  const benchmark = `native-${res.task}`;
  const itemId = `${res.tag}${res.fault ? "-fault" : ""}`;
  return {
    targetKind: "crew" as const,
    target: { crew: o.crew, formation: res.formation, members: res.members },
    label: o.label ?? `native ${res.task} ${o.crew}/${res.formation}`,
    judge: `oracle:${benchmark}`,
    ...(o.group ? { replicateGroup: o.group } : {}),
    result: {
      config: {
        name: benchmark,
        dataset: benchmark,
        mode: "native",
        model: `marina:${o.crew}`,
        seed: res.seed,
        formation: res.formation,
        ...(res.fault
          ? { fault: { member: res.fault.member, afterSeconds: res.fault.afterSeconds } }
          : {}),
        ...(res.adherence ? { adherence: res.adherence } : {}),
      },
      timestamp: res.end * 1000,
      duration_ms: Math.max(0, res.end - res.start) * 1000,
      metadata: { total: 1, answered: res.found ? 1 : 0 },
      items: [
        {
          id: itemId,
          correct: res.result.correct,
          score: res.result.score,
          latencyMs: res.elapsedSec * 1000,
        },
      ],
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function generateFor(opts: {
  task: NativeTaskId;
  seed: number;
  members: string[];
  crash?: boolean;
}): NativeInstance<unknown> {
  const g = GENERATORS[opts.task];
  const gen: GenerateOptions = { members: opts.members, crash: opts.crash };
  return g.generate(opts.seed, gen);
}

export function resolveRoster(db: string, crew: string, members?: string[]): string[] {
  if (members && members.length > 0) return members;
  const roster = loadCrewMembers(db, crew);
  if (roster.length === 0) throw new Error(`crew "${crew}" has no members in ${db}`);
  return roster;
}

/** Score the first deliverable note for an instance (lane `--score-only`). */
export async function scoreFromDb(
  inst: NativeInstance<unknown>,
  db: string,
  workspace?: string,
): Promise<{ notes: DeliverableNote[]; result: NativeScore }> {
  const notes = readDeliverables(db, inst.pool, inst.deliverableRe);
  const first = notes[0];
  const result = first
    ? await GENERATORS[inst.task].score(first.content, inst.oracle, {
        files: readScoreFiles(inst, workspace),
      })
    : { correct: false, score: 0, details: { error: "no deliverable note" } };
  return { notes, result };
}

export async function runNative(o: RunOptions): Promise<RunResult> {
  const log = o.log ?? ((s: string) => process.stderr.write(`${s}\n`));
  const crew = o.crew ?? "answerer";
  const formation = o.formation ?? loadCrewFormation(o.db, crew) ?? "freeform";
  const members = resolveRoster(o.db, crew, o.members);
  const inst = generateFor({ task: o.task, seed: o.seed, members, crash: o.crash });
  const url = `ws://localhost:${o.port}`;
  const session = await OperatorSession.open(url);
  let faultReply: string | undefined;
  try {
    for (const line of await applySetup(session, inst, o.workspace)) log(`  setup ${line}`);
    const start = Math.floor(Date.now() / 1000);
    log(`--- ${formation} / ${inst.tag} ---`);
    log(
      `  dispatch: ${(await session.cmd(`crew dispatch ${crew} ${inst.text}`)).split("\n").pop()}`,
    );
    let faultTimer: ReturnType<typeof setTimeout> | undefined;
    if (o.crash && inst.fault) {
      const f = inst.fault;
      faultTimer = setTimeout(() => {
        session
          .cmd(`agent stop ${f.member}`)
          .then((r) => {
            faultReply = r.split("\n")[0];
            log(`  fault: agent stop ${f.member} → ${faultReply}`);
          })
          .catch((e) => log(`  fault failed: ${String(e)}`));
      }, f.afterSeconds * 1000);
    }
    const deadline = o.deadlineSec ?? 300;
    const poll = o.pollSec ?? 15;
    let elapsed = 0;
    let found = false;
    while (elapsed < deadline) {
      await sleep(poll * 1000);
      elapsed = Math.floor(Date.now() / 1000) - start;
      if (readDeliverables(o.db, inst.pool, inst.deliverableRe).length > 0) {
        found = true;
        break;
      }
    }
    if (found) await sleep((o.settleSec ?? 30) * 1000);
    if (faultTimer) clearTimeout(faultTimer);
    const end = Math.floor(Date.now() / 1000);
    const { notes, result } = await scoreFromDb(inst, o.db, o.workspace);
    const res: RunResult = {
      task: inst.task,
      seed: inst.seed,
      tag: inst.tag,
      formation,
      members,
      found,
      elapsedSec: elapsed,
      notes: notes.length,
      start,
      end,
      deliverable: notes[0]?.content,
      ...(inst.fault && o.crash ? { fault: { ...inst.fault, reply: faultReply } } : {}),
      result,
    };
    const adherence = nativeAdherence({ db: o.db, crew, formation, pool: inst.pool, start, end });
    if (adherence) {
      res.adherence = adherence;
      const fmt = (n: number | null) => (n === null ? "n/a" : n.toFixed(2));
      log(
        `    adherence ${formation}: brief ${fmt(adherence.brief)} (${adherence.judgeSteps} judge step(s) pending), conventions ${fmt(adherence.convention)}`,
      );
    }
    if (!o.noFile) {
      const fileTo = o.fileTo ?? `http://localhost:${o.port}`;
      res.ledger = await postLedgerBody(
        fileTo,
        o.ledgerKey ?? process.env.MARINA_LEDGER_API_KEY,
        nativeLedgerBody(res, { crew, ...(o.group ? { group: o.group } : {}) }),
      );
      log(
        res.ledger.ok
          ? `    ledger: ${res.ledger.created === false ? "already filed as" : "filed"} ${res.ledger.runId} @ ${fileTo}`
          : `    ledger: filing failed (${res.ledger.status}): ${res.ledger.error}`,
      );
    }
    if (o.hab)
      appendFileSync(
        o.hab,
        `${formation}\t${inst.tag}\t${found ? 1 : 0}\t${elapsed}\t${notes.length}\t${result.correct ? 1 : 0}\t${result.score.toFixed(4)}\n`,
      );
    if (o.win) appendFileSync(o.win, `${formation}\t${inst.tag}\t${start}\t${end}\n`);
    log(
      `    found=${found ? 1 : 0} notes=${notes.length} correct=${result.correct ? 1 : 0} score=${result.score.toFixed(3)} elapsed=${elapsed}s`,
    );
    return res;
  } finally {
    session.close();
  }
}

/** Shell-quote for `eval` in lane scripts. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Exact-answer regex for the lane's `ok` column, where the answer is unique. */
export function exactOkRe(inst: NativeInstance<unknown>): string {
  if (inst.task !== "csp" && inst.task !== "aggregation" && inst.task !== "pipeline") return "";
  return inst.answer
    .split(/\s*;\s*/)
    .map((p) =>
      p
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, " *")
        .replace(/=/g, " *= *"),
    )
    .join(" *; *");
}
