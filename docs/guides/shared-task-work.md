# Shared task work

`task work` is an experimental, optional place to maintain a task's decisions,
citations and proposed edits. It helps participants see which evidence supports a
field and reuse a current result for declared checks. People and agents use the
same commands. It does not run another model, approve a task, change agent loops,
or require a new approval step. Ordinary `task submit` and `task approve` continue
to work whether or not a task has a work record.

Start with an existing task that you created or currently claim. In this example,
task 7 has no work record yet, and `note:42` is a source you can read containing
the exact sentence `Maximum traffic is 10 percent.`

```text
task work 7
task work 7 patch 0 {"traffic":20}
task work 7 cite 1 {"field":"traffic","ref":"note:42","quote":"Maximum traffic is 10 percent."}
task work 7 expect 2 {"field":"traffic","op":"lte","expected":10,"citation":"c2"}
task work 7 check
```

The result reports a discrepancy: `traffic` is 20 while the declared maximum is
10. Correct the field using the revision returned by `task work 7`:

```text
task work 7 patch 3 {"traffic":10}
task work 7 check
task work 7 check
```

The correction keeps its citation. The second check reuses the current receipt.
These revision numbers assume only the example commands have changed the record;
always read the latest revision when collaborating. Repeating an identical patch
does not create a revision. Values can be strings, finite numbers, booleans or
null. Field names start with a letter and contain letters, digits, dots,
underscores or hyphens, up to 128 characters. Dots are literal parts of a field
name; patches do not rewrite nested documents or external files.

The task creator is the reviewer; current claimants own the draft. Other people
or agents who can read the task can attach evidence, declare checks and propose
changes:

```text
task work 7 propose 4 {"traffic":5}
task work 7
task work 7 accept 5 p5
```

The creator or a current claimant accepts a proposal. It changes only its named
fields. Acceptance refuses a proposal whose fields changed since it was made;
unrelated field edits can coexist. The participant can inspect the new values
and make an updated proposal or an explicit owner edit. This protects the shared
record from stale writes and does not restrict ordinary conversation or task
submission.

Each citation belongs to a field and records a source reference, content version
and quotation offsets. Supported sources are `note:N`, `task:N`, `chronicle:N`
and `asset:<id>`. A citation can be attached only when the contributor can read
the source and the quotation appears verbatim in its full text. The shared record
does not copy the source's private quotation. Every view resolves access again;
another reader sees `unavailable` when the source is missing or inaccessible.
Unavailable evidence remains attached. Source access is not expanded by citing it.
Field values and declared expectations are shared contributions to the task, so
only put information there that you intend its readers to see.

An ordinary field patch preserves all citations and checks. To retire a citation,
constraint or proposal, its author or a task owner supplies a reason:

```text
task work 7 retire 6 c2 Replaced by the updated capacity measurement
task work 7 show 4
```

Previous revisions and retirement reasons remain inspectable. Historical views
still respect current source access. If a source is revised in place, the old
quotation is withheld because its version no longer matches. A superseded or
disputed note, or a chronicle entry with a correction, is labeled accordingly.
Attach the current source and retire the
obsolete citation or constraint explicitly.

Declared checks support `eq`, `lte`, `gte` and `oneOf`. The first compares a scalar
value, the next two compare numbers, and `oneOf` takes a nonempty JSON array of
allowed scalar values. Each check names a current citation for the same field.
The expectation is the contributor's interpretation of that evidence; Marina
does not prove that the interpretation is correct. Contradictory interpretations
can remain visible together for participants to resolve.

Results distinguish:

| Result | Meaning |
| --- | --- |
| `consistent` | Registered fields match the declared checks, their citations are current and readable, and no proposal remains pending. |
| `discrepancies` | At least one value contradicts a declared check whose cited source is current and readable. |
| `unverified` | A field lacks a check, evidence is unavailable/changed/superseded/disputed, a proposal remains pending, or there are no checks. |

The report names each check and the actual and expected values. It is advisory:
`consistent` is not task approval, proof of completeness, or verification of an
external deliverable. Source text is evidence rather than instructions. Neither
agreement between agents nor a citation alone establishes that a decision is true.

Receipts are specific to the reader, work revision, task requirements, current
source versions/access/status, and check implementation. Access and sources are
resolved before reuse. A receipt expires after one hour; `task work 7 check fresh`
recomputes immediately. New evidence must be attached to the record to be checked;
these commands do not monitor outside systems. Retired sources do not invalidate
current receipts. No background checker, peer wake-up, reply suppression, model
call or additional turn/token limit is introduced.

Work revisions and receipts survive restart and world export/import. Schema 185
adds their tables without modifying existing tasks or claims. Account erasure
anonymizes shared author metadata and removes that reader's receipts. Group task
access and the existing as-of evidence fence continue to apply.

## Structured deliverables

A task can also hold the actual nested JSON deliverable. This avoids keeping the
same decisions in a separate scalar record. `artifact-edit` uses JSON Pointer
paths and returns the new revision, exact JSON content and SHA-256 hash:

```text
task work 7 artifact-edit 0 [{"op":"set","path":"","value":{"phase":1,"items":[{"value":50,"citations":[]}]}}]
task work 7 artifact-edit 1 [{"op":"set","path":"/items/0/value","value":37}]
task work 7 render
```

Start from the current revision, which may differ from these example numbers.
`set` adds a member or changes a scalar; it preserves all untouched content.
`append` adds a distinct array entry. Replacing a container uses `replace` with a
`reason`; removing a member uses `remove` with a `reason`. A batch is atomic.
Disjoint native edits can use an older revision, but overlapping edits are refused,
even if another participant changed a value and changed it back. Array removals
invalidate stale numeric paths. An identical edit creates no revision.

To copy an exact source selection into the authored deliverable, use `source` in
an edit batch, or the equivalent `artifact-source` command. For a readable JSON
note containing `doc_id` and `statements`:

```text
task work 7 artifact-source 2 {"path":"/items/0/citations","ref":"note:42","pick":{"doc_id":"/doc_id","quote":"/statements/0"}}
```

This **explicitly publishes** the selected values to everyone who can read the
task, including later historical views. Choose only content you intend to share.
It is different from scalar `cite`, which retains a reference and rechecks the
reader's source access. An inaccessible source or missing selection aborts the
entire batch. Existing citation entries remain intact. A literal `append` is also
available for authored values; it does not verify a quotation.

Declare checks on the deliverable itself:

```text
task work 7 artifact-rule 3 {"id":"batch-bound","path":"/items/0/value","op":"lte","expected":37,"source":{"ref":"note:42","quote":"Maximum batch size is 37 items."}}
task work 7 artifact-check
task work 7 artifact-check fresh
```

Supported operators are `required`, `eq`, `oneOf`, `lte`, `gte`, `unique` and
`setEquals`, plus source-selection coverage with `includesSource` (below). Evidence is optional and is labeled `undeclared` when omitted.
Checks with unavailable, changed or superseded evidence are unverified. A shape
change that makes a checked path absent or incompatible reports a discrepancy.
Rules have stable IDs; their author or a current task owner can update them, or
remove them with `artifact-unrule <revision> <id> <reason>`. Changes and removal
reasons remain in revision history. Historical views respect current source access.

`matches-declared-checks` means only that the listed comparisons match. It is not
independent support for the interpretation or coverage of missing requirements.
For example, distinguish a permitted action from a completed prerequisite, and
keep requirements for the current phase separate from cumulative history. A
wrong expectation can still match a wrong decision. Participants retain judgment
and can revise requirements when evidence changes. Check receipts use the same
reader, revision, source/access and task-requirement invalidation as scalar checks.

World commands return JSON; they do not assume a host or sandbox file mapping.
Integrations can use `editTaskArtifactFile` from
`src/coordination/task-artifact-file.ts` to apply native edits and publish the
returned content to an authorized workspace file. The adapter adopts ordinary
file edits before applying the scoped batch. Its caller must supply the revision,
file version and hash observed during the last read, and provide an atomic
compare-and-write implementation. Every workspace write must advance the version,
including ordinary writes that return a file to earlier bytes. Unmanaged external
writes are outside that guarantee. The native commit and file publication are
separate: publication failure reports the retained native revision and requires
rereading both before retrying. There is no silent host execution or claimed
host/guest file coherence. A missing file is not automatically restored from an
existing native artifact.

These operations remain optional. No background verification, mandatory review,
loop scheduling change or task-approval condition is added.

## Evidence coverage and current context

A valid quotation can still omit evidence needed for a decision. Declare the
source selections that each citation array needs, then use `artifact-check` to
find gaps. `includesSource` compares fields selected directly from a readable
source against fields on the **same** citation entry. All selected values must
match exactly; extra entry fields are allowed. This verifies the declared
selection's presence, not whether it proves the decision or covers every relevant
source. A full-statement selection requires that full statement in the artifact.

```text
task work 7 artifact-rules 4 [{"id":"technical-support","path":"/items/0/citations","op":"includesSource","selection":{"ref":"note:42","pick":{"doc_id":"/doc_id","quote":"/statements/0"}},"when":{"path":"/phase","equals":1}}]
task work 7 artifact-check
```

`artifact-rules` declares a batch atomically using one starting revision. A bad
rule leaves the entire batch unapplied. `artifact-source` can publish the exact
missing selection while preserving existing citations. Coverage rules retain
source references and versions; they do not copy private source contents into the
shared work record. Checks re-resolve access and mark changed or inaccessible
sources unverified. Update a rule deliberately after reviewing a changed source.

Any artifact rule can have `when: {path, equals}`. It is inactive outside that
context, so an old decision's expectation does not contradict its replacement.
Inactive rules remain visible in history. No active checks means unverified;
`coverage.complete: null` means no active evidence-coverage requirement was
declared. A matching value check alone is not evidence coverage.

Keep cumulative history separate from the current deliverable with a `project`
edit. Record the entries introduced in the current context, rather than carrying
all previous entries into the output:

```text
task work 7 artifact-edit 5 [{"op":"project","path":"/superseded","scopePath":"/phase","entries":[{"old_doc_id":"policy-0","new_doc_id":"policy-1","reason":"Updated policy"}],"reason":"Changes introduced in this phase"}]
```

The projection stores the entries under the current value of `/phase` and writes
only that batch to `/superseded`. Identical entries are deduplicated. Other
contexts remain in the authored projection history returned by `render`, and old
revisions remain readable. The output and scope paths must not overlap.

After changing the phase, supply the new phase's entries explicitly, including
`[]` when there are none. An unknown context is unverified, not assumed empty.
To restore an already recorded context, omit `entries`; this repairs an output
that accumulated old entries without asking a model to reconstruct the history.
`artifact-check` detects a difference between the current projection and its
recorded batch. Ordinary edits remain available and are never blocked by a
projection discrepancy. Projection entries are authored shared content, not
proof that a supersession is semantically correct.

## Assess evidence separately from the draft

For a question needing interpretation, an authored expectation can repeat the
same mistake as the draft. Request an evidence packet that omits draft values and
declared expectations, and answer its questions from the sources before comparing:

```text
task work 7 artifact-review [{"id":"eligibility","path":"/items/0/value","question":"Which candidate is eligible now, considering permission and completed technical validation?","refs":["note:42","note:43"]}]
```

The packet contains task requirements, the requested questions, readable source text and statuses,
and an opaque fingerprint. Unavailable sources remain labeled unavailable.
Questions and sources can themselves contain bias; the tool cannot prove they
are complete or neutral. Use a fresh context or another participant when useful;
this command does not spawn agents or claim to establish independent reasoning.
Do not include the proposed answer in the question. Provide both supporting and
potentially disconfirming sources, rather than only a draft's selected citations.

The same reviewing identity can compare its source-cited answers with the draft:

```text
task work 7 artifact-assess {"fingerprint":"<packet fingerprint>","questions":[{"id":"eligibility","path":"/items/0/value","question":"Which candidate is eligible now, considering permission and completed technical validation?","refs":["note:42","note:43"]}],"answers":[{"id":"eligibility","status":"answered","value":"none","reason":"No candidate has completed validation.","citations":[{"ref":"note:43","quote":"No candidate has completed validation."}]}]}
```

Each question needs exactly one answer. Use `status: "unknown"` with a reason
and `citations: []` when the evidence is insufficient. Answered assessments need
verbatim quotations from current accessible sources listed for that question.
The comparison records agreement, disagreement or uncertainty, and flags whether
the reviewer has a recorded overlapping contribution, which can be to an older
value. That conservative flag is not current-value attribution or an independence test. Quotations establish source membership, not
entailment. Agreement does not override missing support or approve a task.

Changed work, task requirements, source versions or access invalidate the packet;
obtain a new one before comparing. Identical assessments can reuse a current
receipt. Review packets are read-only; assessment receipts are stored separately
from deliverable revisions. These tools make no model calls and add no mandatory
review or scheduling behavior.
