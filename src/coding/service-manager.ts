import type { FlywheelToolBackend } from "../integrations/flywheel-manager";
import type { CodingServiceRow, MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";
import { WorkspaceGateway } from "./workspace-gateway";

const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SERVICE_STATE_ROOT = "/workspace/.marina/services";
const START_SCRIPT = `state_dir="$1"; log_file="$2"; shift 2; mkdir -p "$state_dir"; nohup "$@" >"$log_file" 2>&1 </dev/null & service_pid=$!; printf '%s\n' "$service_pid"`;
const STATUS_SCRIPT = `kill -0 "$1" 2>/dev/null`;
const STOP_SCRIPT = `if kill -0 "$1" 2>/dev/null; then kill "$1"; i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i+1)); done; kill -0 "$1" 2>/dev/null && kill -9 "$1"; fi; exit 0`;
const PROBE_STATUS_SENTINEL = "__MARINA_HTTP_STATUS__=";
const SCREENSHOT_SCRIPT = `browser=""; for candidate in chromium chromium-browser google-chrome google-chrome-stable; do if command -v "$candidate" >/dev/null 2>&1; then browser="$candidate"; break; fi; done; [ -n "$browser" ] || { printf '%s\n' 'No supported Chromium browser is installed in this sandbox image.' >&2; exit 127; }; "$browser" --headless --disable-gpu --no-sandbox --hide-scrollbars --window-size=1440,900 --screenshot="$1" "$2" >/dev/null 2>&1`;

export class CodingServiceManager {
  private readonly gateway: WorkspaceGateway;

  constructor(
    private readonly db: MarinaDB,
    private readonly flywheel: FlywheelToolBackend,
  ) {
    this.gateway = new WorkspaceGateway(undefined, flywheel);
  }

  async start(input: {
    entityId: EntityId;
    sessionId: string;
    name: string;
    command: string[];
    port?: number;
  }): Promise<CodingServiceRow> {
    const binding = this.requireRunning(input.entityId);
    const name = normalizeName(input.name);
    if (input.command.length === 0) throw new Error("A service command is required after `--`.");
    if (this.db.getCodingServiceForEntity(input.entityId, name)) {
      throw new Error(`Service already exists: ${name}. Use restart or choose another name.`);
    }
    if (
      input.port !== undefined &&
      (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    ) {
      throw new Error("Service port must be an integer from 1 to 65535.");
    }
    const id = `service_${crypto.randomUUID().slice(0, 12)}`;
    const logPath = `${SERVICE_STATE_ROOT}/${id}.log`;
    const execution = await this.gateway.run(
      input.entityId,
      "flywheel",
      [
        "/bin/sh",
        "-c",
        START_SCRIPT,
        "marina-service",
        SERVICE_STATE_ROOT,
        logPath,
        ...input.command,
      ],
      30_000,
      binding.guest_cwd ?? undefined,
    );
    if (execution.result.exitCode !== 0) throw new Error(execution.result.output);
    const pid = Number.parseInt(execution.result.output.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error("Service launch returned no valid PID.");
    const projectId = binding.active_project_id ?? undefined;
    return this.db.createCodingService({
      id,
      entityId: input.entityId,
      sandboxId: binding.sandbox_id,
      projectId,
      sessionId: input.sessionId,
      name,
      command: input.command,
      guestCwd: binding.guest_cwd ?? "/workspace",
      logPath,
      pid,
      port: input.port,
    });
  }

  async refresh(entityId: EntityId, service: CodingServiceRow): Promise<CodingServiceRow> {
    this.requireOwnedSandbox(entityId, service);
    if (!service.pid || service.status !== "running") return service;
    const result = await this.gateway.run(
      entityId,
      "flywheel",
      ["/bin/sh", "-c", STATUS_SCRIPT, "marina-service-status", String(service.pid)],
      10_000,
      service.guest_cwd,
    );
    if (result.result.exitCode !== 0) {
      this.db.updateCodingService(service.id, {
        pid: null,
        status: "stopped",
        stoppedAt: Date.now(),
      });
    }
    return this.db.getCodingService(service.id) ?? service;
  }

  async logs(entityId: EntityId, service: CodingServiceRow, lines = 100): Promise<string> {
    this.requireOwnedSandbox(entityId, service);
    if (!Number.isFinite(lines)) throw new Error("Log line count must be a number from 1 to 500.");
    const boundedLines = Math.max(1, Math.min(500, Math.trunc(lines)));
    const result = await this.gateway.run(
      entityId,
      "flywheel",
      ["tail", "-n", String(boundedLines), "--", service.log_path],
      15_000,
      service.guest_cwd,
    );
    if (result.result.exitCode !== 0) throw new Error(result.result.output);
    return result.result.output;
  }

  async probe(
    entityId: EntityId,
    service: CodingServiceRow,
    path = "/",
  ): Promise<{ body: string; durationMs: number; httpStatus: number; truncated: boolean }> {
    this.requireOwnedSandbox(entityId, service);
    if (!service.port) throw new Error("Service has no declared port to probe.");
    if (!/^\/[\x21-\x7e]*$/.test(path) || path.includes("#") || path.includes("@")) {
      throw new Error(
        "Probe path must be an absolute HTTP path without spaces, fragments, or credentials.",
      );
    }
    const url = `http://127.0.0.1:${service.port}${path}`;
    const execution = await this.gateway.run(
      entityId,
      "flywheel",
      [
        "curl",
        "--silent",
        "--show-error",
        "--max-time",
        "10",
        "--output",
        "-",
        "--write-out",
        `\n${PROBE_STATUS_SENTINEL}%{http_code}\n`,
        "--",
        url,
      ],
      15_000,
      service.guest_cwd,
    );
    if (execution.result.exitCode !== 0) throw new Error(execution.result.output);
    const pattern = new RegExp(`(?:^|\\n)${PROBE_STATUS_SENTINEL}(\\d{3})$`);
    const match = execution.result.output.match(pattern);
    if (!match?.[1]) throw new Error("Service probe returned no HTTP status.");
    return {
      body: execution.result.output.replace(pattern, "").trimEnd(),
      durationMs: execution.result.durationMs,
      httpStatus: Number(match[1]),
      truncated: execution.result.truncated,
    };
  }

  async screenshot(
    entityId: EntityId,
    service: CodingServiceRow,
    path = "/",
  ): Promise<{ data: Uint8Array; durationMs: number }> {
    this.requireOwnedSandbox(entityId, service);
    if (!service.port) throw new Error("Service has no declared port to capture.");
    if (!/^\/[\x21-\x7e]*$/.test(path) || path.includes("#") || path.includes("@")) {
      throw new Error(
        "Capture path must be an absolute HTTP path without spaces, fragments, or credentials.",
      );
    }
    if (!this.flywheel.readFile) {
      throw new Error("Configured Flywheel does not support bounded binary reads.");
    }
    const guestPath = `${SERVICE_STATE_ROOT}/${service.id}.png`;
    const startedAt = performance.now();
    const execution = await this.gateway.run(
      entityId,
      "flywheel",
      [
        "/bin/sh",
        "-c",
        SCREENSHOT_SCRIPT,
        "marina-service-screenshot",
        guestPath,
        `http://127.0.0.1:${service.port}${path}`,
      ],
      30_000,
      service.guest_cwd,
    );
    if (execution.result.exitCode !== 0) throw new Error(execution.result.output);
    try {
      const transferred = await this.flywheel.readFile(entityId, guestPath, {
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 30_000,
      });
      if (
        transferred.data.length < 8 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every(
          (value, index) => transferred.data[index] === value,
        )
      ) {
        throw new Error("Browser capture did not produce a valid PNG image.");
      }
      return {
        data: transferred.data,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } finally {
      await this.gateway.run(
        entityId,
        "flywheel",
        ["rm", "-f", "--", guestPath],
        10_000,
        service.guest_cwd,
      );
    }
  }

  async stop(entityId: EntityId, service: CodingServiceRow): Promise<CodingServiceRow> {
    this.requireOwnedSandbox(entityId, service);
    if (service.pid && service.status === "running") {
      await this.gateway.run(
        entityId,
        "flywheel",
        ["/bin/sh", "-c", STOP_SCRIPT, "marina-service-stop", String(service.pid)],
        15_000,
        service.guest_cwd,
      );
    }
    this.db.updateCodingService(service.id, {
      pid: null,
      status: "stopped",
      stoppedAt: Date.now(),
    });
    return this.db.getCodingService(service.id) as CodingServiceRow;
  }

  async restart(entityId: EntityId, service: CodingServiceRow): Promise<CodingServiceRow> {
    if (service.status === "running") await this.stop(entityId, service);
    const command = parseCommand(service.command_json);
    const binding = this.requireRunning(entityId);
    this.requireOwnedSandbox(entityId, service);
    const execution = await this.gateway.run(
      entityId,
      "flywheel",
      [
        "/bin/sh",
        "-c",
        START_SCRIPT,
        "marina-service",
        SERVICE_STATE_ROOT,
        service.log_path,
        ...command,
      ],
      30_000,
      binding.guest_cwd ?? service.guest_cwd,
    );
    if (execution.result.exitCode !== 0) throw new Error(execution.result.output);
    const pid = Number.parseInt(execution.result.output.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error("Service restart returned no valid PID.");
    this.db.updateCodingService(service.id, {
      pid,
      status: "running",
      lastError: null,
      startedAt: Date.now(),
      stoppedAt: null,
    });
    return this.db.getCodingService(service.id) as CodingServiceRow;
  }

  private requireRunning(entityId: EntityId) {
    const binding = this.db.listFlywheelBindings().find((row) => row.entity_id === entityId);
    if (!binding) throw new Error("Use `code sandbox start` before starting a service.");
    if (binding.state !== "running") throw new Error(`Flywheel sandbox is ${binding.state}.`);
    return binding;
  }

  private requireOwnedSandbox(entityId: EntityId, service: CodingServiceRow): void {
    const binding = this.requireRunning(entityId);
    if (service.entity_id !== entityId || service.sandbox_id !== binding.sandbox_id) {
      throw new Error("Service does not belong to this entity's current Flywheel sandbox.");
    }
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!SERVICE_NAME.test(normalized)) {
    throw new Error(
      "Service names use 1-64 lowercase letters, numbers, dots, dashes, or underscores.",
    );
  }
  return normalized;
}

function parseCommand(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (
    !Array.isArray(parsed) ||
    parsed.some((part) => typeof part !== "string") ||
    parsed.length === 0
  ) {
    throw new Error("Stored service restart recipe is invalid.");
  }
  return parsed as string[];
}
