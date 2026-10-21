---
name: consolidate-memory
description: The scheduled reflection loop (generate, reflect, curate) that turns a pile of new notes into a smaller, sharper memory
tags: reflection, consolidate, consolidation, curate, memory, ace
importance: 7
---

# Procedure — generate, reflect, curate

Run this when your continuation prompt says `[Reflection Due]`. It follows Agentic Context
Engineering (arXiv:2510.04618): incremental updates, not periodic rewrites.

1. **Generate.** What is your working hypothesis for the current focus? State it in one
   sentence: what do you expect to happen, be true, or work?
2. **Reflect.** `recall <focus>` and `reflect <focus>` surface what actually happened. Where did
   the hypothesis hold? Where did it break? Cite specific note ids.
3. **Curate.** Keep what is load-bearing and fix what is wrong:
   - `note link <a> <b> <relation>` for confirmed structure;
   - `note evolve <id>` or `note correct <id> <text>` to supersede an observation (supersede,
     don't delete);
   - `note delete <id>` only for an outright error;
   - if a generalisable procedure surfaced, `skill store <name> | <desc> | <actions>` so future
     agents inherit it.

The goal is a smaller, sharper memory — not more notes.
