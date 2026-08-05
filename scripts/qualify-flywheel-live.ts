import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingProjectManager } from "../src/coding/project-manager";
import { CodingServiceManager } from "../src/coding/service-manager";
import { WorkspaceGateway } from "../src/coding/workspace-gateway";
import { FlywheelManager } from "../src/integrations/flywheel-manager";
import { MarinaDB } from "../src/persistence/database";
import { redactSensitiveText } from "../src/security/secret-redaction";
import { entityId } from "../src/types";

type StepStatus = "passed" | "failed" | "skipped";

interface QualificationStep {
  name: string;
  status: StepStatus;
  required: boolean;
  durationMs: number;
  detail?: string;
  metrics?: Record<string, number | string | boolean>;
}

interface QualificationEvidence {
  format: "marina-flywheel-qualification";
  version: 1;
  runId: string;
  deploymentMode: string;
  startedAt: string;
  completedAt: string;
  endpoint: string;
  image: string;
  required: boolean;
  qualified: boolean;
  steps: QualificationStep[];
  operationSummary: unknown[];
}

class SkipStep extends Error {}

const token = process.env.FLYWHEEL_TOKEN;
const endpoint = process.env.FLYWHEEL_RPC_URL ?? "http://localhost:8088/rpc";
const image = process.env.FLYWHEEL_IMAGE ?? "localhost/h2oai/flywheel-agentd:latest";
const liveRequired = process.env.MARINA_FLYWHEEL_LIVE_REQUIRED === "true";
const fullRequired = process.env.MARINA_FLYWHEEL_LIVE_FULL === "true";
const allowPublish = process.env.MARINA_FLYWHEEL_LIVE_ALLOW_PUBLISH === "true";
const cloneUrl = process.env.MARINA_FLYWHEEL_LIVE_CLONE_URL;
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
const evidenceDir = process.env.MARINA_FLYWHEEL_EVIDENCE_DIR ?? "artifacts/flywheel";
const evidencePath = join(evidenceDir, `${runId}.json`);
const startedAt = new Date().toISOString();
const steps: QualificationStep[] = [];
const scratch = mkdtempSync(join(tmpdir(), "marina-flywheel-live-"));
const dbPath = join(scratch, "qualification.db");
const owner = entityId(`flywheel-qualification-${crypto.randomUUID().slice(0, 8)}`);
let db: MarinaDB | undefined;
let manager: FlywheelManager | undefined;
let sandboxCreated = false;

async function step(
  name: string,
  required: boolean,
  action: () => Promise<Record<string, number | string | boolean> | undefined>,
): Promise<void> {
  const began = performance.now();
  try {
    const metrics = await action();
    steps.push({
      name,
      required,
      status: "passed",
      durationMs: Math.round(performance.now() - began),
      metrics: metrics || undefined,
    });
  } catch (error) {
    const skipped = error instanceof SkipStep;
    steps.push({
      name,
      required,
      status: skipped ? "skipped" : "failed",
      durationMs: Math.round(performance.now() - began),
      detail: safeDetail(error),
    });
  }
}

function safeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message)
    .replace(token ?? "__no_token__", "[redacted]")
    .slice(0, 1_000);
}

function requirePassed(name: string): void {
  const result = steps.find((candidate) => candidate.name === name);
  if (result?.status !== "passed") throw new SkipStep(`Prerequisite did not pass: ${name}`);
}

if (!token) {
  steps.push({
    name: "configuration",
    required: liveRequired,
    status: liveRequired ? "failed" : "skipped",
    durationMs: 0,
    detail: "FLYWHEEL_TOKEN is not configured; no network request was attempted.",
  });
} else {
  db = new MarinaDB(dbPath);
  manager = new FlywheelManager(endpoint, token, image, undefined, db);
  const gateway = new WorkspaceGateway(undefined, manager);
  const projects = new CodingProjectManager(db, undefined, manager);
  const services = new CodingServiceManager(db, manager);

  await step("create", true, async () => {
    const workspace = await manager!.create(owner, image, true);
    sandboxCreated = true;
    return { sandboxId: workspace.sandboxId, keepAlive: workspace.keepAlive };
  });

  await step("finite-exec", true, async () => {
    requirePassed("create");
    const executed = await gateway.run(
      owner,
      "flywheel",
      ["/bin/sh", "-c", "printf marina-live-ready"],
      30_000,
      "/",
    );
    if (executed.result.exitCode !== 0 || executed.result.output !== "marina-live-ready") {
      throw new Error(`Finite execution returned exit=${executed.result.exitCode}`);
    }
    return {
      durationMs: executed.result.durationMs,
      eventCount: executed.flywheelEvents?.length ?? 0,
    };
  });

  await step("timeout-cancellation", true, async () => {
    requirePassed("finite-exec");
    const marker = `/tmp/marina-timeout-${crypto.randomUUID()}`;
    const timed = await gateway.run(
      owner,
      "flywheel",
      ["/bin/sh", "-c", `sleep 2; printf detached >${marker}`],
      250,
      "/",
    );
    if (!timed.result.timedOut || timed.result.exitCode !== 124) {
      throw new Error("Long execution did not report authoritative remote cancellation.");
    }
    await Bun.sleep(2_250);
    const inspected = await gateway.run(
      owner,
      "flywheel",
      ["test", "!", "-e", marker],
      15_000,
      "/",
    );
    if (inspected.result.exitCode !== 0) {
      throw new Error("Timed-out process remained detached and wrote its marker.");
    }
    return { timedOut: true, detachedProcessPrevented: true };
  });

  await step("project-archive-roundtrip", true, async () => {
    requirePassed("finite-exec");
    const project = await projects.init(owner, "qualification-source");
    await manager!.writeFile!(
      owner,
      `${project.guest_path}/qualification.txt`,
      new TextEncoder().encode("marina-flywheel-roundtrip\n"),
    );
    await projects.status(owner, project);
    const exported = await projects.exportArchive(owner, project);
    const restored = await projects.importArchive(owner, "qualification-restored", exported.data);
    const read = await manager!.readFile!(owner, `${restored.guest_path}/qualification.txt`);
    if (new TextDecoder().decode(read.data) !== "marina-flywheel-roundtrip\n") {
      throw new Error("Restored project content did not match its source.");
    }
    return {
      archiveBytes: exported.data.length,
      expandedBytes: exported.manifest.expandedBytes,
      members: exported.manifest.memberCount,
    };
  });

  await step("public-clone", fullRequired, async () => {
    requirePassed("create");
    if (!cloneUrl)
      throw new SkipStep("Set MARINA_FLYWHEEL_LIVE_CLONE_URL to exercise public clone.");
    const cloned = await projects.clone(owner, cloneUrl, "qualification-clone");
    const status = await projects.status(owner, cloned);
    return { revisionPresent: Boolean(status.revision) };
  });

  let service: Awaited<ReturnType<CodingServiceManager["start"]>> | undefined;
  await step("managed-service-probe", fullRequired, async () => {
    requirePassed("create");
    const detected = await gateway.run(
      owner,
      "flywheel",
      ["/bin/sh", "-c", "command -v python3 || command -v python"],
      15_000,
      "/",
    );
    const python = detected.result.output.trim();
    if (detected.result.exitCode !== 0 || !python.startsWith("/")) {
      throw new SkipStep("Sandbox image has no Python HTTP server capability.");
    }
    const active = projects.active(owner);
    service = await services.start({
      entityId: owner,
      sessionId: "live-qualification",
      name: "qualification-web",
      command: [python, "-m", "http.server", "43821", "--bind", "127.0.0.1"],
      port: 43821,
      projectId: active?.id,
    });
    await Bun.sleep(500);
    const probe = await services.probe(owner, service, "/");
    if (probe.httpStatus !== 200) throw new Error(`Service returned HTTP ${probe.httpStatus}`);
    return { httpStatus: probe.httpStatus, durationMs: probe.durationMs };
  });

  await step("publish-revoke", fullRequired, async () => {
    if (!allowPublish) {
      throw new SkipStep("Set MARINA_FLYWHEEL_LIVE_ALLOW_PUBLISH=true to permit public exposure.");
    }
    if (!service) throw new SkipStep("Managed service prerequisite is unavailable.");
    const published = await manager!.publishDetailed(owner, service.port!);
    try {
      const response = await fetch(published.url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Published endpoint returned HTTP ${response.status}`);
      return { reachable: true };
    } finally {
      await manager!.unpublish(owner, published.subdomain);
    }
  });

  await step("browser-screenshot", fullRequired, async () => {
    if (!service) throw new SkipStep("Managed service prerequisite is unavailable.");
    try {
      const screenshot = await services.screenshot(owner, service, "/");
      return { pngBytes: screenshot.data.length, durationMs: screenshot.durationMs };
    } catch (error) {
      throw new SkipStep(`Sandbox browser capability unavailable: ${safeDetail(error)}`);
    }
  });

  if (service) {
    await step("service-stop", true, async () => {
      service = await services.stop(owner, service!);
      return { stopped: service.status === "stopped" };
    });
  }

  await step("hibernate-resume", fullRequired, async () => {
    requirePassed("project-archive-roundtrip");
    await manager!.hibernate(owner);
    await manager!.resume(owner);
    const active = projects.active(owner);
    if (!active) throw new Error("Active project metadata was lost across resume.");
    const read = await manager!.readFile!(owner, `${active.guest_path}/qualification.txt`);
    if (!new TextDecoder().decode(read.data).includes("marina-flywheel-roundtrip")) {
      throw new Error("Guest disk content was lost across hibernate/resume.");
    }
    return { diskPreserved: true };
  });
}

try {
  if (sandboxCreated && manager) {
    await step("teardown", true, async () => {
      await manager!.stop(owner);
      sandboxCreated = false;
      return { bindingRemoved: manager!.status(owner) === undefined };
    });
  }
} finally {
  const operationSummary = manager?.operationSummary() ?? [];
  const qualified =
    Boolean(token) &&
    steps.every((candidate) => !candidate.required || candidate.status === "passed");
  const evidence: QualificationEvidence = {
    format: "marina-flywheel-qualification",
    version: 1,
    runId,
    deploymentMode: process.env.MARINA_FLYWHEEL_DEPLOYMENT_MODE ?? "separate",
    startedAt,
    completedAt: new Date().toISOString(),
    endpoint: new URL(endpoint).origin,
    image,
    required: liveRequired,
    qualified,
    steps,
    operationSummary,
  };
  mkdirSync(evidenceDir, { recursive: true });
  await Bun.write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  db?.close();
  rmSync(scratch, { force: true, recursive: true });
  console.log(JSON.stringify({ qualified, evidencePath, steps }, null, 2));
  if (!qualified) process.exitCode = liveRequired || token ? 1 : 0;
}
