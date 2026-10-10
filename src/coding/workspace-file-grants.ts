// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Operator-owned grants. Agents cannot add roots by changing session artifacts. */
export interface WorkspaceFileGrant {
  root: string;
  access: "read" | "write";
  /** Deterministic mount path, used only by a mount-sync container runner. */
  guestPath: string;
}

export function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function workspaceFileGrants(
  inputs: readonly string[] = [],
  outputs: readonly string[] = [],
): WorkspaceFileGrant[] {
  const grants: WorkspaceFileGrant[] = [];
  for (const [access, roots, prefix] of [
    ["read", inputs, "inputs"],
    ["write", outputs, "outputs"],
  ] as const) {
    for (const [index, path] of roots.entries()) {
      const root = realpathSync(resolve(path));
      if (!statSync(root).isDirectory())
        throw new Error(`Task file root is not a directory: ${path}`);
      if (/[,:\r\n\0]/.test(root))
        throw new Error(`Task file root cannot contain mount separators: ${path}`);
      // Overlap makes read-only intent ambiguous and can shadow a second mount.
      if (grants.some((grant) => insideRoot(grant.root, root) || insideRoot(root, grant.root)))
        throw new Error(`Task input/output roots must not overlap: ${path}`);
      grants.push({ root, access, guestPath: `/marina-task/${prefix}/${index}` });
    }
  }
  return grants;
}
