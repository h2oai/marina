// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Task Worker — lightweight in-world agent that claims + solves benchmark
 * tasks. Polls for unclaimed bounty tasks in its project, claims one, does
 * an LLM call via its configured substrate, and submits.
 *
 * Spawn multiple of these with different substrates and roles to create
 * genuine in-world competition over tasks. The coordinator's task_approve
 * gates which workers are trusted — combined with Marina's entity_activity
 * tracking, competent workers rank up over time.
 *
 * This is a pragmatic Stage 3: uses real project/task/claim/submit machinery
 * without the full tick-based agent-runtime cognition (which can meander).
 * Upgrade path: replace this with a role=scholar agent-runtime spawn for
 * real autonomous behavior.
 *
 * Env:
 *   WORKER_NAME       — agent name (default Worker1)
 *   WORKER_SUBSTRATE  — model to answer via (default marina:haiku)
 *   PROJECT_NAME      — project to watch (default benchmark-pursuit)
 *   POLL_INTERVAL_MS  — poll rate for open tasks (default 1500)
 *   CLAIM_COOLDOWN_MS — after a claim+submit, rest this long (default 500)
 *   WORKER_TRACE      — "true" logs per-task activity
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.WORKER_NAME ?? "Worker1";
const SUBSTRATE = process.env.WORKER_SUBSTRATE ?? "marina:haiku";
const PROJECT_NAME = process.env.PROJECT_NAME ?? "benchmark-pursuit";
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "1500", 10);
const CLAIM_COOLDOWN_MS = Number.parseInt(process.env.CLAIM_COOLDOWN_MS ?? "500", 10);
const TRACE = process.env.WORKER_TRACE === "true";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (t: string) => t.replace(ANSI_RE, "");

function perceptionsToText(ps: Perception[]): string {
  return ps
    .map((p) => (typeof p.data?.text === "string" ? (p.data.text as string) : ""))
    .map(stripAnsi)
    .filter((t) => t.length > 0)
    .join("\n");
}

async function callMarina(userMsg: string, systemMsg?: string): Promise<string> {
  const messages = [
    ...(systemMsg ? [{ role: "system", content: systemMsg }] : []),
    { role: "user", content: userMsg },
  ];
  const resp = await fetch(`${MARINA_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: SUBSTRATE, messages, temperature: 0 }),
  });
  if (!resp.ok) throw new Error(`Marina ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

/** Parse `task list` output for open bounty tasks. Very forgiving — looks
 *  for "#N" lines that include "open" or "bounty". */
interface TaskBrief {
  id: number;
  title: string;
  status: string;
}

async function fetchOpenTasks(agent: MarinaAgent): Promise<TaskBrief[]> {
  // task list open bounty — in this project. Filter command args vary by version.
  const out = perceptionsToText(await agent.command("task list open"));
  const tasks: TaskBrief[] = [];
  for (const line of out.split("\n")) {
    // Expected rough shape: "  #42 [open] Some title ..."
    const m = line.match(/#(\d+)[^\n]*?\b(open|bounty|available)\b[^\n]*?(.*)?/i);
    if (m) {
      const id = Number.parseInt(m[1]!, 10);
      tasks.push({ id, title: m[3] ?? "", status: m[2]!.toLowerCase() });
    } else {
      // Fallback: any line with #N
      const m2 = line.match(/#(\d+)[^\n]*$/);
      if (m2) {
        tasks.push({ id: Number.parseInt(m2[1]!, 10), title: line, status: "unknown" });
      }
    }
  }
  // Deduplicate by id
  const seen = new Set<number>();
  return tasks.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
}

async function getTaskDetails(agent: MarinaAgent, taskId: number): Promise<string> {
  return perceptionsToText(await agent.command(`task info ${taskId}`));
}

async function claimTask(agent: MarinaAgent, taskId: number): Promise<boolean> {
  const out = perceptionsToText(await agent.command(`task claim ${taskId}`));
  return !/already claimed|not found|cannot/i.test(out);
}

async function submitTask(agent: MarinaAgent, taskId: number, text: string): Promise<void> {
  const safe = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
  await agent.command(`task submit ${taskId} ${safe}`);
}

async function workOnTask(agent: MarinaAgent, taskId: number, info: string): Promise<boolean> {
  // Extract the question from the task description block. Task info shows:
  // "Task #42: <title>\n<status line>\n---\n<description>\n..."
  // We try to find the "QUESTION:" marker first; fall back to the description body.
  let question = info;
  const qMarker = info.match(/QUESTION:\s*([\s\S]+?)(?:\n\n|Submit your final|$)/i);
  if (qMarker) question = qMarker[1]!.trim();

  let systemMsg = "";
  const cMarker = info.match(/CONTEXT:\s*([\s\S]+?)\n\nQUESTION:/i);
  if (cMarker) systemMsg = cMarker[1]!.trim();

  try {
    const answer = await callMarina(question, systemMsg);
    await submitTask(agent, taskId, answer);
    if (TRACE)
      console.log(
        `[${AGENT_NAME}] submitted task#${taskId}: ${answer.slice(0, 60).replace(/\n/g, " ")}`,
      );
    return true;
  } catch (e) {
    if (TRACE) console.error(`[${AGENT_NAME}] task#${taskId} failed:`, e);
    return false;
  }
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true, commandDrainTimeout: 2000 });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[${AGENT_NAME}] logged in as ${session.name} (${session.entityId})`);
  console.log(`[${AGENT_NAME}] substrate=${SUBSTRATE} project=${PROJECT_NAME}`);

  // Track tasks we've attempted to avoid retry spam on rejects.
  const attempted = new Set<number>();
  let _completed = 0;

  while (true) {
    try {
      const tasks = await fetchOpenTasks(agent);
      const todo = tasks.filter((t) => !attempted.has(t.id));
      if (todo.length > 0) {
        const pick = todo[0]!;
        attempted.add(pick.id);
        const info = await getTaskDetails(agent, pick.id);
        // Only claim bounty tasks (bounty = any-claimant; others are private)
        if (!/bounty/i.test(info)) {
          if (TRACE) console.log(`[${AGENT_NAME}] skip #${pick.id} (not bounty)`);
          continue;
        }
        const claimed = await claimTask(agent, pick.id);
        if (!claimed) {
          if (TRACE) console.log(`[${AGENT_NAME}] claim failed for #${pick.id}`);
          continue;
        }
        const ok = await workOnTask(agent, pick.id, info);
        if (ok) _completed++;
        await new Promise((r) => setTimeout(r, CLAIM_COOLDOWN_MS));
      } else {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (e) {
      console.error(`[${AGENT_NAME}] loop error:`, e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((e) => {
  console.error(`[${AGENT_NAME}] fatal:`, e);
  process.exit(1);
});
