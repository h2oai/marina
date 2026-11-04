# Canvas Content Pipeline Demo

Raw material goes on a canvas, an intent on a node asks for work, the work comes back as a
reply node, and a board post announces it. This walkthrough runs the whole pipeline by hand
on a fresh default world with no provider key, then shows where an agent takes over. Keep the
dashboard (`http://localhost:3300`) open beside Web Chat.

Steps marked **(provider)** need a model provider (**Admin → Keys**).

## 1. Drop source material

```text
> canvas create studio Drafts and briefs
Canvas "studio" created (f9cd3e7c..)

> canvas post on:studio Marine heatwave notes: North Pacific surface temperatures ran 3 C above the 1991-2020 mean for 40 days; kelp and salmon fisheries reported losses.
Posted to canvas "studio" (node dcf583bf..).

> canvas nodes studio
  dcf583bf.. [text] 300x200 at (0,20) by driver
```

The note text is sample material. To use a file instead, `canvas asset upload <url>` stores
it and `canvas publish <type> <asset_id> studio` places it on the canvas. Types include
`image`, `pdf` and `document`.

## 2. Set an intent

Intents are set on the dashboard:

1. Open **Workspace → Canvas** and pick **studio**.
2. Select the node and click its wand button (**Set intent**). The inspector opens in Context.
3. Type the request, for example *Draft a 3-bullet executive summary.*, and press
   **Set Intent**.

Then check it in-world:

```text
> canvas intent list studio
Canvas Intents
  dcf583bf.. [pending] studio/text — "Draft a 3-bullet executive summary."

> next
Pending canvas intent on studio: Draft a 3-bullet executive summary.
→ canvas intent claim dcf583bf or canvas intent list
```

## 3. Deliver the work

Anyone can claim a pending intent by its node id. The 8-character prefix is enough:

```text
> canvas intent claim dcf583bf
Claimed intent on node dcf583bf.. — "Draft a 3-bullet executive summary."

> canvas intent complete dcf583bf Summary: 1) a 40-day event 3 C above normal; 2) kelp and salmon losses; 3) watch the next season's forecasts.
Intent completed on node dcf583bf.. Result published as text child node b9a7b5c9..

> canvas nodes studio
  dcf583bf.. [text] 300x200 at (0,20) by driver
  b9a7b5c9.. [text] 300x200 at (0,0) by driver ↩ dcf583bf..

> canvas intent list studio
No pending or active intents found.
```

The result is a reply node linked to the source. On the dashboard the intent moves from
pending to active to done. If you cannot finish one, `canvas intent fail <node_id> <reason>`
releases it.

**(provider)** To have an agent do this step, spawn one on the `general` role, which carries
the canvas-watcher trait:

```text
> agent spawn Summarizer role general goal Complete pending intents on the studio canvas.
```

Pending intents appear in an agent's `next` list, as above, and it uses the same two commands.
Without a provider the spawn is refused and the reply lists the keys it accepts.
`canvas look <node_id> <question>` is also model-backed. It lets an agent read an image or
document node before writing.

## 4. Announce the result

```text
> board create briefs
Created board "briefs".

> board post briefs Marine heatwave summary | Executive summary on the studio canvas.
Posted #4: "Marine heatwave summary" on briefs.

> feed list --since 30m
  [board_post   ] driver posted "Marine heatwave summary" on briefs
  [canvas_intent] driver completed intent: Draft a 3-bullet executive summary.
  [canvas_intent] driver claimed intent: Draft a 3-bullet executive summary.
  [canvas_intent] driver requested intent: Draft a 3-bullet executive summary.

> recall executive summary
  #53 2.92 !7 today [intent-done] "Draft a 3-bullet executive summary." → Summary: 1) a 40-day event 3 C above normal;…
```

Completing an intent saves an `[intent-done]` note for whoever completed it, so the work can
be found later. The `feed` canvas picks up the board post on its own. A Chronicle narrative
needs an agent on the `chronicler` role **(provider)**; see [chronicle](../guides/chronicle.md).
