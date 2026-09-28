// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SYFT_VERSION = "1.52.0";

/** Coverage oracle only: Syft owns parsing/cataloging and CycloneDX serialization. */
export function lockedComponents(lock: string): Set<string> {
  const parsed = Bun.JSONC.parse(lock) as { packages?: Record<string, unknown> };
  if (!parsed.packages) throw new Error("Bun lockfile has no packages");
  const expected = new Set<string>();
  for (const entry of Object.values(parsed.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new Error("Unsupported Bun lockfile entry");
    }
    const split = entry[0].lastIndexOf("@");
    if (split <= 0) throw new Error(`Unsupported package identifier: ${entry[0]}`);
    const version = entry[0].slice(split + 1);
    if (/^(workspace|root|link|file):/.test(version)) continue;
    expected.add(entry[0]);
  }
  return expected;
}

export function checkSbom(bom: unknown, expected: Set<string>): number {
  const document = bom as {
    bomFormat?: string;
    specVersion?: string;
    components?: {
      type?: string;
      name?: string;
      group?: string;
      version?: string;
      "bom-ref"?: string;
    }[];
  };
  if (
    document?.bomFormat !== "CycloneDX" ||
    document.specVersion !== "1.6" ||
    !Array.isArray(document.components)
  ) {
    throw new Error("Expected a CycloneDX 1.6 component inventory");
  }
  const found = new Set<string>();
  const refs = new Set<string>();
  for (const component of document.components) {
    const ref = component["bom-ref"];
    if (
      !component.name ||
      (!component.version && component.type !== "file") ||
      !ref ||
      refs.has(ref)
    ) {
      throw new Error("SBOM contains an incomplete or duplicate component reference");
    }
    refs.add(ref);
    if (component.type !== "file") {
      found.add(
        `${component.group ? `${component.group}/` : ""}${component.name}@${component.version}`,
      );
    }
  }
  const missing = [...expected].filter((key) => !found.has(key));
  if (!expected.size || missing.length)
    throw new Error(`SBOM coverage failed: ${missing.join(", ") || "empty lockfiles"}`);
  return found.size;
}

/** Scan only tracked lockfiles, never local databases, credentials or node_modules. */
export async function generateSbom(output = "dist/supply-chain/source.cdx.json") {
  const root = resolve(import.meta.dir, "..");
  const syft = process.env.SYFT_BIN || "syft";
  if (!Bun.which(syft)) {
    throw new Error(
      `Install Syft ${SYFT_VERSION} or set SYFT_BIN to that executable; see docs/guides/supply-chain.md`,
    );
  }
  const version = Bun.spawnSync([syft, "version", "-o", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (version.exitCode !== 0 || JSON.parse(version.stdout.toString()).version !== SYFT_VERSION) {
    throw new Error(
      `Install Syft ${SYFT_VERSION} or set SYFT_BIN to that executable; see docs/guides/supply-chain.md`,
    );
  }
  const tracked = Bun.spawnSync(["git", "ls-files", "-z", "--", "bun.lock", "**/bun.lock"], {
    cwd: root,
  });
  if (tracked.exitCode !== 0) throw new Error("Cannot enumerate tracked Bun lockfiles");
  const paths = tracked.stdout.toString().split("\0").filter(Boolean);
  if (!paths.includes("bun.lock")) throw new Error("Root Bun lockfile is missing");
  const staging = await mkdtemp(join(tmpdir(), "marina-sbom-"));
  try {
    const expected = new Set<string>();
    for (const path of paths) {
      const content = await readFile(join(root, path), "utf8");
      for (const component of lockedComponents(content)) expected.add(component);
      const target = join(staging, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    const generated = join(staging, "source.cdx.json");
    const child = Bun.spawn(
      [
        syft,
        "scan",
        `dir:${staging}`,
        "--override-default-catalogers",
        "javascript-lock-cataloger",
        "--source-name",
        "marina-repository-dependencies",
        "-o",
        `cyclonedx-json@1.6=${generated}`,
      ],
      {
        env: {
          ...process.env,
          SYFT_CACHE_DIR: join(staging, "cache"),
          SYFT_CHECK_FOR_APP_UPDATE: "false",
          SYFT_JAVASCRIPT_INCLUDE_DEV_DEPENDENCIES: "true",
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await child.exited) !== 0) throw new Error("Syft cataloging failed");
    const content = await readFile(generated, "utf8");
    const count = checkSbom(JSON.parse(content), expected);
    await writeFile(target, content);
    console.log(
      `CycloneDX inventory: ${count} component versions from ${paths.length} lockfiles → ${target}`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await generateSbom(process.argv[2]);
}
