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
 *
 * The same rule covers promise handlers: `.catch(() => {})`,
 * `.catch(() => undefined)`, `.catch((_e) => null)` and every other handler
 * whose body is empty or a constant (`false`, `[]`, `({})`, `""`, `0`, …)
 * discard the error just as silently. Route the failure through a module
 * `Logger` (`logRejection` / `tryLogAsync` in `src/engine/errors.ts`), or
 * mark the handler `// allow-empty-catch: <reason>` on its line or the line
 * before it.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { logRejection } from "../src/engine/errors";
import { type LogEntry, Logger } from "../src/engine/logger";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const OPT_OUT = "allow-empty-catch:";

/** `catch`, optional binding, then a body that is whitespace only. */
const EMPTY_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/** A handler parameter list: `()`, `(e)`, `(_err: unknown)`, or a bare `e`. */
const HANDLER_PARAMS = String.raw`(?:\(\s*(?:[\w$]+\s*(?::\s*[\w$<>\[\]|. ]+)?)?\s*\)|[\w$]+)`;
/** A body that ignores the error: `{}` or a constant expression. */
const CONSTANT_BODY = String.raw`(?:\{\s*\}|undefined|null|false|true|void\s+0|\[\s*\]|\(\s*\{\s*\}\s*\)|""|''|-?\d+)`;
/** `.catch(<params> => <constant>)`, or `.catch(noop)`, across whitespace/newlines. */
const SWALLOWING_PROMISE_CATCH = new RegExp(
  String.raw`\.catch\(\s*(?:${HANDLER_PARAMS}\s*=>\s*${CONSTANT_BODY}|noop)\s*,?\s*\)`,
  "g",
);

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

/** Lines of promise `.catch` handlers that drop the error, unless opted out on that line or the one before. */
export function findSwallowedPromiseCatches(source: string): number[] {
  const lines: number[] = [];
  const text = source.split("\n");
  for (const match of source.matchAll(SWALLOWING_PROMISE_CATCH)) {
    const line = source.slice(0, match.index).split("\n").length;
    // A multi-line handler may carry the marker on any of its lines.
    const span = match[0].split("\n").length;
    const window = text.slice(Math.max(0, line - 2), line - 1 + span);
    if (window.some((l) => l.includes(OPT_OUT))) continue;
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

  it("flags promise catch handlers that discard the error", () => {
    expect(findSwallowedPromiseCatches("p.catch(() => {})")).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch(() => undefined);")).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch(() => null)")).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch(() => false)")).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch(() => [])")).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch(() => ({}))")).toEqual([1]);
    expect(findSwallowedPromiseCatches('p.catch(() => "")')).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch((_e) => {})")).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch((err: unknown) => undefined)")).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch(e => {})")).toEqual([1]);
    expect(findSwallowedPromiseCatches("p.catch(noop)")).toEqual([1]);
    expect(findSwallowedPromiseCatches("a\n  .catch(\n    () => undefined,\n  );")).toEqual([2]);
    expect(findSwallowedPromiseCatches("p.catch(() => {}); // allow-empty-catch: closed")).toEqual(
      [],
    );
    expect(
      findSwallowedPromiseCatches("// allow-empty-catch: already closed\np.catch(() => {});"),
    ).toEqual([]);
    expect(findSwallowedPromiseCatches("x();\n\np.catch(() => {});")).toEqual([3]);
    // Handlers that use the error, or compute a fallback, are not swallowers.
    expect(findSwallowedPromiseCatches("p.catch((e) => log(e))")).toEqual([]);
    expect(findSwallowedPromiseCatches("p.catch(logRejection(logger, 'x', 'y'))")).toEqual([]);
    expect(findSwallowedPromiseCatches("p.catch(() => fallback())")).toEqual([]);
    expect(findSwallowedPromiseCatches("p.catch(() => { retry(); })")).toEqual([]);
  });

  it("src/**/*.ts has no silent promise catch", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const line of findSwallowedPromiseCatches(source)) {
        offenders.push(`${relative(ROOT, file)}:${line}`);
      }
    }
    expect(
      offenders,
      `Promise catch handlers that discard the error (log with \`logRejection\` / a module Logger, or mark \`// ${OPT_OUT} <reason>\` on the line or the one before):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
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

describe("logRejection", () => {
  it("logs the rejection at the chosen level and resolves to the fallback", async () => {
    const logger = new Logger({ level: "error" });
    const seen: LogEntry[] = [];
    logger.addSink((entry) => seen.push(entry));
    // Below the configured level: nothing reaches a sink, the fallback still applies.
    const quiet = await Promise.reject(new Error("gone")).catch(
      logRejection(logger, "test", "lookup failed", { level: "debug", fallback: null }),
    );
    expect(quiet).toBeNull();
    expect(seen).toEqual([]);

    const loud = new Logger({ level: "debug", format: "json" });
    loud.addSink((entry) => seen.push(entry));
    const value = await Promise.reject(new Error("boom")).catch(
      logRejection(loud, "test", "cleanup failed", { fallback: [] as string[] }),
    );
    expect(value).toEqual([]);
    expect(seen.map((e) => [e.level, e.category, e.message, e.data?.error])).toEqual([
      ["warn", "test", "cleanup failed", "boom"],
    ]);
    expect(await Promise.reject("x").catch(logRejection(loud, "test", "m"))).toBeUndefined();
  });
});
