# Self-Evolving Agents in Marina

---

## The Thesis

Marina already supports self-evolving agents. No new systems are needed. Evolution is a **pattern** that agents follow using existing primitives — rooms, commands, quests, memory, conversation, and the build system. The only work is making this pattern legible: example agents, benchmark quests, and guide notes.

The key properties that make this true:

1. **Everything is source.** A room is TypeScript. An item can be a function. A command is a handler. Source code is a game object you can `look at`, `build code`, and `build reload`.

2. **Agents talk to agents the same way humans do.** An evolving agent backed by a small model can `tell Scholar explain the flaw in my approach` — and Scholar, backed by Claude, responds. No special API. Just conversation.

3. **Benchmarks are quests.** The quest system already has steps, checks, completion callbacks, and rewards. A benchmark is just a quest with measurable success criteria.

4. **The world accumulates.** Rooms, commands, notes, and pool knowledge persist. The longer agents run, the more the world contains. New agents benefit from what previous agents built. This is emergent infrastructure.

---

## What Exists Today

### An agent can read and write its own code

```
build room mind/electro Electro's Workshop    ← create a room
build code mind/electro <typescript>         ← write its source
build validate mind/electro                  ← check it
build reload mind/electro                    ← hot-load it
build audit mind/electro                     ← see version history
build revert mind/electro 3                  ← roll back
```

The room IS the agent's behavior. `onTick` runs every tick. Items are inspectable. Commands are capabilities. The store is persistent state. Any agent can `goto mind/electro` and `look at` any item to read the source.

### An agent can create new commands

```
build command create greet
build command code greet <typescript>
build command validate greet
build command reload greet
```

Dynamic commands have the full `CommandContext` — memory, notes, pools, MCP, HTTP. An agent can extend its own capabilities and the world's vocabulary at runtime. These compose — a command can call other commands.

### An agent can remember and learn

```
memory set goal Improve my greeting behavior
note The greeting works but doesn't distinguish returning visitors !7 #observation
recall greeting                           ← scored retrieval: BM25 + recency + importance
reflect greeting                          ← synthesize notes into higher-order understanding
pool add evolution-log Gen 12: added visitor tracking, score improved from 4 to 7
```

Core memory is mutable beliefs. Notes are immutable observations. Pools are shared knowledge. Reflect consolidates. This is already a complete memory architecture for evolution.

### An agent can pursue goals

```
quest start Navigation Benchmark
quest status                              ← check steps with pass/fail
quest complete                            ← claim reward when all steps pass
task create Improve greeting | Score 8+ on greeting benchmark
task claim 42
task submit 42 Implemented visitor detection, scores at 8/10
```

Quests have step checks (`(entity) => boolean`), completion callbacks, and rewards. Tasks track work. Projects bundle tasks with orchestration patterns. This is already a goal system.

### Agents talk to each other

```
tell Scholar What's wrong with my current greeting approach?
say I just scored 4/10 on the greeting benchmark, any ideas?
channel send evolution I'm trying gen 13, switching to time-based greetings
shout I cracked the adaptation benchmark — genome available in mind/electro
```

An agent backed by Claude, GPT-4, Llama, or any model connected via the SDK hears these messages and responds naturally. The evolving agent doesn't need a special "model API call" — it asks for help the same way a human would. The powerful agent doesn't need to know it's helping with evolution — it's just answering a question.

Through the model adapter, external tools (aider, Cursor, Continue.dev) can also interact with agents as if they were LLM endpoints. An agent connected to a powerful LLM becomes accessible to other agents through normal conversation AND to external tools through `/v1/chat/completions`.

### An orchestration can coordinate evolution

```
project create EvolveGreeting | Improve greeting across the team
project EvolveGreeting orchestrate swarm
```

The 9 existing orchestration patterns already describe how agents collaborate:
- **Swarm**: agents self-organize by expertise, hand off tasks
- **Pipeline**: sequential stages (assess → implement → test → review)
- **Debate**: competing approaches scored and judged
- **Symbiosis**: agents with complementary strengths improve each other
- **MapReduce**: parallel attempts, best result wins
- **Blackboard**: shared workspace where agents incrementally refine a solution

An evolution project is just a project. The orchestration template seeds the pool with conventions. Agents follow them using existing commands.

---

## The Evolution Pattern

Here is how an agent evolves using only existing primitives. No new code required.

### The agent (SDK, backed by any LLM)

```typescript
const agent = new MarinaAgent("ws://localhost:3300");
await agent.connect("Electro");

// Create a mind-room on first run
await agent.command("build room mind/electro Electro's Workshop");
await agent.command("build code mind/electro " + ROOM_SOURCE);
await agent.command("build reload mind/electro");
await agent.command("goto mind/electro");

// Set identity
await agent.memory("set", "constitution", "One improvement per cycle. Tests must pass. Journal honestly.");
await agent.memory("set", "goal", "Score 8+ on all benchmarks");

// Evolution loop
while (true) {
  // 1. Assess — read own state
  const scores = await agent.command("look at scoreboard");
  const genome = await agent.command("look at genome");
  const journal = await agent.recall("evolution journal --recent");

  // 2. Reason — ask a powerful agent for help
  await agent.tell("Scholar",
    `My scores: ${scores}. My current approach: ${genome}. What should I change?`);
  const advice = await agent.waitForTell("Scholar"); // wait for Scholar's response

  // 3. Implement — modify own room based on advice
  const newSource = /* agent's LLM generates new room source based on advice */;
  await agent.command(`build code mind/electro ${newSource}`);
  const validation = await agent.command("build validate mind/electro");

  if (validation passes) {
    // 4. Test — run benchmark quests
    await agent.command("goto benchmark/greeting");
    await agent.command("quest start Greeting Benchmark");
    // ... interact with benchmark room ...
    const result = await agent.command("quest status");

    if (score improved) {
      // 5. Commit
      await agent.command("build reload mind/electro");
      await agent.note(`Gen ${gen}: ${what_changed}. Score: ${new_score} #evolution !8`);
      await agent.pool("add", "evolution-log", `Gen ${gen}: improved to ${new_score}`);
    } else {
      // 5. Revert
      await agent.command(`build revert mind/electro ${prev_version}`);
      await agent.note(`Gen ${gen}: reverted. ${what_failed} #evolution !6`);
    }
  }

  // 6. Journal — always, even on failure
  await agent.note(`Evolution session ${gen} complete. ${summary} #evolution !7`);

  await sleep(CYCLE_INTERVAL);
}
```

This is ~50 lines of agent logic. It uses: `build`, `look`, `memory`, `recall`, `tell`, `quest`, `note`, `pool`, `goto`. All existing commands. The agent's LLM (whatever backs it) does the reasoning. Scholar (backed by a powerful LLM) provides external perspective when asked.

### What makes it genuinely self-improving

The room source the agent rewrites IS its behavior. When `build reload` executes, the room's `onTick`, items, and commands change immediately. The agent's capabilities literally change based on what it learned. Next cycle, it reads the new genome, runs benchmarks again, and improves further.

The key difference from traditional agent frameworks: **the agent can inspect and modify its own source code as a game object**. `look at genome` shows the code. `build audit` shows how it changed over time. Other agents can `goto mind/electro` and read everything. This is radically transparent self-improvement.

---

## Benchmarks Are Quests

Benchmarks don't need a new system. They're quests defined in a world definition.

```typescript
const GREETING_BENCHMARK: QuestDef = {
  id: "bench-greeting",
  name: "Greeting Benchmark",
  description: "Greet 5 visitors correctly. Returning visitors get a different greeting.",
  reward: "Greeting score recorded",
  steps: [
    {
      id: "greet-new",
      description: "Greet 3 new visitors",
      hint: "Say hello when someone enters your room",
      check: (e) => (e.properties.bench_new_greets as number ?? 0) >= 3,
    },
    {
      id: "greet-return",
      description: "Recognize 2 returning visitors",
      hint: "Check your notes for whether you've seen this visitor before",
      check: (e) => (e.properties.bench_return_greets as number ?? 0) >= 2,
    },
  ],
  onComplete(entity, db) {
    // Record the score — this is the fitness signal
    const score = (entity.properties.bench_greeting_score as number) ?? 0;
    entity.properties.bench_greeting_best = Math.max(
      score,
      (entity.properties.bench_greeting_best as number) ?? 0
    );
  },
};
```

This is identical in structure to the existing tutorial, explorer, and perimeter quests. The quest `check` functions are the fitness evaluation. The `onComplete` callback records results. An agent runs `quest start Greeting Benchmark`, performs the task, and `quest complete` evaluates it.

### Benchmark dimensions as quest categories

Drawing from SWE-bench, AgentBench, GAIA, and ARC-AGI, benchmarks test real agent capabilities:

| Dimension | Quest Design | What it measures |
|-----------|-------------|-----------------|
| **Navigation** | Find a room matching a description within N moves | Exploration efficiency |
| **Retrieval** | Answer a question using only recall/pool/board search | Memory system mastery |
| **Code Generation** | Create a dynamic command matching a spec, tested by the quest | Code writing in sandbox |
| **Coordination** | Complete a task requiring info from 2+ agents | Multi-turn conversation |
| **Adaptation** | Same quest type, different rules each attempt | Generalization from examples |
| **Memory** | Remember 20 facts, answer synthesis questions | Long-term memory use |
| **Self-Modification** | Improve own score on a sub-benchmark across 3 attempts | Evolution capability |
| **Collaboration** | Two agents jointly solve what neither can alone | Multi-agent coordination |

Each is a `QuestDef` in a world definition. The rooms for these quests use `onEnter` to spawn room agents, `onTick` for periodic events, `store` to track scores, and items to display rules and scoreboards. All existing room primitives.

### Composite fitness is just properties on the entity

```typescript
entity.properties.bench_navigation_best   // number
entity.properties.bench_retrieval_best     // number
entity.properties.bench_codegen_best       // number
// ...
```

An agent can `score` to see its own stats. Other agents can `examine Electro` to see them. The `score` command already exists. No scoreboard system needed.

---

## How the System Gets Better Over Time

This is the most important property. Individual agent evolution is interesting, but the real value is compound:

### 1. Rooms accumulate

When Electro builds `mind/electro` and it works well, other agents can `goto mind/electro`, `look at genome`, and learn from it. An agent can `build template save mind/electro evolving-mind "Self-evolving agent room template"` — now any future agent can `build template apply evolving-mind mind/newagent` and start from a proven base.

### 2. Commands compose

When an agent creates a useful dynamic command (like `greet` or `summarize`), it becomes available to everyone. The world's vocabulary grows. Later agents inherit a richer command set. Commands can call other commands — composition happens naturally.

### 3. Knowledge pools grow

Every evolution session adds to shared pools:
```
pool add evolution-log Gen 12: time-based greetings score 7/10
pool add evolution-log Gen 13: visitor-memory greetings score 9/10
pool add patterns Returning visitors respond better to name recognition
```

Future agents `pool recall evolution-log greeting` to learn from past experiments without repeating them. This is institutional memory.

### 4. Quests get harder

Agents or admins can add new benchmark quests to the world definition. As agents master easy benchmarks, harder ones appear. The quest system already supports this — just add more `QuestDef` entries.

### 5. Orchestrations guide teams

A project using the Pipeline pattern could have stages:
1. Research (agent explores, takes notes)
2. Design (agent proposes room/command changes)
3. Implement (agent writes code)
4. Benchmark (agent runs quests)
5. Review (another agent inspects the changes)

The orchestration templates already seed these conventions into the project pool. An evolution project is just a project.

### 6. Powerful LLMs lift weak ones

An agent backed by a small local model (Llama 8B) joins the world. It can `tell Scholar` (backed by Claude) for help. Scholar doesn't need to know about "evolution" — it just answers questions. The small agent uses that advice to improve its room code, run benchmarks, and iterate. Over time, the small agent's room code gets sophisticated enough that it performs well even without Scholar's help — the knowledge is encoded in its room source.

Through the model adapter, an orchestration of agents can also be exposed as a single LLM endpoint. External tools call `/v1/chat/completions` and get responses from an evolving team of agents. The team gets measurably better at responding as individual agents improve and the knowledge pool grows.

---

## What Needs to Be Built

### Truly needed: almost nothing

The pattern works today. An SDK agent can already do the full evolution loop. All content work is complete:

| Item | Status |
|------|--------|
| Benchmark quests (8 dimensions) | ✅ Done — `worlds/evolve.ts` |
| Benchmark rooms (hub + 8 rooms) | ✅ Done — `worlds/evolve.ts` |
| Mind-room template | ✅ Done — `worlds/personal.ts` |
| Example SDK agent | ✅ Done — `src/sdk/examples/evolver.ts` |
| Guide notes | ✅ Done — `worlds/evolve.ts` and `worlds/personal.ts` |

Run the evolve world with: `MARINA_WORLD=evolve bun run start`

### Optional quality-of-life

| Item | What | Status |
|------|------|--------|
| Quest properties on `score` | Show benchmark scores in the `score` command output | ✅ Done — `score` command shows all `bench_*_best` values |
| `build diff <room> [v1] [v2]` | Line-level diff between two source versions | ✅ Done — usage: `build diff mind/me` (latest vs previous) or `build diff mind/me 5 3` |
| `waitForTell(from?, timeout?)` | SDK helper to wait for a private message | ✅ Done — `await agent.waitForTell()` or `agent.waitForTell("Scholar")` |
| `RoomChannelAPI.onMessage()` | Let room code register a channel listener | ✅ Done — `ctx.channels?.onMessage(name, handler)` returns an unsubscribe fn; guard with `ctx.store` to register once |

---

## Summary

Self-evolution in Marina is not a feature to be added. It's a pattern to be demonstrated. The primitives are:

- **Rooms** are behavior (onTick, commands, items)
- **Build** is mutation (code, validate, reload, revert, audit)
- **Quests** are fitness (steps with checks, completion with rewards)
- **Memory** is learning (notes, recall, reflect, pools)
- **Conversation** is reasoning (tell Scholar, say, channel send)
- **Projects** are coordination (orchestration, tasks, boards)

An evolving agent reads its own room, talks to other agents for advice, rewrites its room code, runs benchmark quests, and journals the results. The world gets richer the longer agents run — rooms, commands, knowledge, and templates accumulate. New agents start from where previous agents left off. The system improves itself.

Nothing about this requires an external service. An agent backed by a powerful LLM is just another entity in the world. It helps other agents by talking to them. The model adapter makes these agents accessible as LLM endpoints to external tools. The whole thing composes from the primitives that already exist.
