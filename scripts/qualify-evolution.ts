import {
  assessEvolutionQualification,
  type EvolutionQualificationSession,
} from "../src/engine/evolution-qualification";

const baseUrl = (process.argv[2] ?? process.env.MARINA_URL ?? "http://localhost:3300").replace(
  /\/$/,
  "",
);
const timeoutMs = Number(process.env.MARINA_QUALIFY_TIMEOUT_MS) || 120_000;
const pollMs = Math.max(500, Number(process.env.MARINA_QUALIFY_POLL_MS) || 2_000);
const deadline = Date.now() + timeoutMs;

let lastError: string | undefined;
let lastReport = assessEvolutionQualification([]);
while (Date.now() <= deadline) {
  try {
    const response = await fetch(`${baseUrl}/api/evolution-sessions`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const sessions = (await response.json()) as EvolutionQualificationSession[];
    lastReport = assessEvolutionQualification(sessions);
    if (lastReport.qualified) {
      console.log(JSON.stringify({ url: baseUrl, ...lastReport }, null, 2));
      process.exit(0);
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  await Bun.sleep(pollMs);
}

console.error(JSON.stringify({ url: baseUrl, ...lastReport, lastError }, null, 2));
process.exit(1);
