# Deep Research Loop Demo

This scenario combines the Memory API, probes, and watcher automation to run a
multi-step investigation. Start Marina (`bun run start`) with an upstream LLM
key so agents can execute.

## 1. Seed Context via Memory API

Collect background notes from an external script or shell:

```bash
curl -X POST http://localhost:3300/mem/notes \
  -H "Content-Type: application/json" \
  -H "X-Agent-Name: research-seed" \
  -d '{"content":"NOAA reports a 2026 marine heatwave forming in the North Pacific.","importance":7,"type":"fact"}'
```

Verify recall inside Marina:

```text
> recall marine heatwave
```

## 2. Launch a Watcher + Research Agent

```text
> agent spawn Watcher model marina/default role watcher goal "Track marine heatwave signals."
> usecase research north pacific marine heatwave forecast
```

The watcher patrols relevant feeds and the research crew investigates. Toggle
the web chat to **Rich view** to see watcher probes and researcher updates with
timestamps.

## 3. Probe Specific Questions

```text
> probe marine-heatwave-risk What coastal industries are most exposed?
> probe results
```

Each probe writes notes and links them back to the investigation. The Rich chat
view groups probe responses, while the dashboard **Activity Feed** surfaces the
linked notes.

## 4. Compile a Final Brief

```text
> brief full
> chronicle record Marine Heatwave Briefing | Compiled watcher + research findings refs probe:marine-heatwave-risk,board:research-report
```

Optional: export the state for later replay.

```bash
./scripts/export.sh demos/deep-research
```

This loop demonstrates how external context (Memory API), continuous monitors
(watchers/probes), and in-world agents keep long-form research grounded and
auditable.
