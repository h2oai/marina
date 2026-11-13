// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// setup.sh is the one-command installer (`curl … | bash`). These checks run offline: syntax,
// help, refusals, and the helpers. The full install was exercised by hand (docs/guides/install.md).

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("setup.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function bash(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), ...env },
    stdin: "ignore",
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

/** Run one of the script's helpers without running main(). */
function helper(call: string) {
  const body = readFileSync(SCRIPT, "utf8").replace(/\nmain "\$@"\n?$/, "\n");
  const dir = mkdtempSync(join(tmpdir(), "marina-setup-fn-"));
  dirs.push(dir);
  const file = join(dir, "fns.sh");
  writeFileSync(file, `${body}\n${call}\n`);
  return bash([file]);
}

describe("setup.sh", () => {
  test("parses, and the last line is the only call", () => {
    expect(bash(["-n", SCRIPT]).code).toBe(0);
    expect(readFileSync(SCRIPT, "utf8").trimEnd().endsWith('main "$@"')).toBe(true);
  });

  test("--help prints the usage, even when piped (no file to read)", () => {
    const piped = Bun.spawnSync(["bash", "-s", "--", "--help"], {
      stdin: readFileSync(SCRIPT),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir() },
    });
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout.toString()).toContain("--yes");
  });

  test("refuses an unknown option and a folder that is not Marina", () => {
    const unknown = bash([SCRIPT, "--frobnicate"]);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("Unknown option: --frobnicate");

    const other = mkdtempSync(join(tmpdir(), "marina-setup-other-"));
    dirs.push(other);
    writeFileSync(join(other, "notes.txt"), "mine");
    const refused = bash([SCRIPT, "--yes", "--dir", other]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("is not Marina");
  });

  test("version_at_least compares dotted versions numerically", () => {
    expect(helper("version_at_least 1.4.10 1.4.4").code).toBe(0);
    expect(helper("version_at_least 1.4.4 1.4.4").code).toBe(0);
    expect(helper("version_at_least 1.3.9 1.4.4").code).toBe(1);
    expect(helper("version_at_least 2.0 1.4.4").code).toBe(0);
  });

  test("the marina command is one script in the home's bin, running the code with its Bun", () => {
    const home = mkdtempSync(join(tmpdir(), "marina-setup-cmd-"));
    dirs.push(home);
    expect(helper(`write_command "${home}" /opt/bun/bin/bun "${home}/app"`).code).toBe(0);
    const command = readFileSync(join(home, "bin", "marina"), "utf8");
    expect(command).toContain(
      `exec "/opt/bun/bin/bun" --no-env-file "${home}/app/scripts/marina.ts" "$@"`,
    );
    expect(statSync(join(home, "bin", "marina")).mode & 0o111).toBeTruthy();
  });

  test("an older setup's marina link to moved code is removed; a developer's link stays", () => {
    const home = mkdtempSync(join(tmpdir(), "marina-setup-links-"));
    dirs.push(home);
    const bin = join(home, ".bun", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(home, "marina", "scripts", "marina.ts"), join(bin, "marina"));
    const body = readFileSync(SCRIPT, "utf8").replace(/\nmain "\$@"\n?$/, "\n");
    const file = join(home, "fns.sh");
    writeFileSync(file, `${body}\nremove_old_links "${home}/.marina"\n`);
    expect(bash([file], { HOME: home }).code).toBe(0);
    expect(existsSync(join(bin, "marina"))).toBe(false);
    expect(() => lstatSync(join(bin, "marina"))).toThrow();

    const checkout = join(home, "src", "marina", "scripts");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "marina.ts"), "");
    symlinkSync(join(checkout, "marina.ts"), join(bin, "marina"));
    expect(bash([file], { HOME: home }).code).toBe(0);
    expect(lstatSync(join(bin, "marina")).isSymbolicLink()).toBe(true);
  });

  test("--uninstall with no Marina to run says how to remove it by hand", () => {
    const home = mkdtempSync(join(tmpdir(), "marina-setup-un-"));
    dirs.push(home);
    const out = bash([SCRIPT, "--uninstall"], { HOME: home, PATH: "/usr/bin:/bin" });
    expect(out.code).toBe(1);
    expect(out.out).toContain("To remove it by hand");
  });

  test("add_to_path writes one line per missing folder, once", () => {
    const home = mkdtempSync(join(tmpdir(), "marina-setup-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    const env = { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
    const call = `add_to_path "${home}/.bun/bin" "${home}/.bun/bin" /usr/bin`;
    const body = readFileSync(SCRIPT, "utf8").replace(/\nmain "\$@"\n?$/, "\n");
    const file = join(home, "fns.sh");
    writeFileSync(file, `${body}\n${call}\n${call}\n`);
    expect(bash([file], env).code).toBe(0);
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(rc.match(/export PATH=/g)?.length).toBe(1);
    expect(rc).toContain(`export PATH="${home}/.bun/bin:$PATH"`);
    expect(rc).not.toContain("/usr/bin:$PATH");
  });
});
