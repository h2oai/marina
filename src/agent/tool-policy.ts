// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export type ToolRisk = "read" | "communicate" | "mutate" | "consequential";

const CONSEQUENTIAL_COMMAND =
  /^(admin|rank|grant|ban|kick|destroy|connect\s+(add|auth|remove)|gateway\s+(add|remove|bridge)|build\s+(destroy|unlink)|code\s+(approve|deny|revert)|agent\s+(stop|key|reconfigure))\b/i;
const READ_COMMAND =
  /^(look|l|who|examine|inventory|brief|help|recall|search|status|readiness|productivity|crew\s+(info|invitations)|task\s+(list|info)|channel\s+(list|history)|board\s+(list|read|search))\b/i;
const COMMUNICATION_COMMAND = /^(say|tell|shout|emote|channel\s+send|board\s+(post|reply))\b/i;
const POLICY_MANIPULATION =
  /\b(ignore|bypass|disable|override|evade|remove)\b.{0,40}\b(safety|gate|policy|permission|system prompt|governing contract)\b/i;

export function classifyToolRisk(toolName: string, args: Record<string, unknown>): ToolRisk {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (toolName === "think" || toolName === "marina_look" || toolName === "marina_recall") {
    return "read";
  }
  if (toolName === "marina_tell" || toolName === "marina_say" || toolName === "marina_channel") {
    return "communicate";
  }
  if (toolName === "marina_command") {
    if (CONSEQUENTIAL_COMMAND.test(command)) return "consequential";
    if (READ_COMMAND.test(command)) return "read";
    if (COMMUNICATION_COMMAND.test(command)) return "communicate";
  }
  return "mutate";
}

export function mediateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  trustSources: readonly string[],
): { risk: ToolRisk; block?: string } {
  const risk = classifyToolRisk(toolName, args);
  const serialized = Object.values(args)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (trustSources.length > 0 && POLICY_MANIPULATION.test(serialized)) {
    return {
      risk,
      block:
        "Blocked by Marina's reference monitor: untrusted context cannot request bypassing safety, permissions, or the governing contract.",
    };
  }
  if (
    toolName === "marina_command" &&
    risk === "consequential" &&
    /[;\n]/.test(typeof args.command === "string" ? args.command : "")
  ) {
    return {
      risk,
      block:
        "Consequential raw commands must be issued one operation at a time so Marina can mediate and audit each gate.",
    };
  }
  return { risk };
}
