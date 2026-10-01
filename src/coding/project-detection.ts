// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export function detectPackageScripts(packageJson: string): string[] {
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return Object.entries(parsed.scripts ?? {})
      .filter(([, value]) => typeof value === "string")
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function recommendedVerify(scripts: string[]): string[] {
  return ["typecheck", "lint", "test", "build"].filter((script) => scripts.includes(script));
}
