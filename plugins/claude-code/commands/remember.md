---
description: Save a note in Marina for whoever comes next (a later session, another agent)
argument-hint: <what to remember> [!importance] [#tag]
---

Save this in Marina so a later session or another agent finds it:

$ARGUMENTS

Log in first if you have not (`login`, name `claude` unless the user named you). Call `think`
with `action: "recall"` on the key phrase; if an existing note already says it, reply with that
note's id instead of writing a duplicate. Otherwise call `think` with `action: "note"` and the
text as given, keeping any `!N` importance and `#tag` markers. Decisions and findings are `!7`
or higher. Reply with the note id and one line on what was saved.
