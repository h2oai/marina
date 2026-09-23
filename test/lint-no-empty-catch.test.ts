// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Static fence: no `catch {}` with an empty body anywhere under `src/`.
 *
 * A swallowed error is either a non-critical side effect (wrap it in `tryLog`
 * / `tryLogAsync` so it warns with a label) or intentional control flow, in
 * which case the catch body must contain an explicit fallback and a comment
 * saying why silence is correct. A body that holds only a comment counts as
 * documented — the comment IS the reason. A body that is truly empty fails
 * unless the `catch` line carries `// allow-empty-catch: <reason>`.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const OPT_OUT = "allow-empty-catch:";

/** `catch`, optional binding, then a body that is whitespace only. */
const EMPTY_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listTsFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

export function findEmptyCatches(source: string): number[] {
  const lines: number[] = [];
  for (const match of source.matchAll(EMPTY_CATCH)) {
    const before = source.slice(0, match.index);
    const line = before.split("\n").length;
    const lineText = source.split("\n")[line - 1] ?? "";
    if (lineText.includes(OPT_OUT)) continue;
    lines.push(line);
  }
  return lines;
}

describe("lint: no empty catch bodies under src/", () => {
  it("regex catches the shapes we mean and tolerates documented bodies", () => {
    expect(findEmptyCatches("try { a(); } catch {}")).toEqual([1]);
    expect(findEmptyCatches("try { a(); } catch (e) {}")).toEqual([1]);
    expect(findEmptyCatches("try {\n  a();\n} catch (err) {\n\n}\n")).toEqual([3]);
    expect(findEmptyCatches("try { a(); } catch {} // allow-empty-catch: probing")).toEqual([]);
    expect(findEmptyCatches("try { a(); } catch {\n  // duplicate link is fine\n}")).toEqual([]);
    expect(findEmptyCatches("try { a(); } catch { return undefined; }")).toEqual([]);
    expect(findEmptyCatches("p.catch(() => {})")).toEqual([]);
  });

  it("src/**/*.ts has no silent catch", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const line of findEmptyCatches(source)) {
        offenders.push(`${relative(ROOT, file)}:${line}`);
      }
    }
    expect(
      offenders,
      `Empty catch bodies (wrap in tryLog, add a fallback + reason, or mark \`// ${OPT_OUT} <reason>\`):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
