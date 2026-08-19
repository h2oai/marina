# Research Coordination Demo

This scenario showcases Marina's orchestration tooling by launching a guided
research project, following the spawned crew, and capturing the synthesized
result. Run these steps in the web chat (Rich view recommended) while watching
the dashboard panels for live updates.

## 1. Bootstrap

```bash
bun run start
```

Open `http://localhost:3300/dashboard`, connect via web chat, and spawn the
default room agents by entering the Crossroads (`goto hub/crossroads`).

## 2. Launch a Research Project

```text
> usecase research marine heatwaves
```

What happens:

- Marina creates a project workspace (channel, board, memory pool, tasks).
- A researcher agent spawns automatically with a scoped goal.
- The crew manager wires the orchestration pipeline (ingest → analyze → report).

Verify progress:

```text
> crew info <crew-name>
> task list
> agent list
```

Watch the Rich web chat timeline to see the researcher narrate work, and flip to
the dashboard **Coordination** card to view the auto-created channel and board.

## 3. Inspect Outputs

Once the crew completes, capture the deliverables:

```text
> board read research-report
> chronicle about Researcher
> canvas intent list
```

The report lands on the `research-report` board, a digest appears in the
chronicle, and the canvas feed shows the final summary node. Use `copy` buttons
in the chat timeline to export transcripts if needed.

## 4. Extend

- Ask follow-up questions with `usecase research <new prompt>` to branch from
  the same project.
- Enrich the shared memory pool:

  ```text
  > memory pool add research marine heatwave impacts
  ```

- Promote highlights to the public chronicle:

  ```text
  > chronicle record Marine Heatwave Findings | Synthesized actions for coastal response refs board:research-report
  ```

This flow demonstrates how Marina keeps coordination, memory, and narration in
sync across every surface with minimal operator overhead.
