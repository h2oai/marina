// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

interface ReadinessResponse {
  generatedAt: number;
  demo: {
    autonomyQualified: boolean;
    activeAgents: number;
    recentPrimitiveActions: number;
    recentCommunications: number;
    marinaToolCalls: number;
    medianResponseMs?: number;
  };
}

const baseUrl = (process.argv[2] ?? process.env.MARINA_URL ?? "http://localhost:3300").replace(
  /\/$/,
  "",
);
const timeoutMs = Number(process.env.MARINA_QUALIFY_TIMEOUT_MS) || 120_000;
const pollMs = Math.max(500, Number(process.env.MARINA_QUALIFY_POLL_MS) || 2_000);
const deadline = Date.now() + timeoutMs;

let last: ReadinessResponse | undefined;
while (Date.now() <= deadline) {
  try {
    const response = await fetch(`${baseUrl}/api/readiness`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    last = (await response.json()) as ReadinessResponse;
    if (last.demo.autonomyQualified) {
      console.log(JSON.stringify({ qualified: true, url: baseUrl, ...last.demo }, null, 2));
      process.exit(0);
    }
  } catch (error) {
    if (Date.now() + pollMs > deadline) {
      console.error(`Qualification probe failed: ${error instanceof Error ? error.message : error}`);
      process.exit(2);
    }
  }
  await Bun.sleep(pollMs);
}

console.error(
  JSON.stringify(
    {
      qualified: false,
      url: baseUrl,
      timeoutMs,
      evidence: last?.demo ?? null,
      required: {
        activeAgents: 2,
        recentPrimitiveActions: 3,
        recentCommunications: 1,
        marinaToolCalls: 2,
        maximumMedianResponseMs: 30_000,
      },
    },
    null,
    2,
  ),
);
process.exit(1);
