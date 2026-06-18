import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { LocalWorkspace } from "./local-workspace";

export interface WorkspaceChoice {
  label: string;
  root: string;
}

export class WorkspaceRegistry {
  readonly roots: string[];
  readonly defaultRoot: string;
  readonly usesCwdFallback: boolean;

  constructor(opts: { defaultRoot?: string; roots?: string[]; usesCwdFallback?: boolean } = {}) {
    const rawRoots = opts.roots && opts.roots.length > 0 ? opts.roots : [process.cwd()];
    this.roots = unique(rawRoots.map((root) => canonicalDirectory(root)));
    this.usesCwdFallback = opts.usesCwdFallback ?? (!opts.roots || opts.roots.length === 0);
    const requestedDefault = opts.defaultRoot
      ? canonicalDirectory(opts.defaultRoot)
      : (this.roots[0] ?? canonicalDirectory(process.cwd()));
    if (!this.isAllowedRoot(requestedDefault)) {
      throw new Error(`Default code workspace is outside allowed roots: ${requestedDefault}`);
    }
    this.defaultRoot = requestedDefault;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceRegistry {
    const roots = splitEnvList(env.MARINA_CODE_ROOTS);
    return new WorkspaceRegistry({
      defaultRoot: env.MARINA_CODE_DEFAULT_ROOT,
      roots: roots.length > 0 ? roots : undefined,
      usesCwdFallback: roots.length === 0 && !env.MARINA_CODE_DEFAULT_ROOT,
    });
  }

  defaultWorkspace(): LocalWorkspace {
    return new LocalWorkspace(this.defaultRoot);
  }

  workspaceForRoot(root: string): LocalWorkspace {
    return new LocalWorkspace(this.resolveRoot(root).root);
  }

  resolveRoot(input: string): WorkspaceChoice {
    const raw = input.trim();
    if (!raw) return { root: this.defaultRoot, label: basename(this.defaultRoot) };

    const candidates = isAbsolute(raw)
      ? [raw]
      : this.roots.flatMap((root) => [resolve(root, raw), resolve(root, "..", raw)]);
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const resolved = canonicalDirectory(candidate);
      if (this.isAllowedRoot(resolved)) {
        return { root: resolved, label: basename(resolved) };
      }
    }

    const attempted = candidates[0] ?? raw;
    const resolved = existsSync(attempted) ? canonicalDirectory(attempted) : resolve(attempted);
    if (!this.isAllowedRoot(resolved)) {
      throw new Error(`Workspace is outside allowed roots: ${raw}`);
    }
    throw new Error(`Workspace directory not found: ${raw}`);
  }

  listChoices(): WorkspaceChoice[] {
    return this.roots.map((root) => ({ root, label: basename(root) || root }));
  }

  private isAllowedRoot(path: string): boolean {
    return this.roots.some((root) => path === root || path.startsWith(`${root}/`));
  }
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function canonicalDirectory(path: string): string {
  const resolved = realpathSync(resolve(path));
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Code workspace root is not a directory: ${path}`);
  }
  return resolved;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
