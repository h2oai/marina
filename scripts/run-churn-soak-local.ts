const basePort = 46_000 + Math.floor(Math.random() * 500) * 4;
const stamp = `${process.pid}-${Date.now().toString(36)}`;
const baseUrl = `http://localhost:${basePort}`;
const server = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MARINA_WORLD: "empty",
    DB_PATH: `/tmp/marina-churn-${stamp}.db`,
    ASSETS_DIR: `/tmp/marina-churn-assets-${stamp}`,
    WS_PORT: String(basePort),
    MCP_PORT: String(basePort + 1),
    LOG_PORT: String(basePort + 2),
    TELNET_PORT: String(basePort + 3),
    MARINA_ENDPOINTS: "none",
    MARINA_OPEN_API: "true",
    AGENT_AUTORESPAWN: "false",
  },
  stdout: "inherit",
  stderr: "inherit",
});

try {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (server.exitCode !== null)
      throw new Error(`temporary Marina exited with ${server.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {}
    if (Date.now() >= deadline) throw new Error("temporary Marina did not become ready");
    await Bun.sleep(250);
  }
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "test/load/churn.ts",
      `--url=ws://localhost:${basePort}`,
      `--clients=${process.env.MARINA_CHURN_CLIENTS ?? "12"}`,
      `--cycles=${process.env.MARINA_CHURN_CYCLES ?? "20"}`,
      `--max-errors=${process.env.MARINA_CHURN_MAX_ERRORS ?? "0"}`,
      `--max-p95=${process.env.MARINA_CHURN_MAX_P95_MS ?? "2000"}`,
    ],
    { cwd: process.cwd(), env: process.env, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  server.kill("SIGINT");
  await Promise.race([server.exited, Bun.sleep(2_000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
}
