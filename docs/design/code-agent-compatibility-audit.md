# Code Agent Compatibility Audit

This audit exists to keep Marina honest while building Code Mode. Profiles such as
`claude`, `codex`, and `pi` are migration adapters, not product clones. The Marina profile should
take the best patterns from coding tools and expose them through durable Marina primitives.

## Current Confidence

- High: Marina has a real local loop for sessions, workspace selection, file inspection, patch
  proposal/application, allowlisted command runs, persisted command output, and typed artifacts.
- Medium: profile aliases help users migrate muscle memory for common inspect, patch, run, and
  steering actions.
- Low: behavioral parity with full Claude Code, Codex CLI, Cursor, or Pi command surfaces. We have
  not implemented their complete command semantics, UI flows, permission systems, cloud/background
  workflows, or app-observation loops.

## Source-Derived Corrections

- Claude `/verify` is not merely a test command. It is a bundled skill intended to build, run, and
  observe the app to confirm behavior. Marina `code verify` currently runs a detected local check
  chain and stores artifacts. That is useful, but it is not Claude-style app verification yet.
- Codex has separate concepts for session slash commands, permission profiles, sandbox policy,
  app-server/remote control, background terminals, subagents, fork/resume, review, and skills.
  Marina currently covers only a subset through Code Mode plus existing Marina agent primitives.
- Pi is intentionally minimal and extensible. Its strongest lesson for Marina is customization:
  extensions, skills, prompt templates, session trees, queued follow-ups, and adaptable UI. Marina
  should preserve that spirit without inheriting Pi's intentionally omitted features.
- Flywheel is relevant as an execution substrate: sessions, events, functions, sandbox images, image
  builds, and sandbox network/runtime settings. It does not replace Code Mode semantics.

## Compatibility Grades

- Native: backed by a Marina primitive with equivalent or stronger semantics.
- Adapter: different Marina primitive, but the user-facing action is close enough for migration.
- Narrow: useful subset only; the name should not imply full parity.
- Planned: important for effectiveness but not implemented.
- Deprioritized: product-specific UI or account feature that does not help Marina's coding
  civilization goal.

## Capability Matrix

| Capability | Marina now | Grade | Next need |
| --- | --- | --- | --- |
| Enter coding mode | `code`, modal prompt state | Native | Frontend prompt label polish |
| Session persistence | DB sessions/events/artifacts | Native | Branch/tree relations |
| File inspect/read/search | confined `LocalWorkspace` | Native | richer structured search results |
| Patch propose/apply | stored unified diff artifact | Native | multi-file review UI |
| Run checks | allowlisted runner, command artifacts | Native | configurable project recipes |
| Verify app behavior | manual observation artifacts; host app scripts disabled | Planned | container/userland launch recipe, browser/TUI/API observation |
| Plan/summary/handoff/decision | typed artifacts | Native | promote into richer thread UI |
| Agent assignment | binds live Marina agent into session | Adapter | typed agent tools for every code action |
| Subagents/parallel work | possible via Marina agents/crews | Planned | `code spawn`, `code crew`, result summaries |
| Session branch/tree | not modeled | Planned | parent artifact/session IDs |
| Permissions | host-safe command allowlist | Narrow | per-user/profile workspace and command policy |
| Sandbox/container | deferred | Planned | Flywheel/OpenShell-style execution adapter |
| Skills | global Marina skills exist | Adapter | code-modal skill registry and invocation |
| Model/provider switching | Marina model surface exists | Adapter | per-session code model/profile settings |
| Background tasks | Marina agents can keep working | Adapter | explicit code task status and notifications |
| App/web observation | absent | Planned | run recipes, browser tool, screenshots/artifacts |

## Marina Should Lead Here

Marina can be better than clone compatibility because it is multiuser and multiagent by default.
The best target is a shared coding civilization:

- People and agents collaborate in the same WebChat thread, channels, rooms, projects, and memory.
- A coding session can be served by a direct model, one assigned agent, a crew, or a routed external
  coding harness without changing the user-facing modal.
- Profiles map familiar syntax to Marina primitives, while the Marina profile remains free to evolve
  toward the best workflow.
- Skills should work at two levels: base Marina skills that shape world behavior, and Code Mode skills
  that shape coding-agent behavior for a workspace/session.
- Compatibility docs should mark gaps plainly so users understand whether a command is equivalent,
  narrower, or a Marina-native improvement.

## Safe Next Implementation Steps

1. Add project run recipes: detected scripts first, then stored recipe artifacts, then eventually
   generated skills.
2. Implement `code run app` through the container/userland runner with persistent supervised app runs.
3. Add code-modal skills with progressive disclosure and per-workspace discovery.
4. Add session branching/tree metadata before building Pi-style tree navigation.
5. Add agent/crew orchestration commands using existing Marina safety gates.
6. Add browser/TUI/API observation artifacts before claiming full Claude-style verify behavior.
