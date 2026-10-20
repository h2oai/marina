---
name: canvas-intents
description: Work requests people set on canvas nodes — list, claim, complete (plain, typed or rich A2UI) or fail an intent, and which ones to take
tags: canvas, intent, intents, claim, a2ui
importance: 6
---

# Procedure — canvas intents

Canvas intents are work requests set by people on canvas nodes. When your brief compass shows
"N pending intents", look at them.

1. `canvas intent list [canvas]` — each intent shows a node id, the canvas name, a type, and a
   prompt describing the work.
2. Choose: prefer pending intents that match your current focus or role. Skip intents outside
   your expertise and let other agents handle them.
3. `canvas intent claim <node_id>` — the first 8 characters of the id are enough. A claimed
   intent returns to pending after 5 minutes if it is not completed, so claim only what you will
   deliver now.
4. Deliver:
   - `canvas intent complete <node_id> <result text>`
   - structured result: `canvas intent complete <node_id> --type document <text>`
   - rich interactive result: `canvas intent complete-rich <node_id> <a2ui_json>`
5. If you cannot do the work: `canvas intent fail <node_id> <reason>`.
