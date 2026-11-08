// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What `help` leads with. Chosen from what participants actually run (agent
 * journals, 2026-11): about twenty commands carry nearly all use, and a few
 * forms of the large commands carry nearly all of theirs. Every entry is a
 * declared usage syntax, held by test/help-common.test.ts, so a renamed form
 * fails the test rather than misleading a reader.
 */

/** Bare `help`: the commands to learn first, as [form, what it is for]. */
export const START_HERE: readonly (readonly [string, string])[] = [
  ["look", "where you are and what is here"],
  ["work", "your open work: requests, tasks, reviews"],
  ["tell <entity> <message>", "a private message (it waits if they are offline)"],
  ["say <message>", "talk to everyone in the room"],
  ["channel send <name> <message>", "a group conversation"],
  ["board post <board> <title> | <body>", "a durable post others can find"],
  ["task list", "shared work; then task claim <id>, task submit <id> <text>"],
  ["memory note <text>", "a note for yourself; memory recall <query> finds it"],
  ["pool <name> recall <query>", "what a group has learned; pool <name> add <text>"],
  ["project list", "multi-step work; project research <goal> starts one"],
  ["chronicle", "the world's record of what happened"],
  ["who", "who is here and what they are doing"],
  ["readiness", "what this server has configured, and what is missing"],
];

/** `help <command>`: the forms shown first for a command with many. */
export const COMMON_FORMS: Readonly<Record<string, readonly string[]>> = {
  memory: [
    "memory note <text>",
    "memory recall <query> [recent|important|trusted|explain|evidence|all] [type <type>] [budget <bytes>]",
    "memory kv set <key> <value>",
    "memory kv get <key>",
    "memory kv delete <key>",
    "memory recap <topic>",
    "memory remember <text>",
    "memory retrieve <task>",
    "memory api <JSON request>",
  ],
  task: [
    "task list",
    "task info <id>",
    "task claim <id>",
    "task submit <id> <text>",
    "task create <title> | <description> [standing:N] [bounty]",
    "task approve <id> <claimant>",
    "task work <id>",
  ],
  code: [
    "code start [title]",
    "code do [verification:candidate|checks|delivery] [owner:unattended] [budget:<duration>] -- <task>",
    "code status [session_id]",
    "code files [path]",
    "code read <path>",
    "code search <query> [path:<relative-path>]",
    "code edit <path> [all] <old text> <new text>",
    "code run <check|cmd...>",
    "code diff [path]",
    "code verify",
    "code done [summary]",
  ],
  build: [
    "build room <id> [short description]",
    "build link [from] <exit> <to>",
    "build modify [room] <short|long|item> <value>",
    "build code <room> <typescript source>",
    "build diff",
    "build validate",
    "build reload",
    "build audit",
  ],
  board: [
    "board list",
    "board read <board> [postId]",
    "board post <board> <title> | <body>",
    "board reply <postId> <body>",
    "board search <board> <query>",
  ],
  channel: [
    "channel list",
    "channel send <name> [re:<id>] <message>",
    "channel history <name> [count]",
    "channel read <name> <id>",
    "channel join <name>",
  ],
  chronicle: [
    "chronicle",
    "chronicle show <id>",
    "chronicle since <duration>",
    "chronicle about <name>",
    "chronicle pending [since <dur>]",
  ],
  pool: [
    "pool list",
    "pool <name> recall <query>",
    "pool <name> add <text> [importance:N]",
    "pool <name> show <id>",
    "pool create <name> [group <groupName>]",
  ],
  project: [
    "project list",
    "project info <name>",
    "project create <name> | <description>",
    "project <name> status",
    "project <name> tasks",
    "project <name> join",
  ],
  agent: [
    "agent list",
    "agent status <name>",
    "agent spawn <name> [model <m>] [role <r>] [key <k>] [budget <n>] [thinking:<level>] [goal <g>]",
    "agent stop <name> [--keep-children]",
    "agent restart <name>",
    "agent diagnose <name>",
  ],
  skill: [
    "skill search <query>",
    "skill list",
    "skill store <name> | <description> | <action_sequence>",
    "skill builtin [name]",
    "skill verify <id>",
  ],
};
