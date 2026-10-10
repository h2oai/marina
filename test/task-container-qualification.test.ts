// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerWorkspace, resolveContainerRunner } from "../src/coding/container-workspace";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { detectProjectRunner } from "../src/coding/project-detection";
import { executePreparation, planPreparation } from "../src/coding/verification-plan";
import { workspaceFileGrants } from "../src/coding/workspace-file-grants";

// Explicit opt-in, a locally available Python/pip image. No image downloads or model calls.
const image = process.env.MARINA_TEST_CONTAINER_IMAGE;
it.skipIf(!image || !Bun.which("podman") || !Bun.which("python3"))(
  "qualifies locked Python preparation, non-root execution and separate inputs/outputs in a real guest",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-python-guest-"));
    const root = join(dir, "work");
    const inputs = join(dir, "inputs");
    const outputs = join(dir, "outputs");
    for (const path of [
      root,
      inputs,
      outputs,
      join(root, ".git"),
      join(root, "wheels"),
      join(root, "tests"),
    ])
      mkdirSync(path);
    try {
      writeFileSync(join(inputs, "numbers.txt"), "7,4");
      const wheel = join(root, "wheels", "marina_fixture-1.0-py3-none-any.whl");
      const build = Bun.spawnSync([
        "python3",
        "-c",
        `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('marina_fixture.py', 'def total(values):\\n    if any(value < 0 for value in values): raise ValueError("negative")\\n    return sum(values)\\n')
 z.writestr('marina_fixture-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: marina-fixture\\nVersion: 1.0\\n')
 z.writestr('marina_fixture-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: qualification\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
 z.writestr('marina_fixture-1.0.dist-info/RECORD', '')`,
        wheel,
      ]);
      expect(build.exitCode).toBe(0);
      const hash = createHash("sha256").update(readFileSync(wheel)).digest("hex");
      writeFileSync(
        join(root, "requirements.txt"),
        `./wheels/marina_fixture-1.0-py3-none-any.whl --hash=sha256:${hash}\n`,
      );
      writeFileSync(
        join(root, "pyproject.toml"),
        "[project]\nname='qualification'\nversion='1.0'\n",
      );
      writeFileSync(
        join(root, "tests/runtests.py"),
        `import json, os, pathlib
from marina_fixture import total
assert os.geteuid() != 0
assert total([]) == 0
assert total([7,4]) == 11
try:
 total([-1])
 raise AssertionError('negative amount accepted')
except ValueError:
 pass
source = pathlib.Path('/marina-task/inputs/0/numbers.txt')
try:
 source.write_text('corrupt')
 raise AssertionError('input was writable')
except OSError:
 pass
values = [int(value) for value in source.read_text().split(',')]
pathlib.Path('/marina-task/outputs/0/result.json').write_text(json.dumps({'total': total(values)}))
print('guest dependency, invariants and file grants verified')
`,
      );
      const grants = workspaceFileGrants([inputs], [outputs]);
      const ws = new ContainerWorkspace(
        root,
        resolveContainerRunner({
          image: image!,
          runtime: "podman",
          network: true,
          timeoutMs: 60_000,
        }),
        undefined,
        grants,
      );
      const profile = detectProjectRunner({
        markers: new Set(["pyproject.toml", "requirements.txt", "tests/runtests.py"]),
      });
      const plan = planPreparation(profile, "pip", {
        installsPermitted: ws.installsPermitted(),
        hostCandidate: false,
      });
      await expect(new LocalWorkspace(root).runPreparationStep([...plan.install!])).rejects.toThrow(
        "not permitted",
      );
      const preparation = await executePreparation(plan, ws);
      expect(preparation.status, preparation.runs.map((run) => run.output).join("\n")).toBe(
        "installed",
      );
      const result = await ws.run([
        ...preparation.wrapTests!.split(" "),
        "python",
        "tests/runtests.py",
      ]);
      expect(result.exitCode, result.output).toBe(0);
      expect(JSON.parse(readFileSync(join(outputs, "result.json"), "utf8"))).toEqual({ total: 11 });
      expect(readFileSync(join(inputs, "numbers.txt"), "utf8")).toBe("7,4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  180_000,
);
