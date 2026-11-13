// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's footprint on a machine: moving an older install into the one home
 * (`setup.sh` runs `migrate`) and removing all of it (`marina uninstall`).
 *
 * The layout is in src/config/marina-home.ts. Removal touches only what Marina
 * made: its home, the `marina` command it linked, the PATH lines setup.sh
 * marked "# Added by Marina setup", the locations older versions wrote to, and
 * Code Mode's worktree records in your repositories (your branches stay).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { hostGitArgv, hostGitEnv } from "../src/coding/host-git";
import { legacyLocations, marinaHome } from "../src/config/marina-home";
import { acquireDatabaseLease } from "../src/persistence/database-lease";

type Env = Record<string, string | undefined>;

/** What a world folder holds, besides code: moved together, removed together. */
export const WORLD_FILES = [
  "marina.db",
  "marina.db-wal",
  "marina.db-shm",
  "marina.db.key-secret",
  "marina.db.local-api-key",
  "marina.db.instance-lock",
  "marina-auth.db",
  "marina-auth.db-wal",
  "marina-auth.db-shm",
  ".env",
  "data",
  "endpoint.json",
];

/** Entries of the home that are people's work; `--keep-data` leaves them. */
export const DATA_ENTRIES = ["world", "projects", "mcp", "desktop", "worktrees", ".env"];

/** A home entry that is people's work: the above, and moved older worlds (`world-old…`). */
export function isDataEntry(name: string): boolean {
  return DATA_ENTRIES.includes(name) || name.startsWith("world-");
}

function userHome(env: Env): string {
  return env.HOME?.trim() || homedir();
}

/** Bytes under a path, not following links (a file's own size; 0 when missing). */
export function pathBytes(path: string): number {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // allow-empty-catch: unreadable directory counts as empty
    }
    for (const name of names) {
      try {
        const s = lstatSync(join(dir, name));
        if (s.isDirectory()) stack.push(join(dir, name));
        else if (s.isFile()) total += s.size;
      } catch {
        // allow-empty-catch: removed while walking
      }
    }
  }
  return total;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** A Marina source folder: the files setup.sh's download always has. */
function isMarinaCode(dir: string): boolean {
  return existsSync(join(dir, ".bun-version")) && existsSync(join(dir, "scripts", "marina.ts"));
}

/**
 * A folder setup.sh made (as opposed to someone's own clone): no git, or a git
 * checkout with no edited tracked files and no commits of its own.
 */
export function isSetupInstall(dir: string): boolean {
  if (!isMarinaCode(dir)) return false;
  if (!existsSync(join(dir, ".git"))) return true;
  const git = (...args: string[]) =>
    spawnSync("git", hostGitArgv(["git", ...args], dir).slice(1), {
      cwd: dir,
      env: hostGitEnv(),
      encoding: "utf8",
      timeout: 10_000,
    });
  const status = git("status", "--porcelain", "--untracked-files=no");
  if (status.status !== 0 || status.stdout.trim()) return false;
  // No commits of its own: HEAD is on the upstream branch, or is what setup.sh
  // last downloaded (FETCH_HEAD; an install from another ref is ahead of main).
  const ahead = git("rev-list", "--count", "@{upstream}..HEAD");
  if (ahead.status === 0 && ahead.stdout.trim() === "0") return true;
  return git("merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD").status === 0;
}

/** Whether a world's database is open in a running server (its lease is held). */
export function worldInUse(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  if (!existsSync(`${dbPath}.instance-lock`)) return false;
  try {
    acquireDatabaseLease(dbPath)();
    return false;
  } catch {
    return true;
  }
}

/** `world/`, or the first of `world-old`, `world-old-2`, … that holds no world yet. */
export function freeWorldDir(home: string): string {
  const free = (dir: string) => !existsSync(join(dir, "marina.db"));
  if (free(join(home, "world"))) return join(home, "world");
  for (let n = 1; ; n++) {
    const dir = join(home, n === 1 ? "world-old" : `world-old-${n}`);
    if (free(dir)) return dir;
  }
}

// ─── migrate: an older install into the home ──────────────────────────────────

export interface MigrateResult {
  app: string;
  moved: string[];
  notes: string[];
}

/**
 * Move a setup.sh install from `legacyDir` (the old default `~/marina`) into
 * the home: its world files into `world/`, then the code into `app/`. Refuses
 * while the world is running. Never moves someone's own clone (local edits
 * or commits), and never overwrites anything already in the home.
 */
export function migrateLegacyInstall(
  legacyDir: string,
  env: Env = process.env,
  opts: { worldOnly?: boolean } = {},
): MigrateResult {
  const home = marinaHome(env);
  const app = join(home, "app");
  const result: MigrateResult = { app: legacyDir, moved: [], notes: [] };
  if (!isMarinaCode(legacyDir)) return result;
  if (resolve(legacyDir) === resolve(app)) return { ...result, app };
  if (!isSetupInstall(legacyDir)) {
    result.notes.push(`${legacyDir} has your own changes; it stays where it is.`);
    return result;
  }
  if (worldInUse(join(legacyDir, "marina.db")))
    throw new Error(
      `Marina is running from ${legacyDir}. Stop it (Ctrl+C in its window), then run setup again.`,
    );
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (WORLD_FILES.some((name) => existsSync(join(legacyDir, name)))) {
    // The home's world/ unless it already holds one: then world-old (-2, …).
    // An older world is never overwritten and never left in the code.
    const world = freeWorldDir(home);
    mkdirSync(world, { recursive: true, mode: 0o700 });
    for (const name of WORLD_FILES) {
      const from = join(legacyDir, name);
      if (!existsSync(from) || existsSync(join(world, name))) continue;
      renameSync(from, join(world, name));
      result.moved.push(`${from} → ${join(world, name)}`);
    }
  }
  if (opts.worldOnly) return result;
  if (existsSync(app)) {
    result.notes.push(`${app} already exists; ${legacyDir} was left as it is.`);
    return result;
  }
  renameSync(legacyDir, app);
  result.moved.push(`${legacyDir} → ${app}`);
  result.app = app;
  return result;
}

// ─── uninstall ────────────────────────────────────────────────────────────────

export interface RemoveItem {
  path: string;
  bytes: number;
  kind: "program" | "data" | "old";
}

export interface PathEdit {
  file: string;
  /** Line numbers (0-based) to delete. */
  lines: number[];
  text: string[];
}

export interface WorktreeRecord {
  path: string;
  repo: string;
  branch: string;
  /** Uncommitted changes; undefined past the first DIRTY_CHECK_LIMIT worktrees (not checked). */
  dirty?: boolean;
}

/** Worktrees whose uncommitted changes are checked (one `git status` each). */
export const DIRTY_CHECK_LIMIT = 200;

export interface Server {
  dir: string;
  pid: number;
  url: string;
}

export interface UninstallPlan {
  home: string;
  remove: RemoveItem[];
  keep: { path: string; why: string }[];
  pathEdits: PathEdit[];
  links: string[];
  worktrees: WorktreeRecord[];
  servers: Server[];
  /** Worlds open in a server that cannot be stopped from here (no recorded pid). */
  busy: string[];
}

/** Startup files setup.sh may have written a PATH line to. */
function startupFiles(env: Env): string[] {
  const home = userHome(env);
  return [
    join(env.ZDOTDIR?.trim() || home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(home, ".config", "fish", "config.fish"),
  ];
}

/**
 * The "# Added by Marina setup" blocks to delete from one startup file: the
 * marker, the PATH line after it when that line names a folder inside the
 * home, and the blank line setup.sh put before the marker. A PATH line for
 * any other folder (`~/.bun/bin`, `~/.local/bin`: other programs may need it)
 * is kept, and so is its marker.
 */
export function pathEditsFor(
  file: string,
  text: string,
  home: string,
  emptyAfter: (dir: string) => boolean = () => false,
): PathEdit | undefined {
  const lines = text.split("\n");
  const drop: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "# Added by Marina setup") continue;
    const next = lines[i + 1] ?? "";
    // A folder in the home, or one an older setup added that holds nothing
    // once Marina's link is gone (no Bun or anything else in it).
    const folder = pathLineFolder(next);
    if (!namesFolder(next, home) && !(folder && emptyAfter(folder))) continue;
    if (i > 0 && lines[i - 1]!.trim() === "") drop.push(i - 1);
    drop.push(i, i + 1);
  }
  if (!drop.length) return undefined;
  return { file, lines: drop, text: drop.map((n) => lines[n]!) };
}

/** The folder a setup PATH line adds (`export PATH="<dir>:$PATH"`, fish `fish_add_path <dir>`). */
export function pathLineFolder(line: string): string | undefined {
  return /export PATH="([^":]+):\$PATH"/.exec(line)?.[1] ?? /fish_add_path\s+(\S+)/.exec(line)?.[1];
}

/** Whether `line` names `folder` itself or something inside it (not `folder-other`). */
export function namesFolder(line: string, folder: string): boolean {
  for (let at = line.indexOf(folder); at >= 0; at = line.indexOf(folder, at + 1)) {
    const after = line[at + folder.length];
    if (after === undefined || after === "/" || after === '"' || after === "'" || /\s/.test(after))
      return true;
  }
  return false;
}

/** A `marina` command Marina put on PATH: the home's own, or a link to a Marina checkout. */
function marinaLinks(env: Env, home: string): string[] {
  const user = userHome(env);
  const found: string[] = [];
  for (const dir of [
    join(home, "bin"),
    join(env.BUN_INSTALL?.trim() || join(user, ".bun"), "bin"),
    join(user, ".local", "bin"),
  ]) {
    const path = join(dir, "marina");
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (path.startsWith(home + sep)) found.push(path);
    else if (stat.isSymbolicLink() && readlinkSync(path).endsWith(join("scripts", "marina.ts")))
      found.push(path);
  }
  return found;
}

function gitWorktrees(home: string): WorktreeRecord[] {
  const root = join(home, "worktrees");
  const records: WorktreeRecord[] = [];
  if (!existsSync(root)) return records;
  for (const repoHash of readdirSync(root)) {
    const dir = join(root, repoHash);
    if (!statSync(dir).isDirectory()) continue;
    for (const session of readdirSync(dir)) {
      const path = join(dir, session);
      const dotGit = join(path, ".git");
      if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) continue;
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      const marker = `${sep}.git${sep}worktrees${sep}`;
      if (!gitdir?.includes(marker)) continue;
      const repo = gitdir.slice(0, gitdir.indexOf(marker));
      let head = "";
      try {
        head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
      } catch {
        // The repository (or its record of this worktree) is gone: nothing to keep.
        records.push({ path, repo, branch: "(repository gone)", dirty: false });
        continue;
      }
      const record: WorktreeRecord = {
        path,
        repo,
        branch: head.startsWith("ref: refs/heads/") ? head.slice(16) : "(detached)",
      };
      if (records.length < DIRTY_CHECK_LIMIT)
        // Hardened host git: a session wrote in this worktree, and a plain `status` would run
        // its fsmonitor, configured hooks or content filters (src/coding/host-git.ts).
        record.dirty =
          spawnSync("git", hostGitArgv(["git", "status", "--porcelain"], path).slice(1), {
            cwd: path,
            env: hostGitEnv(),
            encoding: "utf8",
            timeout: 10_000,
          }).stdout?.trim() !== "";
      records.push(record);
    }
  }
  return records;
}

function liveServers(home: string): { servers: Server[]; busy: string[] } {
  const servers: Server[] = [];
  const busy: string[] = [];
  const worlds = [join(home, "world"), join(home, "mcp"), join(home, "desktop")];
  const projects = join(home, "projects");
  if (existsSync(projects))
    for (const name of readdirSync(projects)) worlds.push(join(projects, name));
  for (const dir of worlds) {
    let pid = 0;
    let url = "";
    try {
      const info = JSON.parse(readFileSync(join(dir, "endpoint.json"), "utf8")) as {
        pid?: number;
        url?: string;
      };
      pid = Number(info.pid);
      url = String(info.url ?? "");
    } catch {
      // allow-empty-catch: no endpoint file — checked by its lease below
    }
    if (pid > 0 && processAlive(pid) && isMarinaProcess(pid)) servers.push({ dir, pid, url });
    else if (worldInUse(join(dir, "marina.db"))) busy.push(dir);
  }
  return { servers, busy };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Only ever stop a process whose command line is Marina's. */
function isMarinaProcess(pid: number): boolean {
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return /marina|src\/main\.ts/i.test(ps.stdout ?? "");
}

export function planUninstall(
  opts: { env?: Env; keepData?: boolean; checkout?: string } = {},
): UninstallPlan {
  const env = opts.env ?? process.env;
  const home = marinaHome(env);
  const plan: UninstallPlan = {
    home,
    remove: [],
    keep: [],
    pathEdits: [],
    links: marinaLinks(env, home),
    worktrees: gitWorktrees(home),
    ...liveServers(home),
  };
  if (existsSync(home)) {
    for (const name of readdirSync(home)) {
      const path = join(home, name);
      const data = isDataEntry(name);
      if (data && opts.keepData) plan.keep.push({ path, why: "kept (--keep-data)" });
      else plan.remove.push({ path, bytes: pathBytes(path), kind: data ? "data" : "program" });
    }
  }
  // The pre-home install folder, when setup.sh made it.
  const legacyApp = env.MARINA_DIR?.trim() || join(userHome(env), "marina");
  if (existsSync(legacyApp) && resolve(legacyApp) !== resolve(home)) {
    if (isSetupInstall(legacyApp)) {
      plan.remove.push({ path: legacyApp, bytes: pathBytes(legacyApp), kind: "old" });
    } else if (isMarinaCode(legacyApp))
      plan.keep.push({ path: legacyApp, why: "your own Marina checkout (has your changes)" });
  }
  if (opts.checkout && isMarinaCode(opts.checkout)) {
    const inside = resolve(opts.checkout).startsWith(resolve(home) + sep);
    const listed = plan.remove.some((r) => resolve(r.path) === resolve(opts.checkout!));
    if (!inside && !listed)
      plan.keep.push({ path: opts.checkout, why: "the Marina checkout this runs from" });
  }
  for (const path of legacyLocations(env))
    if (existsSync(path) && !plan.remove.some((r) => r.path === path))
      plan.remove.push({ path, bytes: pathBytes(path), kind: "old" });
  for (const file of startupFiles(env)) {
    if (!existsSync(file)) continue;
    const emptyAfter = (dir: string) => {
      try {
        return readdirSync(dir).every((name) => plan.links.includes(join(dir, name)));
      } catch {
        return true;
      }
    };
    const edit = pathEditsFor(file, readFileSync(file, "utf8"), home, emptyAfter);
    if (edit) plan.pathEdits.push(edit);
  }
  return plan;
}

export function renderPlan(plan: UninstallPlan): string[] {
  const lines: string[] = [];
  const total = plan.remove.reduce((sum, r) => sum + r.bytes, 0);
  lines.push(`This removes Marina from this computer (${formatSize(total)}):`, "");
  const group = (kind: RemoveItem["kind"], title: string) => {
    const items = plan.remove.filter((r) => r.kind === kind);
    if (!items.length) return;
    lines.push(`  ${title}`);
    for (const r of items) lines.push(`    ${r.path}  ${formatSize(r.bytes)}`);
  };
  group("data", "Your worlds, settings and Code Mode worktrees");
  group("program", "Marina itself");
  group("old", "Left by older versions");
  if (plan.links.length) lines.push("  The marina command", ...plan.links.map((l) => `    ${l}`));
  if (plan.pathEdits.length)
    lines.push(
      "  The PATH line setup added",
      ...plan.pathEdits.map((e) => `    ${e.file}: ${e.text.filter((t) => t.trim()).join(" / ")}`),
    );
  if (plan.servers.length)
    lines.push(
      "  Running Marina servers (stopped first)",
      ...plan.servers.map((s) => `    ${s.url || s.dir} (pid ${s.pid})`),
    );
  const dirty = plan.worktrees.filter((w) => w.dirty);
  if (plan.worktrees.length) {
    lines.push(
      "",
      `  ${plan.worktrees.length} Code Mode worktree(s) are unregistered from your repositories; their branches stay.`,
    );
    if (dirty.length)
      lines.push(
        `  ${dirty.length} hold changes nobody committed:`,
        ...dirty.slice(0, 10).map((w) => `    ${w.path} (${w.branch} in ${w.repo})`),
        ...(dirty.length > 10 ? [`    … and ${dirty.length - 10} more`] : []),
      );
    if (plan.worktrees.length > DIRTY_CHECK_LIMIT)
      lines.push(
        `  (only the first ${DIRTY_CHECK_LIMIT} were checked for uncommitted changes; use --keep-data to keep them all)`,
      );
  }
  if (plan.keep.length)
    lines.push("", "  Not touched:", ...plan.keep.map((k) => `    ${k.path} — ${k.why}`));
  return lines;
}

/** After removal: what is left on purpose, and how to remove it. */
export function afterwordFor(plan: UninstallPlan, env: Env = process.env): string[] {
  const lines: string[] = [];
  const bun = join(env.BUN_INSTALL?.trim() || join(userHome(env), ".bun"));
  if (existsSync(join(bun, "bin", "bun")))
    lines.push(
      `Bun (${bun}) is still installed: other programs may use it. If you installed it only for Marina: rm -rf ${bun}`,
    );
  const cache = join(bun, "install", "cache");
  if (existsSync(cache)) {
    const size = pathBytes(cache);
    if (size > 50 * 1024 ** 2)
      lines.push(
        `Bun's package cache (${cache}, ${formatSize(size)}) may still hold packages an older Marina setup installed. Clear it with: bun pm cache rm`,
      );
  }
  const branches = new Map<string, Set<string>>();
  for (const w of plan.worktrees)
    if (w.branch.startsWith("marina/"))
      branches.set(w.repo, (branches.get(w.repo) ?? new Set()).add(w.branch));
  for (const [repo, names] of branches)
    lines.push(
      `${repo} keeps ${names.size} Code Mode branch(es) (${[...names].slice(0, 3).join(", ")}${names.size > 3 ? ", …" : ""}). Remove them with: git -C ${repo} branch -D <name>`,
    );
  lines.push(
    "The Claude Code plugin, if you added it: /plugin uninstall marina@marina in Claude Code.",
    "The desktop app, if you installed it: delete Marina from Applications (macOS), remove the AppImage (Linux), or uninstall it in Settings → Apps (Windows).",
  );
  return lines;
}

function stopServer(server: Server): boolean {
  try {
    process.kill(server.pid, "SIGTERM");
  } catch {
    return true;
  }
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (!processAlive(server.pid)) return true;
    Bun.sleepSync(200);
  }
  try {
    process.kill(server.pid, "SIGKILL");
  } catch {
    // allow-empty-catch: exited between the check and the kill
  }
  Bun.sleepSync(500);
  return !processAlive(server.pid);
}

/** Carry out a plan. Returns what could not be removed. */
export function applyUninstall(plan: UninstallPlan, opts: { keepData?: boolean } = {}): string[] {
  const failed: string[] = [];
  for (const server of plan.servers)
    if (!stopServer(server)) failed.push(`server pid ${server.pid} did not stop`);
  // Keep-data: a pre-home install's world moves into the home before its code goes.
  if (opts.keepData)
    for (const r of plan.remove)
      if (r.kind === "old" && isMarinaCode(r.path))
        try {
          migrateLegacyInstall(
            r.path,
            { ...process.env, MARINA_HOME: plan.home },
            { worldOnly: true },
          );
        } catch (error) {
          failed.push(`${r.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
  const repos = new Set(plan.worktrees.map((w) => w.repo));
  for (const r of plan.remove)
    try {
      rmSync(r.path, { recursive: true, force: true });
    } catch (error) {
      failed.push(`${r.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  for (const link of plan.links)
    try {
      rmSync(link, { force: true });
    } catch {
      failed.push(link);
    }
  // Worktree folders are gone (or kept with --keep-data, still valid): drop
  // the repositories' records of the removed ones.
  if (!opts.keepData)
    for (const repo of repos)
      if (existsSync(repo))
        spawnSync("git", hostGitArgv(["git", "worktree", "prune"], repo).slice(1), {
          cwd: repo,
          env: hostGitEnv(),
          timeout: 30_000,
        });
  for (const edit of plan.pathEdits)
    try {
      const lines = readFileSync(edit.file, "utf8").split("\n");
      const drop = new Set(edit.lines);
      const kept = lines.filter((_, i) => !drop.has(i)).join("\n");
      // A startup file that held nothing but setup's line (setup created it) goes too.
      if (kept.trim() === "") rmSync(edit.file);
      else writeFileSync(edit.file, kept);
    } catch {
      failed.push(edit.file);
    }
  // A home emptied of everything but kept data stays; an empty one goes.
  try {
    if (existsSync(plan.home) && readdirSync(plan.home).length === 0)
      rmSync(plan.home, { recursive: true });
  } catch {
    // allow-empty-catch: something is still in it; it stays
  }
  return failed;
}

async function ask(question: string): Promise<boolean> {
  process.stdout.write(question);
  for await (const line of console) return /^y(es)?$/i.test(line.trim());
  return false;
}

export async function runUninstall(argv: string[], checkout?: string): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`marina uninstall — remove Marina from this computer

  marina uninstall              show everything, ask once, remove it all
  marina uninstall --keep-data  remove Marina but keep your worlds, settings and worktrees
  marina uninstall --dry-run    only show what would be removed
  marina uninstall --yes        remove without asking

It stops Marina's running servers, removes ${basename(marinaHome())} (${marinaHome()}), the
marina command, the PATH line setup added, and folders older versions used. Your repositories
keep their branches; Bun stays.`);
    return 0;
  }
  const keepData = argv.includes("--keep-data");
  const plan = planUninstall({ keepData, checkout });
  if (!plan.remove.length && !plan.links.length && !plan.pathEdits.length) {
    console.log("Marina is not installed here: nothing to remove.");
    return 0;
  }
  console.log(renderPlan(plan).join("\n"));
  if (plan.busy.length) {
    console.log(
      `\nA Marina is still using ${plan.busy.join(", ")} (the desktop app, or a server started another way). Quit it, then run marina uninstall again.`,
    );
    return 1;
  }
  if (argv.includes("--dry-run")) return 0;
  if (!argv.includes("--yes") && !argv.includes("-y")) {
    if (!process.stdin.isTTY) {
      console.log("\nNothing removed: run with --yes to remove without a terminal to answer.");
      return 1;
    }
    if (!(await ask("\nRemove all of this? [y/N] "))) {
      console.log("Nothing removed.");
      return 0;
    }
  }
  const failed = applyUninstall(plan, { keepData });
  console.log("");
  if (failed.length) {
    console.log("Marina is removed, except:");
    for (const f of failed) console.log(`  ${f}`);
  } else console.log("Marina is removed.");
  if (keepData && plan.keep.length)
    console.log(`Your worlds and settings are kept in ${plan.home}.`);
  for (const line of afterwordFor(plan)) console.log(line);
  if (plan.pathEdits.length) console.log("Open a new terminal for the PATH change to apply.");
  return failed.length ? 1 : 0;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "migrate") {
    // setup.sh: `bun scripts/home.ts migrate <old install folder>` prints the code's new folder.
    try {
      const result = migrateLegacyInstall(resolve(rest[0] ?? join(homedir(), "marina")));
      for (const m of result.moved) console.error(`  Moved ${m}`);
      for (const n of result.notes) console.error(`  ${n}`);
      console.log(result.app);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else if (command === "uninstall") {
    process.exit(await runUninstall(rest, resolve(join(import.meta.dir, ".."))));
  } else {
    console.error(
      "usage: bun scripts/home.ts migrate <dir> | uninstall [--keep-data] [--dry-run] [--yes]",
    );
    process.exit(2);
  }
}
