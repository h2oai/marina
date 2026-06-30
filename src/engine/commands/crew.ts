import type { ChannelManager } from "../../coordination/channel-manager";
import { CrewError, type CrewManager } from "../../coordination/crew-manager";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type {
  CommandDef,
  Crew,
  CrewFormation,
  CrewLifetime,
  Entity,
  RoomContext,
} from "../../types";

const VALID_FORMATIONS: ReadonlySet<CrewFormation> = new Set<CrewFormation>([
  "nsed",
  "chorus",
  "foundry",
  "swarm",
  "pipeline",
  "debate",
  "mapreduce",
  "blackboard",
  "symbiosis",
  "research",
  "freeform",
]);

interface CrewCommandDeps {
  crews: CrewManager;
  channels: ChannelManager;
  getEntity: (id: string) => Entity | undefined;
  findAgentByName: (name: string) => Entity | undefined;
  /** Optional db — enables historical-crew lookups via pool name. */
  db?: MarinaDB;
}

/**
 * Parse `crew create <name> alice,bob[,carol] [formation=<f>] [persist] -- <goal>`.
 * Members come as the second positional token. Flags use `key=value` form.
 * Goal is everything after `--`.
 */
function parseCreateArgs(args: string): {
  name?: string;
  members: string[];
  formation?: CrewFormation;
  lifetime?: CrewLifetime;
  goal: string;
  error?: string;
} {
  const dashIdx = args.indexOf("--");
  const head = dashIdx >= 0 ? args.slice(0, dashIdx).trim() : args.trim();
  const goal = dashIdx >= 0 ? args.slice(dashIdx + 2).trim() : "";

  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return {
      members: [],
      goal,
      error: "Usage: crew create <name> <a,b,c> [formation=<f>] [persist] -- <goal>",
    };
  }

  const name = tokens[0];
  const members = tokens[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let formation: CrewFormation | undefined;
  let lifetime: CrewLifetime | undefined;

  for (const tok of tokens.slice(2)) {
    if (tok === "persist") {
      lifetime = "persisted";
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq < 0) continue;
    const key = tok.slice(0, eq).toLowerCase();
    const value = tok.slice(eq + 1).toLowerCase();
    if (key === "formation") {
      if (!VALID_FORMATIONS.has(value as CrewFormation)) {
        return {
          name,
          members,
          goal,
          error: `Unknown formation "${value}". Valid: ${[...VALID_FORMATIONS].join(", ")}`,
        };
      }
      formation = value as CrewFormation;
    }
  }

  return { name, members, formation, lifetime, goal };
}

function fmtCrewLine(crew: Crew): string {
  const memberList = crew.members.map((m) => m.agentName).join(", ") || dim("(empty)");
  const lifetime = crew.lifetime === "persisted" ? "persisted" : "ephemeral";
  return `  ${bold(crew.name)} ${dim(`[${crew.formation}/${lifetime}/${crew.state}]`)}\n    members: ${memberList}\n    goal: ${crew.goal || dim("(none)")}`;
}

export function crewCommand(deps: CrewCommandDeps): CommandDef {
  return {
    name: "crew",
    aliases: [],
    minRank: 0,
    help:
      "Crews — runtime containers for multi-agent coordination.\n" +
      "Usage:\n" +
      "  crew create <name> <a,b,c> [formation=<f>] [persist] -- <goal>\n" +
      "  crew dispatch <name> <message>\n" +
      "  crew info <name>\n" +
      "  crew join <name> [role=<r>]\n" +
      "  crew leave <name>\n" +
      "  crew formation <name> <formation>\n" +
      "  crew persist <name>\n" +
      "  crew stage <name> <stage>\n" +
      "  crew artifact <name> <kind> -- <ref>\n" +
      "  crew stall <name> <agent> [reason]\n" +
      "  crew complete <name> -- <summary>\n" +
      "  crew dissolve <name> [reason]\n" +
      "Formations: nsed, chorus, foundry, swarm, pipeline, debate, mapreduce, blackboard, symbiosis, research, freeform\n" +
      "Artifact kinds: map, reduce, synthesis, draft",
    handler: (ctx: RoomContext, input) => {
      const caller = deps.getEntity(input.entity);
      if (!caller) return;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "info") {
        const target = tokens[sub === "info" ? 1 : 0];
        if (!target) {
          ctx.send(input.entity, "Usage: crew info <name>  |  crew create <name> ...");
          return;
        }
        const crew = deps.crews.getByName(target);
        if (crew) {
          const lines = [
            header(`Crew: ${crew.name}`),
            separator(),
            fmtCrewLine(crew),
            dim(`  channel: ${crew.channelId ?? "(unallocated)"}  owner: ${crew.ownerId}`),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }
        // No live crew — look for a historical pool from a dissolved crew
        // of the same name. The pool persists past dissolution, so even if
        // the crew row is gone, its accumulated wisdom is still queryable.
        if (deps.db) {
          const pool = deps.db.getMemoryPool(`crew:${target}`);
          if (pool) {
            const recent = deps.db.getPoolNotes(pool.id, 8);
            const lines = [
              header(`Crew: ${target} (dissolved)`),
              separator(),
              dim(
                `  pool: ${pool.name} — ${recent.length} note${recent.length === 1 ? "" : "s"} from this crew's run`,
              ),
            ];
            for (const n of recent.slice(0, 5)) {
              lines.push(`  • ${n.content}`);
            }
            ctx.send(input.entity, lines.join("\n"));
            return;
          }

          // Ephemeral crews don't provision a `crew:<name>` pool, but
          // `crew complete` writes a tagged note into the formation's
          // tradition pool ([crew:<name> formation:<f>] <summary>). Fall
          // back to a full-note search for that prefix so dissolved
          // ephemeral crews still have a recallable trace.
          const tagPrefix = `[crew:${target}`;
          const tagged = deps.db
            .searchAllNotes(`crew:${target}`, 10)
            .filter((n) => n.content.includes(tagPrefix));
          if (tagged.length > 0) {
            const lines = [
              header(`Crew: ${target} (dissolved, ephemeral)`),
              separator(),
              dim(
                `  ${tagged.length} note${tagged.length === 1 ? "" : "s"} reference this crew — recorded by completion summaries and tradition-pool deposits.`,
              ),
            ];
            for (const n of tagged.slice(0, 5)) {
              lines.push(`  • ${n.content}`);
            }
            ctx.send(input.entity, lines.join("\n"));
            return;
          }
        }
        ctx.send(input.entity, `Crew "${target}" not found.`);
        return;
      }

      // crew create <name> <members> [flags] -- <goal>
      if (sub === "create") {
        const args = input.args.replace(/^create\s+/i, "");
        const parsed = parseCreateArgs(args);
        if (parsed.error) {
          ctx.send(input.entity, parsed.error);
          return;
        }
        if (!parsed.name) {
          ctx.send(input.entity, "Crew name is required.");
          return;
        }

        // Validate every member resolves to an online agent.
        const missing: string[] = [];
        for (const name of parsed.members) {
          if (!deps.findAgentByName(name)) missing.push(name);
        }
        if (missing.length > 0) {
          ctx.send(input.entity, `Unknown agents: ${missing.join(", ")}`);
          return;
        }

        try {
          const crew = deps.crews.create({
            name: parsed.name,
            goal: parsed.goal,
            formation: parsed.formation,
            lifetime: parsed.lifetime,
            owner: input.entity,
            members: parsed.members.map((agentName) => ({ agentName })),
          });
          ctx.send(
            input.entity,
            `Crew "${crew.name}" created (${crew.formation}/${crew.lifetime}, ${crew.members.length} members). Use 'crew dispatch ${crew.name} <message>' to activate.`,
          );
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew dispatch <name> <message> — owner, member, or rank 4+
      if (sub === "dispatch") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: crew dispatch <name> <message>");
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        const callerRank = (caller.properties.rank as number | undefined) ?? 0;
        const isOwner = crew.ownerId === input.entity;
        const isMember = crew.members.some((m) => m.agentName === caller.name);
        if (!isOwner && !isMember && callerRank < 4) {
          ctx.send(
            input.entity,
            `Only the owner, a member, or rank 4+ can dispatch crew "${crew.name}".`,
          );
          return;
        }
        const message = input.args.replace(/^dispatch\s+\S+\s*/i, "").trim();
        if (!message) {
          ctx.send(input.entity, "Usage: crew dispatch <name> <message>");
          return;
        }

        const joinMembers = () => {
          if (!crew.channelId) return;
          for (const member of crew.members) {
            const memberEntity = deps.findAgentByName(member.agentName);
            if (!memberEntity) continue;
            if (!deps.channels.isMember(crew.channelId, memberEntity.id)) {
              deps.channels.addMember(crew.channelId, memberEntity.id);
            }
          }
          // Owner gets read access too — they dispatched, they want to see replies.
          if (!deps.channels.isMember(crew.channelId, input.entity)) {
            deps.channels.addMember(crew.channelId, input.entity);
          }
        };

        try {
          deps.crews.dispatch(
            crew.id,
            message,
            { id: input.entity, name: caller.name },
            {
              beforeFirstPost: joinMembers,
            },
          );
          joinMembers();
          ctx.send(input.entity, `Dispatched to crew "${crew.name}".`);
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew join <name> [role=<r>] — self-add
      if (sub === "join") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: crew join <name> [role=<r>]");
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        let role = "specialist";
        for (const tok of tokens.slice(2)) {
          if (tok.startsWith("role=")) role = tok.slice(5);
        }
        try {
          deps.crews.addMember(crew.id, caller.name, role);
          if (crew.channelId && !deps.channels.isMember(crew.channelId, input.entity)) {
            deps.channels.addMember(crew.channelId, input.entity);
          }
          ctx.send(input.entity, `Joined crew "${crew.name}" as ${role}.`);
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew leave <name> — self-remove
      if (sub === "leave") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: crew leave <name>");
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        try {
          deps.crews.removeMember(crew.id, caller.name, "left");
          ctx.send(input.entity, `Left crew "${crew.name}".`);
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew formation <name> <formation> — owner or rank 3+
      if (sub === "formation") {
        const name = tokens[1];
        const formation = tokens[2]?.toLowerCase() as CrewFormation | undefined;
        if (!name || !formation) {
          ctx.send(input.entity, "Usage: crew formation <name> <formation>");
          return;
        }
        if (!VALID_FORMATIONS.has(formation)) {
          ctx.send(
            input.entity,
            `Unknown formation "${formation}". Valid: ${[...VALID_FORMATIONS].join(", ")}`,
          );
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        const callerRank = (caller.properties.rank as number | undefined) ?? 0;
        const isOwner = crew.ownerId === input.entity;
        if (!isOwner && callerRank < 3) {
          ctx.send(input.entity, "Only the owner or rank 3+ can change crew formation.");
          return;
        }
        try {
          deps.crews.setFormation(crew.id, formation);
          ctx.send(input.entity, `Crew "${crew.name}" formation → ${formation}.`);
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew persist <name> — owner or rank 4+
      if (sub === "persist") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: crew persist <name>");
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        const callerRank = (caller.properties.rank as number | undefined) ?? 0;
        const isOwner = crew.ownerId === input.entity;
        if (!isOwner && callerRank < 4) {
          ctx.send(input.entity, "Only the owner or rank 4+ can persist a crew.");
          return;
        }
        try {
          deps.crews.persist(crew.id);
          ctx.send(
            input.entity,
            `Crew "${crew.name}" upgraded to persisted (pool: crew:${crew.name}).`,
          );
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew stage <name> <stage> — member only. Marks a formation stage done.
      if (sub === "stage") {
        const name = tokens[1];
        const stage = tokens.slice(2).join(" ").trim();
        if (!name || !stage) {
          ctx.send(input.entity, "Usage: crew stage <name> <stage>");
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        const isMember = crew.members.some((m) => m.agentName === caller.name);
        if (!isMember) {
          ctx.send(input.entity, `Only members of "${crew.name}" can mark a stage.`);
          return;
        }
        try {
          deps.crews.recordStageCompleted(crew.id, stage, caller.name);
          ctx.send(input.entity, `Stage "${stage}" completed for crew "${crew.name}".`);
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew artifact <name> <kind> -- <ref> — member only. Records a deposit.
      if (sub === "artifact") {
        const name = tokens[1];
        const kind = tokens[2]?.toLowerCase() as
          | "map"
          | "reduce"
          | "synthesis"
          | "draft"
          | undefined;
        const dashIdx = input.args.indexOf("--");
        const ref = dashIdx >= 0 ? input.args.slice(dashIdx + 2).trim() : "";
        if (!name || !kind || !ref) {
          ctx.send(
            input.entity,
            "Usage: crew artifact <name> <map|reduce|synthesis|draft> -- <ref>",
          );
          return;
        }
        if (!["map", "reduce", "synthesis", "draft"].includes(kind)) {
          ctx.send(
            input.entity,
            `Unknown artifact kind "${kind}". Use map|reduce|synthesis|draft.`,
          );
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        const isMember = crew.members.some((m) => m.agentName === caller.name);
        if (!isMember) {
          ctx.send(input.entity, `Only members of "${crew.name}" can deposit artifacts.`);
          return;
        }
        try {
          deps.crews.recordArtifactDeposit(crew.id, caller.name, ref, kind);
          ctx.send(input.entity, `Deposited ${kind} artifact "${ref}" to crew "${crew.name}".`);
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew stall <name> <agent> [reason] — owner or member flags a stalled peer.
      if (sub === "stall") {
        const name = tokens[1];
        const agentName = tokens[2];
        const reason = tokens.slice(3).join(" ") || "no progress";
        if (!name || !agentName) {
          ctx.send(input.entity, "Usage: crew stall <name> <agent> [reason]");
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        const isOwner = crew.ownerId === input.entity;
        const isMember = crew.members.some((m) => m.agentName === caller.name);
        if (!isOwner && !isMember) {
          ctx.send(input.entity, `Only the owner or a member of "${crew.name}" can flag a stall.`);
          return;
        }
        if (agentName === caller.name) {
          ctx.send(input.entity, "Cannot flag yourself as stalled.");
          return;
        }
        try {
          const count = deps.crews.recordMemberStall(crew.id, agentName, reason);
          const penaltyNote = count >= 3 ? " — standing penalty applied" : "";
          ctx.send(
            input.entity,
            `Flagged ${agentName} as stalled in "${crew.name}" (offense ${count})${penaltyNote}.`,
          );
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew complete <name> -- <summary> — owner or member
      if (sub === "complete") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: crew complete <name> -- <summary>");
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        const isOwner = crew.ownerId === input.entity;
        const isMember = crew.members.some((m) => m.agentName === caller.name);
        if (!isOwner && !isMember) {
          ctx.send(input.entity, `Only the owner or a member can complete crew "${crew.name}".`);
          return;
        }
        const dashIdx = input.args.indexOf("--");
        const summary = dashIdx >= 0 ? input.args.slice(dashIdx + 2).trim() : "";
        if (!summary) {
          ctx.send(input.entity, "Usage: crew complete <name> -- <summary>");
          return;
        }
        try {
          const result = deps.crews.complete(crew.id, summary, caller.name);
          const noteHint = result.resultNoteId ? ` (note ${result.resultNoteId})` : "";
          ctx.send(input.entity, `Crew "${crew.name}" completed${noteHint}.`);
        } catch (e) {
          if (e instanceof CrewError) ctx.send(input.entity, e.message);
          else throw e;
        }
        return;
      }

      // crew dissolve <name> [reason] — owner or rank 5+
      if (sub === "dissolve") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: crew dissolve <name> [reason]");
          return;
        }
        const crew = deps.crews.getByName(name);
        if (!crew) {
          ctx.send(input.entity, `Crew "${name}" not found.`);
          return;
        }
        const callerRank = (caller.properties.rank as number | undefined) ?? 0;
        const isOwner = crew.ownerId === input.entity;
        if (!isOwner && callerRank < 5) {
          ctx.send(input.entity, `Only the owner or rank 5+ can dissolve crew "${crew.name}".`);
          return;
        }
        const reason =
          tokens.slice(2).join(" ") || (isOwner ? "owner dissolved" : "admin dissolved");
        deps.crews.dissolve(crew.id, reason);
        ctx.send(input.entity, `Dissolved crew "${crew.name}".`);
        return;
      }

      // Treat `crew <name>` (no subcommand) as `crew info <name>` if the first
      // token resolves to an existing crew.
      const maybeCrew = deps.crews.getByName(sub);
      if (maybeCrew) {
        ctx.send(
          input.entity,
          [header(`Crew: ${maybeCrew.name}`), separator(), fmtCrewLine(maybeCrew)].join("\n"),
        );
        return;
      }

      ctx.send(
        input.entity,
        `Unknown crew subcommand "${sub}". Try: create, dispatch, info, join, leave, formation, persist, stage, artifact, stall, complete, dissolve.`,
      );
    },
  };
}
