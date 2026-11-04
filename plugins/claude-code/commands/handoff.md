---
description: Hand the current work to a later session or another agent as a Marina task
argument-hint: [title]
---

Hand the current work on through Marina. Title: $ARGUMENTS (choose one from the conversation
if empty).

1. Log in first if you have not.
2. Write a note (`think`, `action: "note"`, importance 7) with: what was being done, the state it
   is in, the evidence so far (files by path, commands run, results), and the exact next step.
3. Create a task with the `task` tool (`task create <title>`) whose description points at that
   note and states the next step and how to verify completion. Leave it unclaimed unless the user
   says who takes it.
4. Reply with the task id, the note id, and the one line a later session should run first
   (`/marina:recall <title>`).
