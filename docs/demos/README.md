# Demo Scenarios

These demo scripts walk through end-to-end flows you can run on a fresh Marina
instance. Each scenario highlights a different capability surface — coordination
crews, canvas-driven content creation, and deep research with the memory and
probe substrates.

| Scenario | What it Demonstrates |
|----------|----------------------|
| [Research Coordination](coordination-research.md) | Launching a `usecase research` project, tracking spawned agents, and reading their output across chat, dashboard, and chronicle surfaces. |
| [Canvas Content Pipeline](content-canvas.md) | Using canvas intents to turn raw assets into polished deliverables and recording the result in the chronicle + boards. |
| [Deep Research Loop](deep-research.md) | Seeding context through the Memory API, running probes/watchers, and steering agents through long-running investigations. |

Each playbook assumes Bun ≥ 1.1, a local Marina instance started with
`bun run start`, and the dashboard open at `http://localhost:3300/dashboard`.
Toggle the web chat into **Rich view** (top-right switch) to follow the timelines
with speaker badges and timestamps while you run the commands.
