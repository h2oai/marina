const basePort = 42_000 + Math.floor(Math.random() * 1_000) * 4;
const stamp = `${process.pid}-${Date.now().toString(36)}`;
const baseUrl = `http://localhost:${basePort}`;
const server = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MARINA_WORLD: "empty",
    DB_PATH: `/tmp/marina-live-evolution-${stamp}.db`,
    ASSETS_DIR: `/tmp/marina-live-evolution-assets-${stamp}`,
    WS_PORT: String(basePort),
    MCP_PORT: String(basePort + 1),
    LOG_PORT: String(basePort + 2),
    TELNET_PORT: String(basePort + 3),
    MARINA_ENDPOINTS: "none",
    MARINA_OPEN_API: "true",
    MARINA_ADMINS: "Operator",
    MARINA_EVOLUTION_PROTOCOLS: "true",
    AGENT_AUTORESPAWN: "false",
    TICK_MS: "1000",
  },
  stdout: "inherit",
  stderr: "inherit",
});

try {
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`temporary Marina exited with ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(250);
  }
  if (!ready) throw new Error("temporary Marina did not become ready");
  const trial = Bun.spawn(["bun", "run", "scripts/run-evolution-trial.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MARINA_URL: baseUrl,
      MARINA_TRIAL_MODEL: process.env.MARINA_TRIAL_MODEL ?? "openai/gpt-4o-mini",
      MARINA_TRIAL_TIMEOUT_MS: process.env.MARINA_TRIAL_TIMEOUT_MS ?? "180000",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await trial.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  server.kill("SIGINT");
  await Promise.race([server.exited, Bun.sleep(2_000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
}
