# Shared task work

`task work` is an experimental, optional place to maintain a task's decisions,
citations and proposed edits. It helps participants see which evidence supports a
field and reuse a current result for declared checks. People and agents use the
same commands. Edits and checks make no model calls. An explicit
`artifact-review-fresh` request can ask a configured model in a separate context.
Neither path approves a task, changes agent loops or requires a new approval step.
Ordinary `task submit` and `task approve` continue
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
call or additional turn/token limit is introduced by these checks.

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

To attach evidence and remember its coverage requirement in one atomic edit, add
`coverage`. The stable ID identifies the requirement; use a different ID for each
required source selection. `requirement` explains what the task needs, while the
optional `scopePath` binds it to the current context:

```text
task work 7 artifact-source 2 {"path":"/items/0/citations","ref":"note:42","pick":{"doc_id":"/doc_id","quote":"/statements/0"},"coverage":{"id":"capacity-support","requirement":"Include the current measured capacity","scopePath":"/phase"}}
```

This copies exact values and records the `includesSource` rule in the same
revision. If either fails, neither is saved. Repeating it unchanged is idempotent.
When the context changes, feedback marks this requirement as needing renewed
evidence and coverage stays incomplete until every carried requirement is renewed
or retired. Attach the new selection using the same coverage ID, or deliberately
retire the requirement. The earlier rule remains in revision history. Ordinary
`source` edits without `coverage` still work without declaring a requirement.
They may deliberately copy accessible historical sources; coverage declarations
require current evidence and do not certify historical copies as current support.

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

Successful edits and current `show` responses include advisory `feedback` with
named outstanding requirements. `artifact-check` includes the same feedback and
stores a reusable receipt. The file adapter forwards feedback after publishing
the actual file. When a task already has an artifact, `task submit` reports any
remaining findings **after accepting the submission**; a finding never blocks it.
An empty set of checks explicitly reports that no active requirements were checked.
Feedback inspects declared requirements only: it cannot infer all obligations
from a natural-language task brief or certify that the declared rules are right.

Type discrepancies identify numbers and booleans supplied as strings; values are
never coerced. Replacing equality with `required` checks presence only, and an
inactive condition supplies no verification. A matching authored list also
reports that membership needs interpretation; matching your own expectation does
not establish which entries belong in the list. These informational `notices`
do not count as outstanding `findings` or request repeated checks of unchanged work.

Missing source selections may include a suggested `source` append, which keeps
existing citations. A mismatched projection may suggest restoring its recorded
current batch. Suggestions are not executed automatically and are not permission
to discard other valid evidence. Re-read the current revision before applying
them. Literal quotations outside declared coverage still need inspection.

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
`coverage.complete: null` means no active or carried evidence-coverage requirement
was declared. A matching value check alone is not evidence coverage.

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

For a list that should follow context changes, use an ordinary replacement with
`scopePath`, or explicitly enable `followScope: true` on a `project` edit:

```text
task work 7 artifact-edit 6 [{"op":"replace","path":"/superseded","scopePath":"/phase","value":[{"old":"policy-0","new":"policy-1"}],"reason":"Publish only this phase's corrections"}]
task work 7 artifact-edit 7 [{"op":"set","path":"/phase","value":2}]
```

Once enabled, changing the scope renders that context's recorded batch. A new
context renders an empty view but remains **unverified** until entries are
explicitly supplied; `[]` is a valid explicitly declared empty batch. Ordinary
edits to the bound list update its current batch while retaining other contexts.
An explicit whole-file replacement that supplies both scope and output is
treated as an authored current batch, so file adoption preserves what the author
wrote. The binding does not decide whether supplied entries are semantically
current. Returning to a recorded context restores its list. Stale indirect edits
are refused. Following bindings must have independent output/scope paths.
To stop following, issue a `project` edit with `followScope: false` before
removing its scope or output. Existing projections do not follow automatically.

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

Supply `answerType` from the task contract: `string`, `number`, `boolean`, `array`,
`object` or `null`. The answer must contain the derived value in that type; `true`
is not an answer to a question whose value is a candidate name. A wrong declared
type is refused with a format explanation and no receipt. For older questions
without a declared type, incompatible answer/draft types produce
`invalid-assessment`, not a decision disagreement. Explicit types also let a
review identify a wrongly typed draft. Omit `question` to use a neutral prompt
asking for the source-derived current value and disconfirming evidence.

For a finite set, optionally select its criterion and complete candidate list
directly from a current readable source. For example, if `note:42` is a JSON task
contract and `note:43` contains current request statuses:

```text
task work 7 artifact-review-fresh {"questions":[{"id":"pending","path":"/unresolved","answerType":"array","refs":["note:42","note:43"],"set":{"ref":"note:42","criterionPath":"/unresolved_scope","candidatesPath":"/allowed_unresolved_questions"}}]}
```

This packet includes the selected criterion and candidates, but no draft values.
The reviewer classifies every candidate as `include`, `exclude` or `unknown`, with
a reason and current source quotations for each inclusion or exclusion. The
answer's `membership` array contains `{value,status,reason,citations}` entries.
An answered set must classify every candidate exactly once, contain no unknowns,
and return exactly the included values without duplicates. Set comparisons ignore
order; ordinary array reviews still compare order. An empty result needs evidence
for excluding every candidate. A future prerequisite, completed request or known
failure is not automatically a currently unanswered request.

Both `artifact-review`/`artifact-assess` and `artifact-review-fresh` accept this
option. The contract reference must be in `refs`; inaccessible or superseded
contract sources are refused. Missing evidence remains unknown. The caller still
chooses the contract, source coverage and question, and authentic quotations alone
do not establish that the classification is correct. Review never applies edits,
blocks submission or approves completion.

Changed work, task requirements, source versions or access invalidate the packet;
obtain a new one before comparing. Identical assessments can reuse a current
receipt. Review packets are read-only; assessment receipts are stored separately
from deliverable revisions. These tools make no model calls and add no mandatory
review or scheduling behavior.

For an explicitly requested model review, use:

```text
task work 7 artifact-review-fresh {"questions":[{"id":"eligibility","path":"/items/0/value","answerType":"string","refs":["note:42","note:43"]}]}
```

An optional `model` property selects an upstream model ID; the default is
`marina/default`. Agent channels, instrument prefixes and tier aliases are refused
here because they can introduce context or additional model calls. Every question
needs an `answerType`. The request contains only
a new system instruction and the evidence packet, with no conversation history,
draft values, authored expectations, tools or memory enrichment. It uses the
instance's normal model routing, spend accounting and output allowance, and
reports the served model. The recorded native reviewer remains the requester;
fresh context does not prove unbiased questions, complete evidence or a different
author. Source access is the requester's access and is rechecked after inference.

The operation returns an assessment and never edits or approves. A changed draft,
requirement or source/access state during inference rejects the stale assessment.
Identical current requests reuse a receipt for up to one hour; concurrent
identical requests share a call. Provider failures, incomplete output and invalid
answers remain visible failures without a successful receipt or automatic retry.
No model is called by editing, showing, checking or submitting an artifact.

## Keeping handoffs consistent with the deliverable

`task work 7 handoff` returns a Markdown snapshot generated from the exact JSON
artifact, with its work revision and content hash. `handoff <revision>` renders a
historical revision under today's task access rules. No model rewrites the facts,
no source is newly published, and no work revision or check receipt is created.
The snapshot is an authored record at that revision, not a live view or evidence
that its sources and conclusions are still valid.

Use the artifact as the place to maintain current decisions and supporting
sources. Journal entries can record dated changes, rejected advice, owners and
next actions, and refer to the artifact for current values. Preserve old entries
as history. When discussing an earlier statement again, distinguish what was
true then from what is true now; a new permission or receipt may make the old
statement false, rather than merely less relevant. Correct current values do not
repair a contradictory present-tense sentence elsewhere in the handoff.

Clients can optionally use `publishTaskArtifactHandoffFile` from
`src/coordination/task-artifact-handoff.ts` to publish a named snapshot section in
a journal. Supply the current artifact revision/hash and journal version/hash.
It checks those tokens and uses the client's atomic file comparison before
writing. Only its explicitly selected section is replaced; surrounding authored
notes remain verbatim. Identical publication does not write or wake peers.
Historical sections can use distinct names. The helper does not check the truth
of surrounding prose or regenerate snapshots when later edits occur. Ordinary
journals, chat, file edits and task submission remain available.

Once a peer has supplied the needed evidence and the artifact is unchanged,
another identical check adds no new evidence. Reuse its receipt and act on the
remaining uncertainty. Reopen work for changed facts, an unresolved discrepancy,
or a substantive peer correction rather than another acknowledgment.

When a source is replaced, record the changed facts and the preserved facts
separately. A replacement document can reaffirm an earlier measurement or
decision. Reject advice by identifying the inference its evidence does not
support; a true premise can support a false recommendation. Check the premise
again before calling it obsolete. State whether an action is proposed, permitted,
pending, or evidenced as performed, and name the next owner only for unfinished work.

## Auditing every decision's supporting facts

`task work 7 artifact-evidence 12 <json_plan>` optionally binds an evidence audit
to the artifact. This reads the complete requirement list from an accessible
source instead of relying on the contributor to remember a rule for every field.
Each requirement names alternative sufficient bundles of facts. The contributor
maps those facts to exact source selections. For example:

```json
{
  "requirements": {"ref":"note:1","path":"/requirements","key":"/id","bundles":"/supporting_facts"},
  "context": {"source":"/phase","target":"/phase"},
  "targets": {"path":"/decisions","key":"/id","citations":"/citations","document":"/doc_id","quote":"/quote"},
  "sources": [{"ref":"note:2","document":"/doc_id","text":"/statements"}],
  "bindings": [{"fact":"eligibility-policy","ref":"note:2","path":"/statements/0"}]
}
```

Paths are JSON Pointers; requirement key/bundle paths are relative to each
requirement, and citation document/quote paths are relative to each citation.
The example contract's `supporting_facts` is an array of alternatives, such as
`[["eligibility-policy","actual-result"],["explicit-blocker"]`. Include all
original source references used by the selected decisions. Bind each fact to
a nonempty string in the selected source text. A complete source statement can
support several named facts, but the association is the contributor's judgment.

The audit checks every citation, including unnecessary extras, for an exact
substring of its named original source. It also reports the missing facts in
each allowed bundle for every required decision. A derived calculation needs
its own policy and premises; citations in another decision are not inherited.
Use source edits to copy exact text rather than retyping quotations. Invalid
extra citations remain findings even when a sufficient bundle is present.

Read, edit, check and submission feedback reruns this mechanical audit while the
plan is bound. Declaration records source versions: a reordered or changed source
cannot silently change a fact binding's meaning. Read the changed source and
explicitly renew the plan after checking its selections. Current source access
and versions affect check receipts. A peer
who cannot read a source gets unverified feedback, without its content. Explicit
context bindings detect a phase/type mismatch; update the plan for a new task
context. Read the current revision and plan before changing it, preserving
peers' useful mappings. Rebinding an identical plan does not create a revision.
`artifact-evidence <revision> null` explicitly removes the plan.

This is optional, makes no model calls, and never edits the deliverable or gates
submission. It cannot prove that a fact binding entails its label, that the
chosen contract is complete, or that an authentic old statement is still true.
Original-source reasoning and scrutiny of current prose remain necessary.

### Review the actual handoff prose

A correct artifact does not validate extra claims in a journal or next-owner instruction.
`task work 7 prose-review <json_review>` returns a packet for explicitly supplied text;
`prose-review-fresh` requests one fresh model assessment through the normal model route:

```json
{
  "target": { "name": "handoff.md", "content": "The actual current handoff text." },
  "reasoningEffort": "low",
  "refs": ["note:42", "note:43"],
  "model": "marina/default"
}
```

`reasoningEffort` is optional: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`, subject to the selected model's supported levels. Omit it to preserve the provider's
default; an explicit value is forwarded without changing the configured output allowance.
The effort is part of the packet/cache fingerprint. Reasoning and visible output may share
the response budget: choose an appropriate effort or set `MARINA_DEFAULT_MAX_TOKENS` for
more headroom. Truncated and timed-out responses remain failures, with no automatic retry.

The server does not read that name as a host or sandbox path. A file client can use
`reviewTaskProseFile` with its own authorized reader and the version/hash from its last
read. It sends the exact captured text and refuses a result if the file changes during
review. The assessment also binds task requirements, native work, reader access and
source versions; changes during inference invalidate it. Identical current requests reuse
an expiring receipt. No file is edited, peer awakened, or task approved.

This review sees the candidate prose and artifact as claims, plus only selected readable
originals. It is distinct from the answer-free artifact review. It asks for source-based
counterexamples, including incorrect prospective calculations, invented permission
limits, changed versus preserved facts and plans described as completed actions. Findings
must quote the actual target text; contradictions need exact current-source citations.
Unavailable evidence produces uncertainty, not permission to remove a valid quotation.
A `no-findings` result is an advisory observation, never proof of exhaustive coverage or
semantic truth. A model can still reason incorrectly; retain source-supported corrections
and reject unsupported review advice.

For a prospective claim, keep the starting state, proposed change, resulting state and
applicable scope distinct. Recompute each affected quantity from its source-defined
accounting instead of copying a current number into an “after” sentence. `calc` is an
optional native tool for arithmetic, for example `calc 19 - 5 - 6`. It does not choose the
correct operands or establish authority. Unused permission, remaining demand and physical
capacity are different quantities. A positive unused balance does not imply exhaustion.
Keep the handoff concise and refer to the actual artifact or exact snapshot when useful;
additional prose still needs support. All these tools remain optional.

Fresh prose review requests a strict JSON response schema for findings and limitations. The selected upstream route must support structured output; an unsupported, malformed or truncated reply fails without an automatic retry or unconstrained fallback. The schema constrains response format, not the truth of findings; exact quotation and live-source checks still apply.

`refs` is optional. The reviewer reads, by its own access, any source the caller lists, every reference the prose itself names (`note:N`, `task:N`, `chronicle:N`, `asset:<id>`), every source the task's work cites (citations, evidence bindings, rule selections) and the task itself, and it is given the task's recorded history (who did what at which revision, claims and submissions) as fact. A claim about a recorded event is therefore checkable whether or not the author listed the source; the report's `references` list says what was read, what could not be, and why each reference was in the packet.

The outcome is `findings` when a quoted claim is contradicted by a cited original, `unverified` when something was **not** checked — a source the reviewer could not read (listed in `unavailable`, with `unavailableReasons` saying why as far as is safe: `malformed` for a reference Marina does not resolve, `unavailable` for one that is missing, retired or not readable by you) or a claim it could not place — and `no-findings` otherwise. Limitations are requested on every run and ride along with any outcome; they do not make a review `unverified`. An unavailable source means its claims were not checked: publish a readable copy or pass a reference you can read, then review again. No outcome is approval.


Ordinary file workflows can use the same evidence audit without a native artifact copy:
`task work <id> artifact-audit {"target":{"name":"submission.json","content":"..."},"plan":{...}}`.
Supply the actual JSON file content and the explicit evidence plan described above. The command
checks current sources readable by the caller and returns the target hash, quotation checks and
missing per-entry fact bundles. It does not persist the candidate, infer fact mappings, edit the
file or approve the task. Each invocation explicitly selects its current source mappings.
The optional `auditTaskArtifactFile` adapter checks the authorized file version and hash before
and after this read-only command, so an assessment cannot silently refer to a different file.

For a handoff from an ordinary file, `publishTaskDeliverableHandoffFile` captures the selected
file directly into a named journal section. It checks task access, both file versions and
hashes, preserves surrounding notes and skips identical publication. No native artifact import
is needed. The snapshot names the observed file version and hash; it is historical evidence,
not a live view or a guarantee of atomic coherence between two files. Adapters remain responsible
for file authorization, canonical file identity (including aliases), and atomic journal
compare-and-write. Versions must change on all writes and path-identity changes, including
retargeting a symlink. The deliverable and journal must have distinct canonical identities. The existing native-revision snapshot adapter remains available.
