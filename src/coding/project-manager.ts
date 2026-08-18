// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { FlywheelToolBackend } from "../integrations/flywheel-manager";
import type { CodingProjectRow, MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";
import type { WorkspaceRuntime } from "./local-workspace";
import { WorkspaceGateway } from "./workspace-gateway";

const PROJECT_ROOT = "/workspace/projects";
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PROJECT_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_PROJECT_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_ARCHIVE_MEMBERS = 2_000;
const MAX_PROJECT_MEMBER_BYTES = 32 * 1024 * 1024;
const MAX_PROJECT_COMPRESSION_RATIO = 100;
export const PROJECT_ARCHIVE_FORMAT = "marina-project-tar-gzip-v1";

export interface ProjectStatus {
  branch: string | null;
  dirty: boolean;
  output: string;
  revision: string | null;
  untracked: boolean;
}

export interface ProjectDiff {
  content: string;
  status: ProjectStatus;
  untrackedPaths: string[];
}

export interface ProjectArchiveManifest {
  expandedBytes: number;
  memberCount: number;
}

export class CodingProjectManager {
  private readonly gateway: WorkspaceGateway;

  constructor(
    private readonly db: MarinaDB,
    local: WorkspaceRuntime | undefined,
    private readonly flywheel: FlywheelToolBackend,
  ) {
    this.gateway = new WorkspaceGateway(local, flywheel);
  }

  async init(entityId: EntityId, name: string): Promise<CodingProjectRow> {
    const workspace = this.requireWorkspace(entityId);
    const normalized = normalizeName(name);
    if (this.db.getCodingProjectForEntity(entityId, normalized)) {
      throw new Error(`Project already exists: ${normalized}`);
    }
    const guestPath = `${PROJECT_ROOT}/${normalized}`;
    await this.run(entityId, ["mkdir", "-p", guestPath]);
    await this.run(entityId, ["git", "init", "-b", "main"], guestPath);
    const project = this.db.createCodingProject({
      id: `project_${crypto.randomUUID().slice(0, 12)}`,
      entityId,
      sandboxId: workspace.sandbox_id,
      name: normalized,
      sourceType: "empty",
      guestPath,
      activeBranch: "main",
    });
    this.activate(entityId, project);
    return project;
  }

  async clone(entityId: EntityId, locator: string, name?: string): Promise<CodingProjectRow> {
    const workspace = this.requireWorkspace(entityId);
    const sourceLocator = sanitizePublicGitUrl(locator);
    const normalized = normalizeName(name ?? inferredName(sourceLocator));
    if (this.db.getCodingProjectForEntity(entityId, normalized)) {
      throw new Error(`Project already exists: ${normalized}`);
    }
    const guestPath = `${PROJECT_ROOT}/${normalized}`;
    await this.run(entityId, ["mkdir", "-p", PROJECT_ROOT]);
    await this.run(entityId, ["git", "clone", "--", sourceLocator, guestPath], undefined, true);
    const status = await this.inspectPath(entityId, guestPath);
    const project = this.db.createCodingProject({
      id: `project_${crypto.randomUUID().slice(0, 12)}`,
      entityId,
      sandboxId: workspace.sandbox_id,
      name: normalized,
      sourceType: "git",
      sourceLocator,
      guestPath,
      activeBranch: status.branch ?? undefined,
      baseRevision: status.revision ?? undefined,
    });
    this.activate(entityId, project);
    return project;
  }

  active(entityId: EntityId): CodingProjectRow | null {
    const binding = this.db.listFlywheelBindings().find((row) => row.entity_id === entityId);
    return binding?.active_project_id ? this.db.getCodingProject(binding.active_project_id) : null;
  }

  async status(entityId: EntityId, project = this.active(entityId)): Promise<ProjectStatus> {
    if (!project) throw new Error("No active project. Use `code project init|clone` first.");
    this.requireOwnedCurrentSandbox(entityId, project);
    const status = await this.inspectPath(entityId, project.guest_path);
    const fingerprint = statusFingerprint(status);
    this.db.updateCodingProject(project.id, {
      activeBranch: status.branch,
      baseRevision: project.base_revision ?? status.revision,
      dirty: status.dirty,
      hasUnexportedChanges: status.dirty && project.exported_fingerprint !== fingerprint,
      lastStatusAt: Date.now(),
    });
    return status;
  }

  async switch(entityId: EntityId, selector: string): Promise<CodingProjectRow> {
    const target = this.db.getCodingProjectForEntity(entityId, selector);
    if (!target) throw new Error(`Unknown project: ${selector}`);
    this.requireOwnedCurrentSandbox(entityId, target);
    const current = this.active(entityId);
    if (current && current.id !== target.id) {
      const status = await this.status(entityId, current);
      const refreshed = this.db.getCodingProject(current.id);
      if (status.dirty && refreshed?.has_unexported_changes) {
        throw new Error(
          `Project ${current.name} has unexported changes. Export or commit them before switching.`,
        );
      }
    }
    this.activate(entityId, target);
    return target;
  }

  async exportPatch(
    entityId: EntityId,
    project = this.active(entityId),
  ): Promise<{ content: string; project: CodingProjectRow; status: ProjectStatus }> {
    if (!project) throw new Error("No active project. Use `code project init|clone` first.");
    this.requireOwnedCurrentSandbox(entityId, project);
    const status = await this.inspectPath(entityId, project.guest_path);
    if (status.untracked) {
      throw new Error(
        "Export refused: untracked files cannot be represented completely by a Git patch. Add/commit them first, or wait for bounded archive transfer support.",
      );
    }
    const diffCommand = ["git", "diff", "--binary", "--no-ext-diff"];
    if (status.revision) diffCommand.push("HEAD");
    const diff = await this.run(entityId, diffCommand, project.guest_path);
    const exportedAt = Date.now();
    this.db.updateCodingProject(project.id, {
      activeBranch: status.branch,
      dirty: status.dirty,
      hasUnexportedChanges: false,
      exportedFingerprint: statusFingerprint(status),
      lastExportedAt: exportedAt,
      lastStatusAt: exportedAt,
    });
    return {
      content: diff.output || "# Clean project: no patch content\n",
      project,
      status,
    };
  }

  async exportArchive(
    entityId: EntityId,
    project = this.active(entityId),
  ): Promise<{
    data: Uint8Array;
    manifest: ProjectArchiveManifest;
    project: CodingProjectRow;
    sha256: string;
    status: ProjectStatus;
  }> {
    if (!project) throw new Error("No active project. Use `code project init|clone` first.");
    this.requireOwnedCurrentSandbox(entityId, project);
    if (!this.flywheel.readFile) throw new Error("Flywheel bounded binary reads are unavailable.");
    const archivePath = `/workspace/.marina/${project.id}-${crypto.randomUUID()}.tar.gz`;
    await this.run(entityId, ["mkdir", "-p", "/workspace/.marina"]);
    await this.run(
      entityId,
      ["tar", "-czf", archivePath, "--exclude=.git", "-C", project.guest_path, "."],
      "/",
    );
    try {
      const transferred = await this.flywheel.readFile(entityId, archivePath, {
        maxBytes: MAX_PROJECT_ARCHIVE_BYTES,
        timeoutMs: 60_000,
      });
      assertTransferEvidence(transferred);
      const listed = await this.run(entityId, ["tar", "-tvzf", archivePath], "/");
      const manifest = validateProjectArchiveManifest(listed.output, transferred.byteLength);
      const status = await this.inspectPath(entityId, project.guest_path);
      this.db.updateCodingProject(project.id, {
        activeBranch: status.branch,
        dirty: status.dirty,
        exportedFingerprint: statusFingerprint(status),
        hasUnexportedChanges: false,
        lastExportedAt: Date.now(),
        lastStatusAt: Date.now(),
      });
      return { data: transferred.data, manifest, project, sha256: transferred.sha256, status };
    } finally {
      await this.run(entityId, ["rm", "-f", "--", archivePath], "/", true);
    }
  }

  async importArchive(
    entityId: EntityId,
    name: string,
    data: Uint8Array,
  ): Promise<CodingProjectRow> {
    const workspace = this.requireWorkspace(entityId);
    if (!this.flywheel.writeFile)
      throw new Error("Flywheel bounded binary writes are unavailable.");
    if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) {
      throw new Error("Project import requires a gzip-compressed tar archive.");
    }
    const normalized = normalizeName(name);
    if (this.db.getCodingProjectForEntity(entityId, normalized)) {
      throw new Error(`Project already exists: ${normalized}`);
    }
    const guestPath = `${PROJECT_ROOT}/${normalized}`;
    const nonce = crypto.randomUUID();
    const archivePath = `/workspace/.marina/import-${nonce}.tar.gz`;
    const stagingPath = `${PROJECT_ROOT}/.import-${nonce}`;
    await this.run(entityId, ["mkdir", "-p", "/workspace/.marina", PROJECT_ROOT]);
    const uploaded = await this.flywheel.writeFile(entityId, archivePath, data, {
      maxBytes: MAX_PROJECT_ARCHIVE_BYTES,
      timeoutMs: 60_000,
    });
    if (uploaded.byteLength !== data.length || uploaded.sha256 !== sha256(data)) {
      throw new Error("Project archive upload integrity evidence did not match its source bytes.");
    }
    try {
      const listed = await this.run(entityId, ["tar", "-tvzf", archivePath], "/");
      validateProjectArchiveManifest(listed.output, data.length);
      await this.run(entityId, ["mkdir", stagingPath]);
      await this.run(
        entityId,
        ["tar", "-xzf", archivePath, "--no-same-owner", "-C", stagingPath],
        "/",
      );
      await this.run(entityId, ["git", "init", "-b", "main"], stagingPath);
      await this.run(entityId, ["mv", "--", stagingPath, guestPath], "/");
      const project = this.db.createCodingProject({
        id: `project_${crypto.randomUUID().slice(0, 12)}`,
        entityId,
        sandboxId: workspace.sandbox_id,
        name: normalized,
        sourceType: "archive",
        guestPath,
        activeBranch: "main",
      });
      this.activate(entityId, project);
      return project;
    } finally {
      await this.run(entityId, ["rm", "-f", "--", archivePath], "/", true);
      await this.run(entityId, ["rm", "-rf", "--", stagingPath], "/", true);
    }
  }

  async delete(
    entityId: EntityId,
    selector: string,
    options?: { discard?: boolean },
  ): Promise<CodingProjectRow> {
    const project = this.db.getCodingProjectForEntity(entityId, selector);
    if (!project) throw new Error(`Unknown project: ${selector}`);
    this.requireOwnedCurrentSandbox(entityId, project);
    const status = await this.status(entityId, project);
    const refreshed = this.db.getCodingProject(project.id) ?? project;
    if (status.dirty && refreshed.has_unexported_changes && !options?.discard) {
      throw new Error(
        `Project ${project.name} has unexported changes. Export it first or explicitly confirm discard.`,
      );
    }
    await this.run(entityId, ["rm", "-rf", "--", project.guest_path], "/");
    this.db.deleteCodingProject(entityId, project.id, project.sandbox_id);
    const binding = this.requireWorkspace(entityId);
    if (binding.active_project_id === project.id) {
      this.db.updateFlywheelBinding(entityId, { activeProjectId: null, guestCwd: null });
    }
    return project;
  }

  reconcile(entityId: EntityId): { removed: string[] } {
    const workspace = this.requireWorkspace(entityId);
    const removed: string[] = [];
    for (const project of this.db.listCodingProjects(entityId)) {
      if (project.sandbox_id === workspace.sandbox_id) continue;
      this.db.deleteCodingProject(entityId, project.id, project.sandbox_id);
      removed.push(project.id);
    }
    if (workspace.active_project_id && removed.includes(workspace.active_project_id)) {
      this.db.updateFlywheelBinding(entityId, { activeProjectId: null, guestCwd: null });
    }
    return { removed };
  }

  async diff(
    entityId: EntityId,
    project = this.active(entityId),
  ): Promise<{ project: CodingProjectRow; diff: ProjectDiff }> {
    if (!project) throw new Error("No active project. Use `code project init|clone` first.");
    this.requireOwnedCurrentSandbox(entityId, project);
    const status = await this.inspectPath(entityId, project.guest_path);
    const diffCommand = ["git", "diff", "--binary", "--no-ext-diff"];
    if (status.revision) diffCommand.push("HEAD");
    const result = await this.run(entityId, diffCommand, project.guest_path);
    const untrackedPaths = status.output
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3));
    this.db.updateCodingProject(project.id, {
      activeBranch: status.branch,
      dirty: status.dirty,
      hasUnexportedChanges:
        status.dirty && project.exported_fingerprint !== statusFingerprint(status),
      lastStatusAt: Date.now(),
    });
    return {
      project,
      diff: {
        content: result.output,
        status,
        untrackedPaths,
      },
    };
  }

  private async inspectPath(entityId: EntityId, cwd: string): Promise<ProjectStatus> {
    const statusResult = await this.run(
      entityId,
      ["git", "status", "--porcelain=v1", "--branch"],
      cwd,
    );
    const lines = statusResult.output.split("\n").filter(Boolean);
    const header = lines.find((line) => line.startsWith("## "));
    const changes = lines.filter((line) => !line.startsWith("## "));
    const revisionResult = await this.gateway.run(
      entityId,
      "flywheel",
      ["git", "rev-parse", "HEAD"],
      120_000,
      cwd,
    );
    return {
      branch: header ? header.slice(3).split("...")[0]?.trim() || null : null,
      dirty: changes.length > 0,
      output: statusResult.output,
      revision:
        revisionResult.result.exitCode === 0 ? revisionResult.result.output.trim() || null : null,
      untracked: changes.some((line) => line.startsWith("??")),
    };
  }

  private async run(entityId: EntityId, command: string[], cwd?: string, allowTruncated = false) {
    const execution = await this.gateway.run(entityId, "flywheel", command, 120_000, cwd);
    if (execution.result.exitCode !== 0) {
      throw new Error(
        execution.result.output || `${command[0]} exited ${execution.result.exitCode}`,
      );
    }
    if (execution.result.truncated && !allowTruncated) {
      throw new Error(`${command[0]} output exceeded Marina's safe persistence limit.`);
    }
    return execution.result;
  }

  private requireWorkspace(entityId: EntityId) {
    const binding = this.db.listFlywheelBindings().find((row) => row.entity_id === entityId);
    if (!binding) throw new Error("Use `code sandbox start` before creating a project.");
    if (binding.state !== "running") throw new Error(`Flywheel sandbox is ${binding.state}.`);
    return binding;
  }

  private requireOwnedCurrentSandbox(entityId: EntityId, project: CodingProjectRow): void {
    const workspace = this.requireWorkspace(entityId);
    if (project.entity_id !== entityId || project.sandbox_id !== workspace.sandbox_id) {
      throw new Error("Project does not belong to this entity's current Flywheel sandbox.");
    }
  }

  private activate(entityId: EntityId, project: CodingProjectRow): void {
    this.db.updateFlywheelBinding(entityId, {
      activeProjectId: project.id,
      guestCwd: project.guest_path,
    });
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!PROJECT_NAME.test(normalized)) {
    throw new Error(
      "Project names use 1-64 lowercase letters, numbers, dots, dashes, or underscores.",
    );
  }
  return normalized;
}

function inferredName(locator: string): string {
  const segment = new URL(locator).pathname.split("/").filter(Boolean).at(-1) ?? "project";
  return segment.replace(/\.git$/i, "").toLowerCase();
}

function sanitizePublicGitUrl(locator: string): string {
  let parsed: URL;
  try {
    parsed = new URL(locator);
  } catch {
    throw new Error("Public Git clone requires a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(
      "Public Git clone requires credential-free HTTPS; embedded credentials are refused.",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("Public Git clone refuses local and private network targets.");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

function statusFingerprint(status: ProjectStatus): string {
  return `${status.revision ?? "unborn"}\n${status.output}`;
}

export function validateProjectArchiveManifest(
  verboseListing: string,
  compressedBytes: number,
): ProjectArchiveManifest {
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 1) {
    throw new Error("Project archive compressed byte count is invalid.");
  }
  const lines = verboseListing.split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("Project archive is empty.");
  if (lines.length > MAX_PROJECT_ARCHIVE_MEMBERS) {
    throw new Error(`Project archive exceeds ${MAX_PROJECT_ARCHIVE_MEMBERS} members.`);
  }
  let expandedBytes = 0;
  for (const line of lines) {
    const match = line.match(/^(.)(\S*)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!match?.[1] || !match[3] || !match[4]) {
      throw new Error("Project archive manifest contains an unrecognized member record.");
    }
    const type = match[1];
    if (type !== "-" && type !== "d") {
      throw new Error("Project archive contains a link, device, FIFO, socket, or special file.");
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PROJECT_MEMBER_BYTES) {
      throw new Error(`Project archive member exceeds ${MAX_PROJECT_MEMBER_BYTES} bytes.`);
    }
    const rawPath = match[4];
    const path = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
    if (
      rawPath.startsWith("/") ||
      path.split("/").includes("..") ||
      path.includes("\0") ||
      (path === "" && type !== "d")
    ) {
      throw new Error("Project archive contains an unsafe path.");
    }
    expandedBytes += size;
    if (expandedBytes > MAX_PROJECT_EXPANDED_BYTES) {
      throw new Error(`Project archive expands beyond ${MAX_PROJECT_EXPANDED_BYTES} bytes.`);
    }
  }
  if (expandedBytes / compressedBytes > MAX_PROJECT_COMPRESSION_RATIO) {
    throw new Error(
      `Project archive exceeds the ${MAX_PROJECT_COMPRESSION_RATIO}:1 compression-ratio limit.`,
    );
  }
  return { expandedBytes, memberCount: lines.length };
}

function assertTransferEvidence(result: {
  byteLength: number;
  data: Uint8Array;
  sha256: string;
}): void {
  if (result.byteLength !== result.data.length || result.sha256 !== sha256(result.data)) {
    throw new Error("Flywheel download byte-count/digest evidence did not match received bytes.");
  }
}

function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}
