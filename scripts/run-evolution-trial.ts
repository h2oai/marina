import { assessEvolutionQualification } from "../src/engine/evolution-qualification";
import { MarinaClient, type Perception } from "../src/sdk/client";

const baseUrl = (process.argv[2] ?? process.env.MARINA_URL ?? "http://localhost:3300").replace(
  /\/$/,
  "",
);
const wsUrl = baseUrl.replace(/^http/, "ws");
const model = process.env.MARINA_TRIAL_MODEL ?? "openai/gpt-4o-mini";
const timeoutMs = Number(process.env.MARINA_TRIAL_TIMEOUT_MS) || 180_000;
const stamp = Date.now().toString(36);
const experiment = `LiveEvolution_${stamp}`;
const names = {
  proposer: `TP_${stamp}`,
  evaluator: `TE_${stamp}`,
  reviewer: `TR_${stamp}`,
};

function text(perceptions: Perception[]): string {
  return perceptions.map((item) => String(item.data?.text ?? "")).join("\n");
}

async function command(client: MarinaClient, value: string): Promise<string> {
  const output = text(await client.command(value));
  if (
    /\b(error|failed|cooldown|requires builder|permission denied|not found|no llm)\b/i.test(output)
  ) {
    throw new Error(`${value}: ${output}`);
  }
  return output;
}

async function loadSession(): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`${baseUrl}/api/evolution-sessions`);
  if (!response.ok) throw new Error(`evolution API returned HTTP ${response.status}`);
  const sessions = (await response.json()) as Array<Record<string, unknown>>;
  return sessions.find((item) => item.experiment_name === experiment);
}

async function waitForSession(
  predicate: (session: Record<string, unknown>) => boolean,
  stage: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs / 3;
  while (Date.now() < deadline) {
    const session = await loadSession();
    if (session && predicate(session)) return session;
    await Bun.sleep(2_000);
  }
  throw new Error(`live trial timed out during ${stage}`);
}

const operator = new MarinaClient(wsUrl, {
  autoReconnect: false,
  commandDrainTimeout: 800,
  connectTimeout: 15_000,
});

try {
  await operator.connect("Operator");
  for (const [role, name] of Object.entries(names)) {
    await command(
      operator,
      `agent spawn ${name} model ${model} role researcher goal Participate voluntarily as the ${role} in a bounded native evolution trial; use Marina tools and report evidence honestly`,
    );
    await Bun.sleep(1_200);
  }
  await command(
    operator,
    `experiment create ${experiment} arms baseline,candidate metric quality goal higher 3`,
  );

  for (const name of Object.values(names)) {
    await command(
      operator,
      `agent attention ${name} A controlled trial named ${experiment} is available. Decide whether to participate. If you consent, you must use marina_command to run experiment join ${experiment}, then tell Operator that you joined. Do not impersonate another role.`,
    );
  }

  const joinDeadline = Date.now() + Math.min(timeoutMs / 3, 60_000);
  let joined = false;
  while (Date.now() < joinDeadline) {
    const status = await command(operator, `experiment status ${experiment}`);
    if (Object.values(names).every((name) => status.includes(name))) {
      joined = true;
      break;
    }
    await Bun.sleep(2_000);
  }
  if (!joined) throw new Error("agents did not voluntarily join the experiment before timeout");

  await command(operator, `experiment start ${experiment}`);
  await command(
    operator,
    `evolve create ${experiment} | Test whether a concise collaboration protocol improves quality without suppressing autonomy | max-runs=3 | min-trials=2 | independent-review=true | guardrail=latency:lower`,
  );
  await command(operator, `evolve start ${experiment}`);

  await command(
    operator,
    `agent attention ${names.proposer} You consented as proposer for active ${experiment}. Call typed marina_evolve with action=propose, experiment=${experiment}, your own concise hypothesis, candidateRef=note:live-trial. If your runtime does not expose that typed tool, use the equivalent exact command: evolve propose ${experiment} | YOUR HYPOTHESIS | note:live-trial. A text-only answer does not perform the task. Do not evaluate or decide it.`,
  );
  await waitForSession(
    (session) => Array.isArray(session.runs) && session.runs.length > 0,
    "proposal",
  );
  await command(
    operator,
    `agent attention ${names.evaluator} You consented as independent evaluator for active ${experiment}. A proposal now exists. Inspect evolve status ${experiment}; record at least two baseline and two candidate quality observations with exact commands like experiment record ${experiment} baseline quality 0.70; then call marina_evolve action=evaluate with the observed runId and evidence. If unavailable, use evolve evaluate ${experiment} RUN_ID | YOUR EVIDENCE. Text alone does not perform the task. Do not decide it.`,
  );
  await waitForSession(
    (session) =>
      Array.isArray(session.runs) &&
      session.runs.some(
        (run) =>
          typeof run === "object" &&
          run !== null &&
          (run as { status?: string }).status === "evaluated",
      ),
    "evaluation",
  );
  await command(
    operator,
    `agent attention ${names.reviewer} You consented as independent reviewer for active ${experiment}. Attributed evaluation now exists. Inspect experiment results and evolve status, then call marina_evolve action=decide with the observed runId and accept or reject based on evidence. If unavailable, use evolve decide ${experiment} RUN_ID accept or reject. Text alone does not perform the task. Do not propose or evaluate it.`,
  );

  const deadline = Date.now() + timeoutMs;
  let session: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    session = await loadSession();
    if (session && assessEvolutionQualification([session]).qualified) break;
    await Bun.sleep(2_000);
  }
  if (!session) throw new Error("trial session was not visible through the evolution API");
  const report = assessEvolutionQualification([session]);
  const readiness = await fetch(`${baseUrl}/api/readiness`).then((response) => response.json());
  console.log(
    JSON.stringify(
      { qualified: report.qualified, experiment, model, agents: names, report, readiness, session },
      null,
      2,
    ),
  );
  if (!report.qualified) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  operator.disconnect();
}
await Bun.sleep(50);
process.exit(process.exitCode ?? 0);
