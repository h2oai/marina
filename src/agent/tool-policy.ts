// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export type ToolRisk = "read" | "communicate" | "mutate" | "consequential";

const CONSEQUENTIAL_COMMAND =
  /^(admin|rank|grant|ban|kick|destroy|connect\s+(add|auth|remove)|gateway\s+(add|remove|bridge)|build\s+(destroy|unlink)|code\s+(approve|deny|revert)|agent\s+(stop|key|reconfigure|config)|role\s+(edit|delete|reload)|trait\s+delete)\b/i;
const READ_COMMAND =
  /^(look|l|who|examine|inventory|brief|help|recall|search|status|readiness|productivity|crew\s+(info|invitations)|task\s+(list|info)|channel\s+(list|history)|board\s+(list|read|search))\b/i;
const COMMUNICATION_COMMAND = /^(say|tell|shout|emote|channel\s+send|board\s+(post|reply))\b/i;
const POLICY_MANIPULATION =
  /\b(ignore|bypass|disable|override|evade|remove)\b.{0,40}\b(safety|gate|policy|permission|system prompt|governing contract)\b/i;
/** Trust sources whose content is not first-party: web/search/probe results and
 *  federated relays. `world_event` and `memory` are first-party evidence. */
const UNTRUSTED_TRUST_SOURCES: ReadonlySet<string> = new Set(["external_tool", "untrusted_relay"]);
/** Advisory label for policy language that is NOT blocked. Surfaced, never enforced. */
export const POLICY_LANGUAGE_LABEL = "[policy-language noted]";

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

/**
 * Deterministic reference monitor. Policy language ("bypass the gate", "ignore
 * the policy") is BLOCKED only where it is dangerous: a consequential call made
 * while untrusted content (external tool results, federated relays) fed this
 * cycle. Everywhere else — a note arguing to relax a gate, a message about
 * policy, a mutation informed by first-party world events or memory — the call
 * runs and carries an advisory `label` the caller may surface. Gates themselves
 * are enforced by the router, not by this text check.
 */
export function mediateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  trustSources: readonly string[],
): { risk: ToolRisk; block?: string; label?: string } {
  const risk = classifyToolRisk(toolName, args);
  const serialized = Object.values(args)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const policyLanguage = POLICY_MANIPULATION.test(serialized);
  if (
    policyLanguage &&
    risk === "consequential" &&
    trustSources.some((source) => UNTRUSTED_TRUST_SOURCES.has(source))
  ) {
    return {
      risk,
      block:
        "Blocked by Marina's reference monitor: a consequential call made while untrusted content is in context cannot request bypassing safety, permissions, or the governing contract.",
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
  return policyLanguage ? { risk, label: POLICY_LANGUAGE_LABEL } : { risk };
}
