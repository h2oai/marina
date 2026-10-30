// Direct invocation: boot an in-process engine (no listener, in-memory DB), log a person in,
// run world commands and read what they received — the path for a change to one command,
// a DB module or a gate. Run from the repo root:
//
//   bun --no-env-file .claude/skills/run-marina/engine-probe.ts [command ...]
//
import { createTestEngine } from "../../../test/engine-fixture";

const commands = process.argv.slice(2).length ? process.argv.slice(2) : ["look", "help memory"];
const world = createTestEngine();
try {
  const me = world.login("probe");
  for (const command of commands) {
    const before = me.connection.messages.length;
    await world.engine.processCommand(me.entityId, command);
    const received = me.connection.messages.slice(before);
    console.log(`> ${command}`);
    for (const perception of received) {
      const data = perception.data as { text?: string };
      // Server text carries ANSI colour; strip it for a readable transcript.
      console.log((data.text ?? JSON.stringify(data)).replace(/\x1b\[[0-9;]*m/g, ""));
    }
  }
} finally {
  await world.dispose();
}
