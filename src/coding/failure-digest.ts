// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A failed check's digest, built while its output streams, before any truncation: the
 * failing test names (with file:line where the runner prints one), the first assertion
 * error, and a bounded tail. A suite of thousands of passing lines stores only its first
 * 64 KB; the digest still names the one test that failed in the middle or at the end.
 */
export interface FailureDigest {
  /** Failing tests, in the order the runner reported them (bounded). */
  failures: Array<{ name: string; location?: string }>;
  /** More failing tests than `failures` lists. */
  moreFailures?: number;
  /** The first assertion or error message, a few lines. */
  firstError?: string;
  /** The last lines of the output (at most TAIL_LINES lines and TAIL_BYTES bytes). */
  tail: string;
}

const MAX_FAILURES = 40;
const TAIL_LINES = 40;
const TAIL_BYTES = 4096;
const ERROR_LINES = 6;
const MAX_LINE = 400;
/** ANSI colour codes, which runners print around their result markers. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// bun `(fail) suite > name [1.2ms]`, pytest `FAILED path::test - msg` / `ERROR path::test`,
// go `--- FAIL: TestName (0.00s)`, jest/vitest `✕ name` / `× name`, cargo `test x ... FAILED`.
const FAILURE_LINE: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/, (m) => m[1]!],
  [/^(?:FAILED|ERROR) (\S.*)$/, (m) => m[1]!],
  [/^\s*--- FAIL: (\S+)/, (m) => m[1]!],
  [/^\s*[✕×] (.+?)(?: \(\d+ ?m?s\))?$/, (m) => m[1]!],
  [/^test (\S+) \.\.\. FAILED$/, (m) => m[1]!],
];
const LOCATION = /([\w@./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt)):(\d+)/;
const ERROR_START =
  /^\s*(?:error:|Error:|AssertionError|E {3}|panic:|thread '.+' panicked|Expected|assert)/;

/** Feed output as it arrives (any number of streams); read the digest at the end. */
export class FailureDigester {
  private failures: FailureDigest["failures"] = [];
  private extra = 0;
  private firstError: string[] | undefined;
  private collecting = false;
  private location: string | undefined;
  private lines: string[] = [];
  private carry = new Map<string, string>();

  feed(chunk: string, stream = "out"): void {
    const text = (this.carry.get(stream) ?? "") + chunk;
    const parts = text.split("\n");
    this.carry.set(stream, parts.pop() ?? "");
    for (const line of parts) this.line(line);
  }

  private line(raw: string): void {
    const line = raw.replace(ANSI, "").replace(/\r$/, "").slice(0, MAX_LINE);
    this.lines.push(line);
    if (this.lines.length > TAIL_LINES) this.lines.shift();
    if (this.collecting) {
      // The message and its expected/received lines, up to the stack or a blank line.
      if (line.trim() && !/^\s+at /.test(line) && this.firstError!.length < ERROR_LINES)
        this.firstError!.push(line);
      else this.collecting = false;
    } else if (!this.firstError && ERROR_START.test(line)) {
      this.firstError = [line];
      this.collecting = true;
    }
    const at = LOCATION.exec(line);
    if (at && !/node_modules|bun:test|internal\//.test(line)) this.location = `${at[1]}:${at[2]}`;
    for (const [pattern, name] of FAILURE_LINE) {
      const match = pattern.exec(line);
      if (!match) continue;
      const failure = name(match).trim();
      const fromLine = LOCATION.exec(failure);
      // Runners repeat failures in a closing summary (bun lists every `(fail)` again).
      const seen = this.failures.find((f) => f.name === failure);
      if (seen) {
        seen.location ??= fromLine ? `${fromLine[1]}:${fromLine[2]}` : this.location;
        this.location = undefined;
        break;
      }
      if (this.failures.length < MAX_FAILURES)
        this.failures.push({
          name: failure,
          ...(fromLine
            ? { location: `${fromLine[1]}:${fromLine[2]}` }
            : this.location
              ? { location: this.location }
              : {}),
        });
      else this.extra++;
      this.location = undefined;
      break;
    }
  }

  digest(): FailureDigest {
    for (const [stream, rest] of this.carry) {
      if (rest) this.line(rest);
      this.carry.set(stream, "");
    }
    let tail = this.lines.join("\n");
    if (Buffer.byteLength(tail) > TAIL_BYTES)
      tail = Buffer.from(tail).subarray(-TAIL_BYTES).toString("utf8");
    return {
      failures: [...this.failures],
      ...(this.extra ? { moreFailures: this.extra } : {}),
      ...(this.firstError ? { firstError: this.firstError.join("\n") } : {}),
      tail,
    };
  }
}

/** A digest of a complete output (tests, or output that was never truncated). */
export function digestOutput(output: string): FailureDigest {
  const digester = new FailureDigester();
  digester.feed(output);
  return digester.digest();
}

/** The lines a coder reads about a failed step. `base` names the tests that also fail there. */
export function formatFailureDigest(
  digest: FailureDigest,
  base?: { failures: Set<string>; commit: string },
): string {
  const lines: string[] = [];
  if (digest.failures.length) {
    lines.push(
      `Failing tests (${digest.failures.length + (digest.moreFailures ?? 0)}):`,
      ...digest.failures.map(
        (f) =>
          `- ${f.name}${f.location ? ` (${f.location})` : ""}${base ? (base.failures.has(f.name) ? ` — also fails on base ${base.commit.slice(0, 12)} (pre-existing)` : " — NEW: passes on the base") : ""}`,
      ),
      ...(digest.moreFailures ? [`- … and ${digest.moreFailures} more`] : []),
    );
  } else lines.push("No failing test name was found in the output.");
  if (digest.firstError) lines.push("First error:", digest.firstError);
  lines.push("Output tail:", digest.tail);
  return lines.join("\n");
}
