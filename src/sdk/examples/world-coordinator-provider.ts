// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * World Coordinator Provider — every benchmark question becomes a real
 * Marina task in a real project. Worker agents in the world claim and
 * answer. This provider bridges the benchmark harness to the task lifecycle.
 *
 * Flow per model_request:
 *   1. Create a bounty task in `project:benchmark-pursuit` with the question
 *   2. Any connected task-worker agent (see task-worker.ts) can claim
 *   3. Worker submits via `task submit`
 *   4. Coordinator polls `task info` until a submission appears
 *   5. Coordinator `task approve`s the submission — triggers verifier chain
 *   6. Return submission text as the model response
 *
 * Fallback: if no worker claims within WORKER_TIMEOUT_MS, coordinator falls
 * back to calling the FALLBACK_SUBSTRATE directly and submits on its own
 * behalf. Benchmark harness never stalls.
 *
 * Env:
 *   PROJECT_NAME       — project for tasks (default benchmark-pursuit)
 *   WORKER_TIMEOUT_MS  — how long to wait for a worker (default 60000)
 *   POLL_INTERVAL_MS   — task info poll rate (default 2000)
 *   FALLBACK_SUBSTRATE — model to use if no worker claims (default marina:sonnet)
 */

import { MarinaAgent, type Perception } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const MARINA_ENDPOINT = (process.env.MARINA_ENDPOINT ?? "http://localhost:3300").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? "WorldCoordinator";
const MODEL_CHANNEL = process.env.MODEL_CHANNEL ?? "model";
const PROJECT_NAME = process.env.PROJECT_NAME ?? "benchmark-pursuit";
const WORKER_TIMEOUT_MS = Number.parseInt(process.env.WORKER_TIMEOUT_MS ?? "60000", 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "2000", 10);
const FALLBACK_SUBSTRATE = process.env.FALLBACK_SUBSTRATE ?? "marina:sonnet";
const TRACE = process.env.COORDINATOR_TRACE === "true";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (t: string) => t.replace(ANSI_RE, "");

function extractChannelPayload(
  text: string,
): { channel: string; sender: string; content: string } | undefined {
  const clean = stripAnsi(text);
  const match = clean.match(/^\[([^\]]+)\]\s+([^:]+):\s+(.*)/s);
  if (!match) return undefined;
  return { channel: match[1]!, sender: match[2]!.trim(), content: match[3]!.trim() };
}

function perceptionsToText(ps: Perception[]): string {
  return ps
    .map((p) => (typeof p.data?.text === "string" ? (p.data.text as string) : ""))
    .map(stripAnsi)
    .filter((t) => t.length > 0)
    .join("\n");
}

async function callMarina(model: string, userMsg: string, systemMsg?: string): Promise<string> {
  const messages = [
    ...(systemMsg ? [{ role: "system", content: systemMsg }] : []),
    { role: "user", content: userMsg },
  ];
  const resp = await fetch(`${MARINA_ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0 }),
  });
  if (!resp.ok) throw new Error(`Marina ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

/** Parse "Created task #N" from task create response. */
function parseTaskId(resp: string): number | null {
  const m = resp.match(/#(\d+)/);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/** Parse submissions from `task info` output.
 *  Format: "  <name>: submitted — \"<text>\"" or "  <name>: approved — \"<text>\"" */
function parseSubmissions(info: string): Array<{ claimant: string; status: string; text: string }> {
  const submissions: Array<{ claimant: string; status: string; text: string }> = [];
  const lines = info.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s+(\S+):\s+(\w+)(?:\s+—\s+"(.*)")?\s*$/);
    if (m) {
      submissions.push({ claimant: m[1]!, status: m[2]!, text: m[3] ?? "" });
    }
  }
  return submissions;
}

async function createTask(
  agent: MarinaAgent,
  question: string,
  systemContext: string,
): Promise<number | null> {
  const title = question.slice(0, 80).replace(/\|/g, " ").replace(/\n/g, " ");
  const desc = systemContext
    ? `CONTEXT: ${systemContext.slice(0, 500)}\n\nQUESTION:\n${question.slice(0, 3000)}\n\nSubmit your final answer.`
    : `${question.slice(0, 3500)}\n\nSubmit your final answer.`;
  const cmdOut = perceptionsToText(await agent.command(`task create ${title} | ${desc} !5 bounty`));
  return parseTaskId(cmdOut);
}

async function pollForSubmission(
  agent: MarinaAgent,
  taskId: number,
  timeoutMs: number,
): Promise<{ claimant: string; text: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const info = perceptionsToText(await agent.command(`task info ${taskId}`));
    const submissions = parseSubmissions(info);
    const submitted = submissions.find((s) => s.status === "submitted" && s.text);
    if (submitted) return { claimant: submitted.claimant, text: submitted.text };
    // Also catch approved directly (in case workflow faster than poll)
    const approved = submissions.find((s) => s.status === "approved" && s.text);
    if (approved) return { claimant: approved.claimant, text: approved.text };
  }
  return null;
}

async function approveTask(agent: MarinaAgent, taskId: number, claimant: string): Promise<void> {
  await agent.command(`task approve ${taskId} ${claimant}`);
}

async function handleRequest(
  agent: MarinaAgent,
  request: { id: string; content: string; context?: string },
): Promise<string> {
  const t0 = performance.now();

  // Step 1: create task
  const taskId = await createTask(agent, request.content, request.context ?? "");
  if (taskId === null) {
    if (TRACE) console.log(`[coordinator] ${request.id} task creation failed — fallback`);
    return callMarina(FALLBACK_SUBSTRATE, request.content, request.context);
  }
  if (TRACE) console.log(`[coordinator] ${request.id} created task #${taskId}`);

  // Step 2: poll for worker submission
  const submission = await pollForSubmission(agent, taskId, WORKER_TIMEOUT_MS);
  if (submission) {
    await approveTask(agent, taskId, submission.claimant);
    const dt = Math.round(performance.now() - t0);
    console.log(
      `[coordinator] ${request.id} task#${taskId} by ${submission.claimant} in ${dt}ms (worker path)`,
    );
    return submission.text;
  }

  // Step 3: fallback — coordinator self-submits via FALLBACK_SUBSTRATE
  if (TRACE)
    console.log(`[coordinator] ${request.id} no worker claim — fallback to ${FALLBACK_SUBSTRATE}`);
  const answer = await callMarina(FALLBACK_SUBSTRATE, request.content, request.context);
  const dt = Math.round(performance.now() - t0);
  console.log(
    `[coordinator] ${request.id} task#${taskId} fallback (${FALLBACK_SUBSTRATE}) in ${dt}ms`,
  );
  return answer;
}

async function ensureProject(agent: MarinaAgent): Promise<void> {
  try {
    await agent.command(`project create ${PROJECT_NAME}`);
  } catch {
    /* exists */
  }
  try {
    await agent.command(`project orchestrate ${PROJECT_NAME} plan-execute-verify`);
  } catch {
    /* already set */
  }
}

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true, commandDrainTimeout: 2500 });
  const session = await agent.connect(AGENT_NAME);
  console.log(`[coordinator] logged in as ${session.name} (${session.entityId})`);
  console.log(
    `[coordinator] project=${PROJECT_NAME} timeout=${WORKER_TIMEOUT_MS}ms fallback=${FALLBACK_SUBSTRATE}`,
  );

  await ensureProject(agent);
  await agent.command(`channel create ${MODEL_CHANNEL}`);
  await agent.command(`channel join ${MODEL_CHANNEL}`);

  agent.onPerception(async (p: Perception) => {
    if (p.kind !== "message" || !p.data?.text) return;
    const parsed = extractChannelPayload(p.data.text as string);
    if (!parsed || parsed.channel !== MODEL_CHANNEL || parsed.sender === session.name) return;

    let request: {
      type: string;
      id: string;
      content: string;
      target?: string;
      context?: string;
    };
    try {
      request = JSON.parse(parsed.content);
    } catch {
      return;
    }
    if (request.type !== "model_request") return;
    if (request.target && request.target !== session.entityId) return;

    try {
      const answer = await handleRequest(agent, request);
      await agent.channel(
        MODEL_CHANNEL,
        JSON.stringify({ type: "model_response", id: request.id, content: answer }),
      );
    } catch (err) {
      console.error(`[coordinator] ${request.id} error:`, err);
      await agent.channel(
        MODEL_CHANNEL,
        JSON.stringify({
          type: "model_response",
          id: request.id,
          content: `Error: ${String(err).slice(0, 200)}`,
        }),
      );
    }
  });

  process.on("SIGINT", () => {
    agent.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[coordinator] fatal:", e);
  process.exit(1);
});
