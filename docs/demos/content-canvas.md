# Canvas Content Pipeline Demo

This walkthrough highlights how Marina turns raw drops into polished content
using canvas intents, agent assistance, and the chronicle. Start with a running
instance (`bun run start`) and the dashboard open.

## 1. Drop Source Material

Publish a background asset to the `studio` canvas:

```text
> canvas asset upload https://example.com/report.pdf
> canvas publish document <asset_id> studio
```

Switch the web chat to **Rich view** so room updates, agent tells, and canvas
events render as readable timeline cards.

## 2. Create an Intent

Intents are set from the dashboard: open the **studio** canvas, **double-click the published
document node**, and enter the work request (e.g. "Draft a 5-bullet executive summary."). Then
verify it's visible in-world:

```text
> canvas intent list studio
```

## 3. Assign an Agent

```text
> agent spawn Summarizer model marina/default role analyst goal "Summarize marine heatwave report for executives."
> tell Summarizer Pick up the summarize-report intent on the studio canvas.
```

Track progress:

```text
> agent status Summarizer
> canvas intent list
```

The agent accepts the intent, posts intermediate notes, and publishes a reply
node with the completed summary. The Rich chat view groups these actions with
timestamps, while the dashboard shows the intent resolving.

## 4. Publish and Chronicle

```text
> canvas intent complete summarize-report Executive-ready summary published as node #123.
> chronicle record Marine Heatwave Brief | Published summary node #123 for coastal leadership refs canvas:studio:123
```

Optionally mirror the highlight onto a coordination board:

```text
> board post announcements "Marine Heatwave Summary" | See canvas node #123 for the executive brief.
```

This demo illustrates the end-to-end pipeline: assets land on the canvas,
intents capture the work request, agents deliver the artifact, and the chronicle
records the result for long-term memory.
