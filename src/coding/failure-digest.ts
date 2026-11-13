// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A failed check's digest, built while its output streams, before any truncation: the
 * failing test names (with file:line where the runner prints one), the first assertion
 * error, and a bounded tail. A suite of thousands of passing lines stores only its first
 * 64 KB; the digest still names the one test that failed in the middle or at the end.
 *
 * Beside the display list it keeps every failure's identity (repository-relative file plus
 * qualified test name) and signature (its first error line, normalised), for deciding whether
 * a failure also happens without a change. When the output could not be read completely
 * (too many failures, an oversized line, a failure without a file), `incomplete` says why,
 * and no attribution may rest on it.
 */
export interface FailureDigest {
  /** Failing tests, in the order the runner reported them (bounded, for display). */
  failures: Array<{ name: string; location?: string }>;
  /** More failing tests than `failures` lists. */
  moreFailures?: number;
  /** The first assertion or error message, a few lines. */
  firstError?: string;
  /** The last lines of the output (at most TAIL_LINES lines and TAIL_BYTES bytes). */
  tail: string;
  /** Every failure the output names, complete unless `incomplete` is set. */
  identities: FailureIdentity[];
  /** Why the failures could not all be identified. */
  incomplete?: string;
}

export interface FailureIdentity {
  /** Repository-relative test file, if the runner said. */
  file?: string;
  /** Qualified test name. */
  name: string;
  /** The failure's first error line, normalised (paths, durations, whitespace). */
  signature: string;
}

const MAX_FAILURES = 40;
const MAX_IDENTITIES = 5000;
const TAIL_LINES = 40;
const TAIL_BYTES = 4096;
const ERROR_LINES = 6;
/** A failure's signature: its error block, at most this many lines and characters. */
const SIGNATURE_LINES = 6;
const SIGNATURE_CHARS = 1000;
const MAX_LINE = 400;
/** The longest partial line held per stream while waiting for its newline. */
export const MAX_PARTIAL_LINE = 64 * 1024;
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
/**
 * bun prints each test file's path on its own line before its results, for every name its
 * runner collects: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*` (JS/TS, any module flavour);
 * go test files are `*_test.go`.
 */
const TEST_FILE = /(?:[._](?:test|spec)\.[cm]?[jt]sx?|_test\.go)$/;
/** A line that looks like a file header: `<path with an extension>:`, any length or spaces. */
const HEADER_LIKE = /\.[A-Za-z0-9]{1,8}$/;
/** Error headings that end in a colon but are part of the error, not a file header. */
const ERROR_HEADING = /^\s*(?:[-+]\s*)?(?:Expected|Received|Actual|Difference|Diff)\b[^:]*:$/i;

/**
 * A file header, as bun prints it before a test file's results: the test file's path and a
 * colon, whatever its length or spaces. `undefined`: not a header; `null`: it looks like one
 * (a path with an extension) but is not a test file this parser knows, so the file identity
 * is unknown from here on.
 */
function fileHeader(full: string): string | null | undefined {
  const trimmed = full.trim();
  if (!trimmed.endsWith(":") || ERROR_HEADING.test(trimmed)) return undefined;
  const path = trimmed.slice(0, -1);
  if (/^\s|^(?:error|warning|info|note)\b/i.test(path)) return undefined;
  if (TEST_FILE.test(path)) return path;
  return HEADER_LIKE.test(path) ? null : undefined;
}
/** Output that says something failed outside any named test (setup, load or build). */
const UNNAMED_FAILURE: Array<[RegExp, string]> = [
  [
    /^# Unhandled error between tests/,
    "an error outside any named test (Unhandled error between tests)",
  ],
  [/^FAIL\s+\S+\s+\[(?:build|setup) failed\]/, "a package that failed to build"],
  [/^E\s+(?:ImportError|ModuleNotFoundError|SyntaxError)\b/, "a test module that failed to import"],
];
/** bun's closing counts: failures and errors the runner tallied. */
const FAIL_COUNT = /^\s*(\d+) fail$/;
const ERROR_COUNT = /^\s*(\d+) errors?$/;
/** bun's closing summary repeats failures without their file. */
const SUMMARY = /^\d+ tests? failed:$/;
const ERROR_START =
  /^\s*(?:error:|Error:|AssertionError|E {3}|panic:|thread '.+' panicked|Expected|assert)/;
const SNAPSHOT_PREFIX = /\/\S*?\/marina-(?:candidate|base)-[^/]+\/source\//g;

/** Feed output as it arrives (any number of streams); read the digest at the end. */
export class FailureDigester {
  private failures: FailureDigest["failures"] = [];
  private identities: FailureIdentity[] = [];
  private extra = 0;
  private firstError: string[] | undefined;
  private collecting = false;
  private location: string | undefined;
  private file: string | undefined;
  private pendingError: string[] | undefined;
  private errorOpen = false;
  private failCount: number | undefined;
  private inSummary = false;
  private incomplete: string | undefined;
  private lines: string[] = [];
  private carry = new Map<string, string>();
  private overflow = new Set<string>();

  /** `root`: the directory the command ran in, stripped to make paths repository-relative. */
  constructor(private readonly root?: string) {}

  feed(chunk: string, stream = "out"): void {
    const parts = ((this.carry.get(stream) ?? "") + chunk).split("\n");
    let rest = parts.pop() ?? "";
    for (const line of parts) {
      // The remainder of a line that overflowed is dropped, up to its newline.
      if (this.overflow.delete(stream)) continue;
      this.line(line);
    }
    // Bound what waits for a newline: an endless line is cut and marks the digest incomplete.
    if (rest.length > MAX_PARTIAL_LINE) {
      if (!this.overflow.has(stream)) this.line(rest.slice(0, MAX_PARTIAL_LINE));
      this.overflow.add(stream);
      this.incomplete ??= `an output line longer than ${MAX_PARTIAL_LINE} bytes was cut`;
      rest = "";
    }
    this.carry.set(stream, rest);
  }

  private relative(path: string): string {
    const root = this.root?.replace(/\/$/, "");
    if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
    return path.replace(SNAPSHOT_PREFIX, "");
  }

  private normalise(text: string): string {
    const root = this.root?.replace(/\/$/, "");
    return (
      (root ? text.split(`${root}/`).join("") : text)
        .replace(SNAPSHOT_PREFIX, "")
        // Never a timing: a "[2ms]" inside an assertion's values is part of the failure. The
        // runner's own timings follow a test name on its result line, which is not signed.
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  private line(raw: string): void {
    // Identities and signatures are parsed from the whole line; only display is cut.
    const full = raw.replace(ANSI, "").replace(/\r$/, "");
    const line = full.slice(0, MAX_LINE);
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
    this.errorBlock(full);
    for (const [pattern, why] of UNNAMED_FAILURE) if (pattern.test(full)) this.incomplete ??= why;
    // One count per runner invocation; a step can run several (`bun test a; bun test b`).
    const fails = FAIL_COUNT.exec(full);
    if (fails) this.failCount = (this.failCount ?? 0) + Number(fails[1]);
    const errors = ERROR_COUNT.exec(full);
    if (errors && Number(errors[1]) > 0)
      this.incomplete ??= `${errors[1]} error(s) outside any named test`;
    if (SUMMARY.test(full.trim())) this.inSummary = true;
    const header = fileHeader(full);
    if (header !== undefined) {
      // An unparseable header ends the current file: later failures have no file, and the
      // digest is incomplete rather than attributing them to the previous file.
      this.file = header === null ? undefined : this.relative(header);
      this.inSummary = false;
      // A new file: an error left over from the last one belongs to no failure here.
      this.pendingError = undefined;
      this.errorOpen = false;
    }
    const at = LOCATION.exec(line);
    if (at && !/node_modules|bun:test|internal\//.test(line)) this.location = `${at[1]}:${at[2]}`;
    for (const [pattern, name] of FAILURE_LINE) {
      const match = pattern.exec(full);
      if (!match) continue;
      this.record(name(match).trim());
      break;
    }
    // A passing result closes the window an error belongs to.
    if (/^\(pass\) |^PASSED |^\s*--- PASS: |^ok\s/.test(full)) {
      this.errorOpen = false;
      this.pendingError = undefined;
      this.location = undefined;
    }
  }

  /**
   * The current error block, for the next failure's signature: the error line and what
   * follows it (expected/received values, the message), up to the stack, a code frame or the
   * result line, bounded. Blank lines inside the block are skipped, not an end.
   */
  private errorBlock(full: string): void {
    if (ERROR_START.test(full) && !this.errorOpen) {
      if (!this.pendingError) {
        this.pendingError = [this.normalise(full.slice(0, SIGNATURE_CHARS))];
        this.errorOpen = true;
      }
      return;
    }
    if (!this.errorOpen || !this.pendingError) return;
    // The stack, a code frame, a result line or a file header ends the block; an error's own
    // headings (`Expected:`, `Received:`) do not, and the value lines after them are kept.
    if (/^\s+at |^\s*\d+ \| |^\((?:fail|pass)\) /.test(full) || fileHeader(full) !== undefined) {
      this.errorOpen = false;
      return;
    }
    if (!full.trim()) return;
    const total = this.pendingError.reduce((sum, part) => sum + part.length, 0);
    if (this.pendingError.length < SIGNATURE_LINES && total < SIGNATURE_CHARS)
      this.pendingError.push(this.normalise(full.slice(0, SIGNATURE_CHARS)));
  }

  private record(failure: string): void {
    const fromLine = LOCATION.exec(failure.slice(0, MAX_LINE));
    const location = fromLine ? `${fromLine[1]}:${fromLine[2]}` : this.location;
    this.location = undefined;
    const signature = (this.pendingError ?? []).join(" | ").slice(0, SIGNATURE_CHARS);
    this.pendingError = undefined;
    this.errorOpen = false;
    // A closing summary repeats failures already seen; only an unseen one is recorded.
    if (this.inSummary && this.identities.some((identity) => identity.name === failure)) return;
    // pytest names its file in the node id; bun by its file header; else the location's file.
    const pytest = /^([^\s:]+\.py)::/.exec(failure.slice(0, MAX_LINE));
    const file = this.inSummary
      ? undefined
      : pytest
        ? this.relative(pytest[1]!)
        : (this.file ?? (location ? this.relative(location.replace(/:\d+$/, "")) : undefined));
    if (this.identities.length < MAX_IDENTITIES)
      this.identities.push({ ...(file ? { file } : {}), name: failure, signature });
    else this.incomplete ??= `more than ${MAX_IDENTITIES} failures`;
    if (!file) this.incomplete ??= `the failing test "${failure}" has no file`;
    if (this.failures.length < MAX_FAILURES)
      this.failures.push({
        name: failure,
        ...(location ? { location: this.relative(location) } : {}),
      });
    else this.extra++;
  }

  digest(exitCode?: number): FailureDigest {
    for (const [stream, rest] of this.carry) {
      if (rest && !this.overflow.has(stream)) this.line(rest);
      this.carry.set(stream, "");
    }
    let tail = this.lines.join("\n");
    if (Buffer.byteLength(tail) > TAIL_BYTES)
      tail = Buffer.from(tail).subarray(-TAIL_BYTES).toString("utf8");
    const named = new Set(this.identities.map((identity) => `${identity.file}::${identity.name}`))
      .size;
    const unnamed =
      exitCode !== undefined && exitCode !== 0 && !this.identities.length
        ? "the command failed without naming a failing test"
        : this.failCount !== undefined && this.failCount > named
          ? `the runner counted ${this.failCount} failures but named ${named}`
          : undefined;
    const incomplete = this.incomplete ?? unnamed;
    return {
      failures: [...this.failures],
      ...(this.extra ? { moreFailures: this.extra } : {}),
      ...(this.firstError ? { firstError: this.firstError.join("\n") } : {}),
      tail,
      identities: [...this.identities],
      ...(incomplete ? { incomplete } : {}),
    };
  }
}

/** A digest of a complete output (tests, or output that was never truncated). */
export function digestOutput(output: string, root?: string, exitCode?: number): FailureDigest {
  const digester = new FailureDigester(root);
  digester.feed(output);
  return digester.digest(exitCode);
}

export const failureKey = (identity: FailureIdentity) =>
  `${identity.file ?? "?"}::${identity.name}`;

export type Attribution =
  | { kind: "change"; reason: string; newFailures: string[] }
  | { kind: "preexisting"; reason: string }
  | { kind: "inconclusive"; reason: string };

/** A step's run on the base, as attribution reads it. */
export interface BaseRun {
  passed: boolean;
  digest?: FailureDigest;
}

/**
 * Whether a failed step's failures exist without the change, on positive evidence only:
 * every failure with the change is identified (file and test) and fails on the base twice,
 * the same way. A failure the base does not have (by file and test) is the change's.
 * Anything else (unnamed or uncountable failures, a base that could not be prepared, run or
 * read, a different error, a failure that does not repeat) is inconclusive.
 */
export function attributeFailure(input: {
  change: FailureDigest | undefined;
  /** The base run; undefined when the base could not be prepared or run. */
  base?: BaseRun;
  /** A second base run of the same failures, for consistency. */
  again?: BaseRun;
  baseUnavailable?: string;
}): Attribution {
  if (!input.base)
    return {
      kind: "inconclusive",
      reason: `the base could not be checked (${input.baseUnavailable ?? "unavailable"})`,
    };
  if (input.base.passed)
    return { kind: "change", reason: "the step passes on the base", newFailures: [] };
  const change = input.change;
  if (!change || change.incomplete || !change.identities.length)
    return {
      kind: "inconclusive",
      reason: `the failures with the change could not all be identified (${change?.incomplete ?? "no digest"})`,
    };
  const base = input.base.digest;
  if (!base || base.incomplete)
    return {
      kind: "inconclusive",
      reason: `the failures on the base could not all be identified (${base?.incomplete ?? "no digest"})`,
    };
  const onBase = new Map(base.identities.map((identity) => [failureKey(identity), identity]));
  const fresh = change.identities.filter((identity) => !onBase.has(failureKey(identity)));
  if (fresh.length)
    return {
      kind: "change",
      reason: "tests fail with the change that do not fail on the base",
      newFailures: fresh.map(failureKey),
    };
  const differ = change.identities.find(
    (identity) => onBase.get(failureKey(identity))!.signature !== identity.signature,
  );
  if (differ)
    return {
      kind: "inconclusive",
      reason: `${failureKey(differ)} fails differently on the base ("${onBase.get(failureKey(differ))!.signature}", with the change "${differ.signature}")`,
    };
  const again = input.again;
  if (!again || again.passed || !again.digest || again.digest.incomplete)
    return {
      kind: "inconclusive",
      reason: again
        ? "the failure did not repeat on a second base run (intermittent)"
        : "the base failure was not confirmed by a second run",
    };
  const twice = new Map(
    again.digest.identities.map((identity) => [failureKey(identity), identity]),
  );
  const unstable = change.identities.find(
    (identity) => twice.get(failureKey(identity))?.signature !== identity.signature,
  );
  if (unstable)
    return {
      kind: "inconclusive",
      reason: `${failureKey(unstable)} did not fail the same way on a second base run (intermittent)`,
    };
  return {
    kind: "preexisting",
    reason: "every failing test fails the same way on the base, twice",
  };
}

/** The lines a coder reads about a failed step. `base` names the tests that also fail there. */
export function formatFailureDigest(
  digest: FailureDigest,
  base?: { identities: FailureIdentity[]; commit: string },
): string {
  const onBase = base ? new Set(base.identities.map(failureKey)) : undefined;
  const lines: string[] = [];
  if (digest.failures.length) {
    lines.push(
      `Failing tests (${digest.failures.length + (digest.moreFailures ?? 0)}):`,
      ...digest.failures.map((shown, index) => {
        const identity = digest.identities[index];
        const where = shown.location ?? identity?.file;
        const mark =
          onBase && base && identity
            ? onBase.has(failureKey(identity))
              ? ` — also fails on base ${base.commit.slice(0, 12)}`
              : " — NEW: does not fail on the base"
            : "";
        return `- ${shown.name}${where ? ` (${where})` : ""}${mark}`;
      }),
      ...(digest.moreFailures ? [`- … and ${digest.moreFailures} more`] : []),
    );
  } else lines.push("No failing test name was found in the output.");
  if (digest.incomplete) lines.push(`Incomplete: ${digest.incomplete}.`);
  if (digest.firstError) lines.push("First error:", digest.firstError);
  lines.push("Output tail:", digest.tail);
  return lines.join("\n");
}
