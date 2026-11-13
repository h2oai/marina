// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Build every SDK's installable package into dist/sdks/<language>/, without publishing:
//   typescript  marina-agent-sdk-<v>.tgz      (npm pack)
//   python      marina_sdk-<v>-py3-none-any.whl (pip wheel)
//   java        marina-sdk-<v>.jar + -sources.jar (javac --release 17, jar)
//   rust        marina-sdk-<v>.crate          (cargo package)
// The SDK release workflow (.github/workflows/sdk-release.yml) runs this, then publishes only
// when switched on. `--only python,rust` builds a subset.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "sdks");
const only = (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "")
  .split(",")
  .filter(Boolean);

async function run(argv: string[], cwd = ROOT) {
  const child = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`failed: ${argv.join(" ")}`);
}

function sources(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path, ext) : path.endsWith(ext) ? [path] : [];
  });
}

const builds: Record<string, (out: string) => Promise<void>> = {
  async typescript(out) {
    await run(["bun", "run", "scripts/pack-sdk.ts"]);
    cpSync(join(ROOT, "dist/sdk"), out, { recursive: true });
  },
  async python(out) {
    const build = mkdtempSync(join(tmpdir(), "marina-py-build-"));
    try {
      // A copy keeps build/ and *.egg-info out of the repository.
      cpSync(join(ROOT, "sdks/python"), build, { recursive: true });
      await run([
        process.env.PYTHON ?? "python3",
        "-m",
        "pip",
        "wheel",
        "--no-deps",
        "-w",
        out,
        build,
      ]);
    } finally {
      rmSync(build, { recursive: true, force: true });
    }
  },
  async java(out) {
    const classes = mkdtempSync(join(tmpdir(), "marina-java-build-"));
    try {
      const main = sources(join(ROOT, "sdks/java/src/main/java"), ".java");
      await run(["javac", "--release", "17", "-Xlint:all", "-Werror", "-d", classes, ...main]);
      await run([
        "jar",
        "--create",
        "--file",
        join(out, `marina-sdk-${version}.jar`),
        "-C",
        classes,
        ".",
      ]);
      await run([
        "jar",
        "--create",
        "--file",
        join(out, `marina-sdk-${version}-sources.jar`),
        "-C",
        join(ROOT, "sdks/java/src/main/java"),
        ".",
      ]);
    } finally {
      rmSync(classes, { recursive: true, force: true });
    }
  },
  async rust(out) {
    const target = mkdtempSync(join(tmpdir(), "marina-rust-build-"));
    try {
      await run([
        "cargo",
        "package",
        "--manifest-path",
        join(ROOT, "sdks/rust/Cargo.toml"),
        "--target-dir",
        target,
        "--allow-dirty",
      ]);
      cpSync(
        join(target, "package", `marina-sdk-${version}.crate`),
        join(out, `marina-sdk-${version}.crate`),
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  },
};

for (const [language, build] of Object.entries(builds)) {
  if (only.length && !only.includes(language)) continue;
  const out = join(OUT, language);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build(out);
  console.log(`${language}: ${readdirSync(out).join(", ")}`);
}
