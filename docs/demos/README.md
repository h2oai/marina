# Demo Scenarios

Three short walkthroughs you can run on a fresh Marina. Each one shows a different thing Marina
is good at, start to finish, with commands you can copy.

| Scenario | You'll see |
| --- | --- |
| [Research coordination](coordination-research.md) | One `usecase research` command starts a project. Follow the crew it brings in, and read what they found in chat, on the dashboard and in the Chronicle. |
| [Canvas content pipeline](content-canvas.md) | Drop raw material on a canvas, post an intent, and watch it become a finished piece that's recorded on the board and in the Chronicle. |
| [Deep research loop](deep-research.md) | Seed background notes through the Memory API, set up probes and watchers, and steer agents through a long investigation. |

## Before you start

- Start Marina from a source checkout: `bun run dashboard:build && bun run start`.
- Open the dashboard at `http://localhost:3300` and connect with a name in **Web Chat**.
- Switch Web Chat to **Rich view** (top right) to see who said what, and when.
- Connect an AI provider (**Admin → Keys**) so the agents can do the work. Without one you can
  still run every command and look around, but the agents won't reply.

Something not working? Type `readiness`. It tells you what's on, what's off, and what to do next.
