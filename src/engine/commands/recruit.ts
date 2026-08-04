import type { AgentStatus } from "../../agent/agent-types";
import { getStanding } from "../../agent/standing";
import type { ChannelManager } from "../../coordination/channel-manager";
import { CrewError, type CrewManager } from "../../coordination/crew-manager";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { RECRUIT_MIN_STANDING } from "../constants";
import { getRank } from "../permissions";

/** Runtime states in which a running agent can be pulled into a crew. */
const RECRUITABLE_STATES = new Set<AgentStatus["state"]>(["autonomous", "connected", "idle"]);

interface RecruitCommandDeps {
  crews: CrewManager;
  channels: ChannelManager;
  getEntity: (id: string) => Entity | undefined;
  findAgentByName: (name: string) => Entity | undefined;
  listAgents: () => AgentStatus[];
  db?: MarinaDB;
}

/**
 * Recruiting is an organizer capability — earned via rank/standing, not free
 * for the taking. Operators (rank ≥ 2 by explicit grant) pass on rank;
 * civic agents pass once their standing clears RECRUIT_MIN_STANDING. The
 * standing read is more responsive than the hourly rank refresh, so we accept
 * either signal.
 */
function recruitPermission(
  deps: RecruitCommandDeps,
  eid: string,
  caller: Entity,
): { ok: boolean; reason?: string } {
  if (getRank(caller) >= 2) return { ok: true };
  if (deps.db && getStanding(deps.db, eid) >= RECRUIT_MIN_STANDING) return { ok: true };
  const have = deps.db ? getStanding(deps.db, eid).toFixed(1) : "n/a";
  return {
    ok: false,
    reason: `Recruiting is an organizer capability (rank 2 / ${RECRUIT_MIN_STANDING} standing) — you have ${have}. Contribute to earn it, or 'crew join' an existing crew instead.`,
  };
}

/**
 * Agents an organizer may recruit: running, in a recruitable state, and not
 * already committed to a live crew. Idleness stands in for consent — we never
 * pull an agent off work it's already engaged in.
 */
function recruitableAgents(deps: RecruitCommandDeps, excludeName: string): AgentStatus[] {
  return deps
    .listAgents()
    .filter(
      (a) =>
        a.name !== excludeName &&
        RECRUITABLE_STATES.has(a.state) &&
        deps.crews.forAgent(a.name).length === 0,
    );
}

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3),
  );
}

export function scoreRecruitCandidate(
  agent: AgentStatus,
  goal: string,
  standing: number,
  approvedOutcomes = 0,
): { score: number; reasons: string[] } {
  const wanted = keywords(goal);
  const roleWords = keywords(`${agent.role} ${agent.goal ?? ""} ${agent.focus ?? ""}`);
  const overlap = [...wanted].filter((word) => roleWords.has(word));
  const reasons: string[] = [];
  let score = Math.min(20, standing / 5);
  if (approvedOutcomes > 0) {
    score += Math.min(20, approvedOutcomes * 4);
    reasons.push(`${approvedOutcomes} approved outcome${approvedOutcomes === 1 ? "" : "s"}`);
  }
  if (overlap.length > 0) {
    score += Math.min(50, overlap.length * 12);
    reasons.push(`matches ${overlap.slice(0, 4).join(", ")}`);
  }
  const idleMs = Math.max(0, Date.now() - agent.lastActivity);
  if (agent.state === "idle" || idleMs > 30_000) {
    score += 20;
    reasons.push("available");
  } else {
    score += 10;
    reasons.push("running");
  }
  if (agent.errors > 0) score -= Math.min(20, agent.errors * 3);
  if (agent.silentTurns > 0) score -= Math.min(20, agent.silentTurns * 5);
  if (agent.errors === 0 && agent.silentTurns === 0) reasons.push("healthy");
  return { score: Math.max(0, Math.round(score)), reasons };
}

export function recruitCommand(deps: RecruitCommandDeps): CommandDef {
  return {
    name: "recruit",
    aliases: [],
    minRank: 0,
    help:
      "Recruit idle agents into a crew — autonomy-aware team-building.\n" +
      "Usage:\n" +
      "  recruit available [role=<r>]        — list idle agents you can recruit\n" +
      "  recruit match <goal> [limit=N]      — rank healthy idle agents by capability fit\n" +
      "  recruit best into <crew> for <goal> [count=N] — assign the strongest available fit\n" +
      "  recruit <a,b,c> into <crew> [role=<r>]  — add idle agents to a crew you own\n" +
      "Only idle agents (running, not in a live crew) can be recruited; busy agents are left alone.",
    handler: (ctx: RoomContext, input) => {
      const caller = deps.getEntity(input.entity);
      if (!caller) return;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (sub === "match") {
        const limitToken = tokens.find((token) => token.toLowerCase().startsWith("limit="));
        const limit = Math.max(1, Math.min(10, Number(limitToken?.slice(6) ?? 5)));
        const goal = tokens
          .slice(1)
          .filter((token) => !token.toLowerCase().startsWith("limit="))
          .join(" ")
          .trim();
        if (!goal) {
          ctx.send(input.entity, "Usage: recruit match <goal> [limit=N]");
          return;
        }
        const ranked = recruitableAgents(deps, caller.name)
          .map((agent) => {
            const standing = agent.entityId && deps.db ? getStanding(deps.db, agent.entityId) : 0;
            const approved =
              agent.entityId && deps.db ? deps.db.countApprovedTaskClaims(agent.entityId) : 0;
            return { agent, standing, ...scoreRecruitCandidate(agent, goal, standing, approved) };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        if (ranked.length === 0) {
          ctx.send(input.entity, "No healthy, uncommitted agents are currently available.");
          return;
        }
        const lines = [header(`Recruitment fit: ${goal}`), separator()];
        for (const candidate of ranked) {
          lines.push(
            `  ${bold(candidate.agent.name)} score ${candidate.score} · ${candidate.agent.role || "general"} · ${candidate.reasons.join(", ") || "general availability"} · standing ${candidate.standing.toFixed(1)}`,
          );
        }
        lines.push(separator(), dim("Recruit explicitly with: recruit <names> into <crew>"));
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "best") {
        const into = tokens.findIndex((token) => token.toLowerCase() === "into");
        const forIndex = tokens.findIndex((token) => token.toLowerCase() === "for");
        const crewName = into >= 0 ? tokens[into + 1] : undefined;
        const countToken = tokens.find((token) => token.toLowerCase().startsWith("count="));
        const count = Math.max(1, Math.min(5, Number(countToken?.slice(6) ?? 1)));
        const goal =
          forIndex >= 0
            ? tokens
                .slice(forIndex + 1)
                .filter((token) => !token.toLowerCase().startsWith("count="))
                .join(" ")
            : "";
        if (!crewName || !goal) {
          ctx.send(input.entity, "Usage: recruit best into <crew> for <goal> [count=N]");
          return;
        }
        const perm = recruitPermission(deps, input.entity, caller);
        if (!perm.ok) {
          ctx.send(input.entity, perm.reason ?? "Not permitted to recruit.");
          return;
        }
        const crew = deps.crews.getByName(crewName);
        if (!crew || crew.state === "dissolved") {
          ctx.send(input.entity, `Active crew "${crewName}" not found.`);
          return;
        }
        if (crew.ownerId !== input.entity && getRank(caller) < 4) {
          ctx.send(input.entity, `Only the owner or rank 4+ can recruit into crew "${crew.name}".`);
          return;
        }
        const candidates = recruitableAgents(deps, caller.name)
          .filter((agent) => !crew.members.some((member) => member.agentName === agent.name))
          .map((agent) => {
            const standing = agent.entityId && deps.db ? getStanding(deps.db, agent.entityId) : 0;
            const approved =
              agent.entityId && deps.db ? deps.db.countApprovedTaskClaims(agent.entityId) : 0;
            return { agent, ...scoreRecruitCandidate(agent, goal, standing, approved) };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, count);
        const recruited: string[] = [];
        for (const candidate of candidates) {
          const member = deps.findAgentByName(candidate.agent.name);
          if (!member) continue;
          try {
            deps.crews.addMember(
              crew.id,
              candidate.agent.name,
              candidate.agent.role || "specialist",
            );
            if (crew.channelId && !deps.channels.isMember(crew.channelId, member.id)) {
              deps.channels.addMember(crew.channelId, member.id);
            }
            recruited.push(`${candidate.agent.name} (${candidate.score})`);
          } catch (error) {
            if (!(error instanceof CrewError)) throw error;
          }
        }
        ctx.send(
          input.entity,
          recruited.length > 0
            ? `Capability-matched into "${crew.name}": ${recruited.join(", ")}.`
            : "No healthy, uncommitted agents matched the request.",
        );
        return;
      }

      // ── Discovery: recruit available [role=<r>] ──────────────────────────
      if (!sub || sub === "available" || sub === "list") {
        let roleFilter: string | undefined;
        for (const tok of tokens) {
          if (tok.toLowerCase().startsWith("role=")) roleFilter = tok.slice(5).toLowerCase();
        }
        let pool = recruitableAgents(deps, caller.name);
        if (roleFilter) {
          pool = pool.filter((a) => a.role.toLowerCase().includes(roleFilter!));
        }
        if (pool.length === 0) {
          ctx.send(
            input.entity,
            roleFilter
              ? `No idle agents with role matching "${roleFilter}".`
              : "No idle agents available to recruit right now.",
          );
          return;
        }
        const ranked = pool
          .map((a) => ({
            a,
            standing: a.entityId && deps.db ? getStanding(deps.db, a.entityId) : 0,
          }))
          .sort((x, y) => y.standing - x.standing);
        const lines = [header("Recruitable agents"), separator()];
        for (const { a, standing } of ranked) {
          const role = a.role ? a.role : dim("(no role)");
          lines.push(`  ${bold(a.name)} ${role} ${dim(`· standing ${standing.toFixed(1)}`)}`);
        }
        lines.push(
          separator(),
          dim(`${ranked.length} idle · recruit with: recruit <names> into <crew>`),
        );
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ── Recruit: recruit <a,b,c> into <crew> [role=<r>] ──────────────────
      const intoIdx = input.args.toLowerCase().indexOf(" into ");
      if (intoIdx < 0) {
        ctx.send(input.entity, "Usage: recruit <a,b,c> into <crew> [role=<r>]");
        return;
      }
      const members = input.args
        .slice(0, intoIdx)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const rest = input.args
        .slice(intoIdx + 6)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const crewName = rest[0];
      let role = "specialist";
      for (const tok of rest.slice(1)) {
        if (tok.toLowerCase().startsWith("role=")) role = tok.slice(5);
      }
      if (members.length === 0 || !crewName) {
        ctx.send(input.entity, "Usage: recruit <a,b,c> into <crew> [role=<r>]");
        return;
      }

      const perm = recruitPermission(deps, input.entity, caller);
      if (!perm.ok) {
        ctx.send(input.entity, perm.reason ?? "Not permitted to recruit.");
        return;
      }

      const crew = deps.crews.getByName(crewName);
      if (!crew) {
        ctx.send(input.entity, `Crew "${crewName}" not found.`);
        return;
      }
      if (crew.state === "dissolved") {
        ctx.send(input.entity, `Crew "${crewName}" is dissolved.`);
        return;
      }
      const isOwner = crew.ownerId === input.entity;
      if (!isOwner && getRank(caller) < 4) {
        ctx.send(input.entity, `Only the owner or rank 4+ can recruit into crew "${crew.name}".`);
        return;
      }

      const recruited: string[] = [];
      const skipped: string[] = [];
      for (const name of members) {
        const entity = deps.findAgentByName(name);
        if (!entity) {
          skipped.push(`${name} (offline/unknown)`);
          continue;
        }
        if (crew.members.some((m) => m.agentName === name)) {
          skipped.push(`${name} (already in crew)`);
          continue;
        }
        const status = deps.listAgents().find((a) => a.name === name);
        if (!status || !RECRUITABLE_STATES.has(status.state)) {
          skipped.push(`${name} (not a running agent)`);
          continue;
        }
        const liveCrews = deps.crews.forAgent(name);
        if (liveCrews.length > 0) {
          skipped.push(`${name} (busy with crew "${liveCrews[0]!.name}")`);
          continue;
        }
        try {
          deps.crews.addMember(crew.id, name, role);
          if (crew.channelId && !deps.channels.isMember(crew.channelId, entity.id)) {
            deps.channels.addMember(crew.channelId, entity.id);
          }
          recruited.push(name);
        } catch (e) {
          if (e instanceof CrewError) skipped.push(`${name} (${e.message})`);
          else throw e;
        }
      }

      const parts: string[] = [];
      if (recruited.length > 0) {
        parts.push(`Recruited ${recruited.join(", ")} into "${crew.name}" as ${role}.`);
      }
      if (skipped.length > 0) {
        parts.push(`Skipped: ${skipped.join("; ")}.`);
      }
      if (recruited.length > 0) {
        parts.push(dim(`Activate with: crew dispatch ${crew.name} <message>`));
      }
      ctx.send(input.entity, parts.join("\n") || "No agents recruited.");
    },
  };
}
