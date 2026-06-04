import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Agent Modes",
  long: "Agent configuration and operational modes. 5 modes available as macros: agent (plan→execute→verify), pair (context+modal switching), cascade (planner+executor), repl (natural language→code), inline (slash context). Use 'macro agent' to switch. Use 'pool guide recall mode' for details on each mode.",
  exits: {
    north: "debug/room" as RoomId,
    east: "coord/tasks" as RoomId,
    south: "system/config" as RoomId,
    se: "projects/room" as RoomId,
  },
  items: {
    modes:
      "Available modes: agent, pair, cascade, repl, inline. Use 'macro <mode>' to activate. Use 'pool guide recall <mode> mode' for full details on aliases and workflow.",
    config:
      "Agent pace and behavior configuration. Use 'memory set pace fast|normal|slow'.",
    macros:
      "Tool-name macros: claude/codex/copilot→agent, aider/cursor/cline→pair, windsurf/goose→cascade, interpreter/gemini→repl, zed/void→inline.",
  },
};

export default room;
