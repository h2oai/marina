import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Project Room",
  long: "Project management, orchestration, and decomposition. Create projects, assign orchestration patterns, break complex goals into task trees. Use 'project create <name>', 'project <name> orchestrate <pattern>', 'project <name> decompose <pattern>', or 'usecase decompose <goal>' for one-command scaffolding.",
  exits: {
    north: "coord/tasks" as RoomId,
    east: "ops/launch" as RoomId,
    south: "system/config" as RoomId,
    west: "system/config" as RoomId,
    ne: "coord/center" as RoomId,
    nw: "agent/modes" as RoomId,
  },
  items: {
    projects: "Active project dashboard. Use 'project list' to browse, 'project create' to start.",
    orchestration:
      "Orchestration patterns describe how the team coordinates (who talks, who decides, how work merges). Run 'help project' or 'pool coordination-patterns recall' for the current pattern set.",
    decomposition:
      "Decomposition patterns describe how a goal breaks into subtasks — hierarchical DAGs, plan-exec-verify merge gates, lazy expansion, non-overlapping parallel scopes, workload tiers. Run 'help project' for the current set. Apply with 'project <name> decompose <pattern>'.",
    "decompose-desk":
      'A framed card reads: "Complex goal? Two paths. (1) Quick: `usecase decompose <your goal>` auto-scaffolds a project + planner agent + htdag pattern. (2) Manual: `project create <name> | <goal>` then `project <name> decompose <pattern>`, then break the bundle into children with `task create` + `task assign`."',
    roles:
      "Three decomposition roles available via 'role set <name>': planner (decomposes goals, never executes), executor (claims one leaf at a time, delivers results), verifier (reviews submissions against done-criteria, gates merges).",
  },
};

export default room;
