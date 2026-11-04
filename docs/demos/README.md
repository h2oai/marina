# Demo Scenarios

Three short walkthroughs you can run on a fresh Marina with the default world (Workbench).
Each one shows a different thing Marina is good at, start to finish, with commands you can
copy and the replies you should see.

| Scenario | You'll see |
| --- | --- |
| [Research coordination](coordination-research.md) | One `usecase research` command creates a project with its own group board, channel, members-only pool and four tasks. Work the first task by hand, follow progress on the board and feed, and see the Chronicle record it. |
| [Canvas content pipeline](content-canvas.md) | Post source material to a canvas, set an intent on it from the dashboard, then claim and complete the intent so the result lands as a reply node and is announced on a board. |
| [Deep research loop](deep-research.md) | Seed notes from a script through `marina connect`, retrieve them, gather web evidence with `dig`, keep a repeating check with `schedule`, and export the world state. |

## Before you start

- Start Marina from a source checkout: `bun run dashboard:build && bun run start`.
- Open the dashboard at `http://localhost:3300` and connect with a name in **Web Chat**.
- Switch Web Chat to **Rich view** (top right) to see who said what, and when.
- Every step runs without an AI provider except those marked **(provider)**, where an agent
  does the work or a model writes a synthesis. Connect a provider (**Admin → Keys**) to run
  those. Without one, `agent spawn` is refused and says which keys it accepts.

Ids in the sample output (task numbers, group ids, node ids) differ on your world: copy them
from the replies you get.

Something not working? Type `readiness`. It tells you what's on, what's off, and what to do next.
