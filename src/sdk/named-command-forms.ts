// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandField, CommandForm } from "./command-forms";
import { namedInputSchema } from "./command-schema";

export type NamedField = Pick<
  CommandField,
  "kind" | "placeholder" | "min" | "max" | "integer" | "wireType"
> & {
  required: boolean;
  choices?: readonly string[];
};
export type NamedValue<F extends NamedField> = F["wireType"] extends "string-array"
  ? string[]
  : F["wireType"] extends "string-record"
    ? Record<string, string>
    : F["kind"] extends "number"
      ? number
      : F extends { choices: readonly (infer C)[] }
        ? C
        : string;
export type NamedArguments<F extends Record<string, NamedField>> = {
  [K in keyof F]: F[K]["required"] extends true ? NamedValue<F[K]> : NamedValue<F[K]> | undefined;
};

export function namedCommandForm<const F extends Record<string, NamedField>>(
  name: string,
  namedFields: F,
) {
  const form: CommandForm & { namedFields: F } = {
    encoding: "named",
    syntax: name,
    label: name,
    namedFields,
    parts: [],
    fields: Object.entries(namedFields).map(([id, field]) => ({
      ...field,
      id,
      label: id,
      choices: field.choices ? [...field.choices] : undefined,
      optionalGroup: field.required ? undefined : `optional-${id}`,
      multiline: field.kind === "text",
      allowNewlines: false,
    })),
    groups: Object.entries(namedFields)
      .filter(([, f]) => !f.required)
      .map(([id]) => ({ id: `optional-${id}`, label: id })),
  };
  form.inputSchema = namedInputSchema(form);
  return form;
}

/** Stable named-tool contracts. These are CommandForms, rendered by the same
 * field compiler as new capabilities/invoke forms. Aggregates such as think and
 * raw-input tools intentionally preserve their original wire payloads; adapters
 * only translate them to commands. New commands need no named compatibility form. */
export const NAMED_COMMAND_FORMS = {
  think: namedCommandForm("think", {
    action: {
      kind: "choice",
      placeholder: "Cognitive action to perform",
      required: true,
      choices: ["note", "recall", "reflect", "context"],
    },
    text: {
      kind: "text",
      placeholder:
        "For note: what you observed. For recall/context: search query. For reflect: optional topic.",
      required: true,
    },
    scope: {
      kind: "choice",
      placeholder: "For context: 'all' (default) or 'evidence' (durable tiers only)",
      required: false,
      choices: ["all", "evidence"],
    },
    budget: {
      kind: "number",
      placeholder: "For context: total content byte budget (default 4096)",
      required: false,
      integer: true,
      min: 256,
      max: 65536,
    },
    importance: {
      kind: "number",
      placeholder: "Note importance 1-10 (default 5)",
      required: false,
      min: 1,
      max: 10,
    },
    type: {
      kind: "choice",
      placeholder: "Note type (default: observation)",
      required: false,
      choices: ["observation", "fact", "decision", "inference", "skill", "episode", "principle"],
    },
    modifier: {
      kind: "choice",
      placeholder: "Recall modifier \u2014 weight recent or important notes",
      required: false,
      choices: ["recent", "important"],
    },
  }),
  memory: namedCommandForm("memory", {
    action: {
      kind: "choice",
      placeholder: "Memory operation",
      required: true,
      choices: ["set", "get", "list", "delete", "history"],
    },
    key: {
      kind: "text",
      placeholder: "Memory key (e.g. 'goal', 'ally', 'plan')",
      required: false,
    },
    value: {
      kind: "text",
      placeholder: "Value to store (required for 'set')",
      required: false,
    },
  }),
  next: namedCommandForm("next", {}),
  brief: namedCommandForm("brief", {
    mode: {
      kind: "choice",
      placeholder: "Briefing depth (default: compass)",
      required: false,
      choices: ["compass", "full"],
    },
  }),
  quest: namedCommandForm("quest", {
    action: {
      kind: "choice",
      placeholder: "Quest action (default: status)",
      required: false,
      choices: ["status", "list", "start", "complete", "abandon"],
    },
    name: {
      kind: "text",
      placeholder: "Quest name (for 'start' action)",
      required: false,
    },
  }),
  look: namedCommandForm("look", {
    target: {
      kind: "text",
      placeholder: "Optional target to look at",
      required: false,
    },
  }),
  move: namedCommandForm("move", {
    direction: {
      kind: "text",
      placeholder: "Direction to move",
      required: true,
    },
  }),
  say: namedCommandForm("say", {
    message: {
      kind: "text",
      placeholder: "Message to say",
      required: true,
    },
  }),
  tell: namedCommandForm("tell", {
    target: {
      kind: "text",
      placeholder: "Name of the entity to message",
      required: true,
    },
    message: {
      kind: "text",
      placeholder: "Private message to send",
      required: true,
    },
  }),
  who: namedCommandForm("who", {}),
  examine: namedCommandForm("examine", {
    target: {
      kind: "text",
      placeholder: "Name of the entity or item to examine",
      required: true,
    },
  }),
  channel: namedCommandForm("channel", {
    input: {
      kind: "text",
      placeholder: "Channel subcommand and arguments, e.g. 'send general Hello!'",
      required: true,
    },
  }),
  board: namedCommandForm("board", {
    input: {
      kind: "text",
      placeholder: "Board subcommand and arguments, e.g. 'post general My Title | Body text'",
      required: true,
    },
  }),
  group: namedCommandForm("group", {
    input: {
      kind: "text",
      placeholder: "Group subcommand and arguments, e.g. 'create mygroup My Group Name'",
      required: true,
    },
  }),
  task: namedCommandForm("task", {
    input: {
      kind: "text",
      placeholder:
        "Task subcommand and arguments, e.g. 'create Fix the bug | Detailed description'",
      required: true,
    },
  }),
  crew: namedCommandForm("crew", {
    input: {
      kind: "text",
      placeholder:
        "Crew subcommand and arguments, e.g. 'create alpha alice,bob formation=pipeline -- ship phase'",
      required: true,
    },
  }),
  evolve: namedCommandForm("evolve", {
    input: {
      kind: "text",
      placeholder:
        "Evolution subcommand and arguments, e.g. 'propose PromptTrial | hypothesis | note:7'",
      required: true,
    },
  }),
  market: namedCommandForm("market", {
    input: {
      kind: "text",
      placeholder:
        "Market subcommand and arguments, e.g. 'forecast market:tech' or 'list resolved'",
      required: true,
    },
  }),
  canvas: namedCommandForm("canvas", {
    input: {
      kind: "text",
      placeholder:
        "Canvas subcommand and arguments, e.g. 'publish text <asset_id> feed' or 'asset upload https://example.com/image.png' or 'layout feed feed'",
      required: true,
    },
  }),
  build: namedCommandForm("build", {
    input: {
      kind: "text",
      placeholder: "Build subcommand and arguments, e.g. 'space my/room A Custom Room'",
      required: true,
    },
  }),
  flywheel: namedCommandForm("flywheel", {
    action: {
      kind: "choice",
      placeholder: "",
      required: true,
      choices: ["create", "exec", "publish", "status", "hibernate", "resume", "stop"],
    },
    image: {
      kind: "text",
      placeholder: "Sandbox image override for create",
      required: false,
    },
    command: {
      kind: "text",
      placeholder: "Command for exec (runs `code run <command>`)",
      required: false,
    },
    args: {
      kind: "json",
      placeholder: "Arguments for exec",
      required: false,
      wireType: "string-array",
    },
    service: {
      kind: "text",
      placeholder: "Declared `code service` name to publish (for action=publish)",
      required: false,
    },
  }),
  command: namedCommandForm("command", {
    input: {
      kind: "text",
      placeholder: "Raw command string to send",
      required: true,
    },
  }),
  batch: namedCommandForm("batch", {
    input: {
      kind: "text",
      placeholder: "Commands separated by semicolons, e.g. 'look ; north ; look'",
      required: true,
    },
  }),
  probe: namedCommandForm("probe", {
    kind: {
      kind: "text",
      placeholder: "Resolver kind (e.g. 'resolving', 'echoing')",
      required: true,
    },
    args: {
      kind: "json",
      placeholder:
        "Resolver-specific args as key:value pairs (e.g. {venue:'kalshi', ticker:'KXFED-26MAR'})",
      required: false,
      wireType: "string-record",
    },
    watch: {
      kind: "number",
      placeholder: "Watch spec note id to link this sample to (for cadenced probes)",
      required: false,
    },
  }),
  watch_create: namedCommandForm("watch_create", {
    kind: {
      kind: "text",
      placeholder: "Resolver kind to invoke on cadence",
      required: true,
    },
    args: {
      kind: "json",
      placeholder: "Resolver args (passed to probe each cycle)",
      required: true,
      wireType: "string-record",
    },
    cadence: {
      kind: "text",
      placeholder: "How often to probe: 30s, 5m, 1h, 7d, or 'once' for one-shot. Default: once.",
      required: false,
    },
    retirement: {
      kind: "text",
      placeholder:
        "When to retire: 'resolved' (default), 'forever', '5' (after N samples), '7d' (after duration)",
      required: false,
    },
    notify: {
      kind: "text",
      placeholder: "Entity or channel to notify on closure (tell or post)",
      required: false,
    },
  }),
  watch_list: namedCommandForm("watch_list", {}),
  watch_due: namedCommandForm("watch_due", {
    limit: {
      kind: "number",
      placeholder: "Maximum entries to return (default 10, max 50)",
      required: false,
    },
  }),
  watch_retire: namedCommandForm("watch_retire", {
    id: {
      kind: "number",
      placeholder: "Watch spec note id (from watch_list)",
      required: true,
    },
    reason: {
      kind: "text",
      placeholder: "Why retiring \u2014 recorded in audit trail",
      required: false,
    },
  }),
  help: namedCommandForm("help", {
    command: {
      kind: "text",
      placeholder: "Specific command to get help for",
      required: false,
    },
  }),
  quit: namedCommandForm("quit", {}),
} as const;

const owners: Record<string, string> = {
  think: "note",
  flywheel: "code",
  watch_create: "watch",
  watch_list: "watch",
  watch_due: "watch",
  watch_retire: "watch",
};
export function namedFormsForCommand(command: string): CommandForm[] {
  return Object.entries(NAMED_COMMAND_FORMS)
    .filter(([name]) => (owners[name] ?? name) === command)
    .map(([, { namedFields: _fields, ...form }]) => form);
}
