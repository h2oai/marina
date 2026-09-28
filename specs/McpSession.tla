---------------------------- MODULE McpSession ----------------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC

(* Finite abstraction of mcp-admission.ts and cmdTool's commandTail chain.
   A started handler can commit even after cancellation or identity withdrawal.
   Optional context delivery rechecks identity. See README.md for correspondence. *)
CONSTANTS Sessions, RequestCount, GlobalLimit, SessionLimit,
          EarlyRelease, SkipIdentity, SkipFifo, SkipCancellation
Requests == Sessions \X (1..RequestCount)
VARIABLES phase, queue, reserved, cancelled, expired, epoch, bound,
          started, safeStart, commits, safeDelivery, delivered, accepting
vars == <<phase, queue, reserved, cancelled, expired, epoch, bound,
          started, safeStart, commits, safeDelivery, delivered, accepting>>
Active(s) == {r \in Requests : r[1] = s /\ phase[r] \in {"queued", "running"}}
Running(s) == {r \in Requests : r[1] = s /\ phase[r] = "running"}
Remove(q, r) == SelectSeq(q, LAMBDA x: x # r)
Eligible(r) == r \notin cancelled /\ r \notin expired /\ bound[r] = epoch[r[1]]

Init == /\ phase = [r \in Requests |-> "new"]
        /\ queue = [s \in Sessions |-> <<>>]
        /\ reserved = {}
        /\ cancelled = {} /\ expired = {}
        /\ epoch = [s \in Sessions |-> 0]
        /\ bound = [r \in Requests |-> 0]
        /\ started = [s \in Sessions |-> <<>>]
        /\ safeStart = [r \in Requests |-> TRUE]
        /\ commits = [r \in Requests |-> 0]
        /\ safeDelivery = [r \in Requests |-> TRUE]
        /\ delivered = {} /\ accepting = TRUE

Admit(r) ==
  /\ accepting /\ phase[r] = "new"
  /\ \A i \in 1..(r[2]-1): phase[<<r[1], i>>] # "new"
  /\ Cardinality(reserved) < GlobalLimit
  /\ Cardinality(Active(r[1])) < SessionLimit
  /\ phase' = [phase EXCEPT ![r] = "queued"]
  /\ queue' = [queue EXCEPT ![r[1]] = Append(@, r)]
  /\ reserved' = reserved \cup {r}
  /\ bound' = [bound EXCEPT ![r] = epoch[r[1]]]
  /\ UNCHANGED <<cancelled, expired, epoch, started, safeStart, commits,
                  safeDelivery, delivered, accepting>>

Start(r) ==
  /\ phase[r] = "queued" /\ Running(r[1]) = {}
  /\ (SkipFifo \/ Head(queue[r[1]]) = r)
  /\ (SkipIdentity \/ bound[r] = epoch[r[1]])
  /\ (SkipCancellation \/ r \notin cancelled) /\ r \notin expired
  /\ phase' = [phase EXCEPT ![r] = "running"]
  /\ started' = [started EXCEPT ![r[1]] = Append(@, r[2])]
  /\ safeStart' = [safeStart EXCEPT ![r] = Eligible(r)]
  /\ UNCHANGED <<queue, reserved, cancelled, expired, epoch, bound, commits,
                  safeDelivery, delivered, accepting>>

Skip(r) ==
  /\ phase[r] = "queued" /\ Head(queue[r[1]]) = r /\ ~Eligible(r)
  /\ phase' = [phase EXCEPT ![r] = "skipped"]
  /\ queue' = [queue EXCEPT ![r[1]] = Tail(@)]
  /\ reserved' = reserved \ {r}
  /\ UNCHANGED <<cancelled, expired, epoch, bound, started, safeStart, commits,
                  safeDelivery, delivered, accepting>>

Finish(r) ==
  /\ phase[r] = "running"
  /\ phase' = [phase EXCEPT ![r] = "finished"]
  /\ queue' = [queue EXCEPT ![r[1]] = Remove(@, r)]
  /\ reserved' = reserved \ {r}
  /\ commits' = [commits EXCEPT ![r] = @ + 1]
  /\ UNCHANGED <<cancelled, expired, epoch, bound, started, safeStart,
                  safeDelivery, delivered, accepting>>

Cancel(r) ==
  /\ phase[r] \in {"queued", "running"} /\ r \notin cancelled
  /\ cancelled' = cancelled \cup {r}
  /\ reserved' = IF EarlyRelease /\ phase[r] = "running" THEN reserved \ {r} ELSE reserved
  /\ UNCHANGED <<phase, queue, expired, epoch, bound, started, safeStart, commits,
                  safeDelivery, delivered, accepting>>

Expire(r) ==
  /\ phase[r] = "queued" /\ r \notin expired
  /\ expired' = expired \cup {r}
  /\ UNCHANGED <<phase, queue, reserved, cancelled, epoch, bound, started,
                  safeStart, commits, safeDelivery, delivered, accepting>>

Rebind(s) ==
  /\ epoch[s] = 0 /\ epoch' = [epoch EXCEPT ![s] = 1]
  /\ UNCHANGED <<phase, queue, reserved, cancelled, expired, bound, started,
                  safeStart, commits, safeDelivery, delivered, accepting>>

Deliver(r) ==
  /\ phase[r] = "finished" /\ r \notin delivered /\ r \notin cancelled
  /\ bound[r] = epoch[r[1]]
  /\ delivered' = delivered \cup {r}
  /\ safeDelivery' = [safeDelivery EXCEPT ![r] = (bound[r] = epoch[r[1]])]
  /\ UNCHANGED <<phase, queue, reserved, cancelled, expired, epoch, bound,
                  started, safeStart, commits, accepting>>

StopAdmission ==
  /\ accepting /\ accepting' = FALSE
  /\ UNCHANGED <<phase, queue, reserved, cancelled, expired, epoch, bound,
                  started, safeStart, commits, safeDelivery, delivered>>

Next == (\E r \in Requests: Admit(r) \/ Start(r) \/ Skip(r) \/ Finish(r)
                           \/ Cancel(r) \/ Expire(r) \/ Deliver(r))
        \/ (\E s \in Sessions: Rebind(s)) \/ StopAdmission
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in [Requests -> {"new", "queued", "running", "finished", "skipped"}]
          /\ reserved \subseteq Requests /\ cancelled \subseteq Requests
          /\ expired \subseteq Requests /\ delivered \subseteq Requests
          /\ epoch \in [Sessions -> 0..1] /\ bound \in [Requests -> 0..1]
          /\ commits \in [Requests -> 0..1]
          /\ started \in [Sessions -> Seq(1..RequestCount)]
          /\ queue \in [Sessions -> Seq(Requests)]
          /\ safeStart \in [Requests -> BOOLEAN] /\ safeDelivery \in [Requests -> BOOLEAN]
          /\ accepting \in BOOLEAN
Capacity == /\ Cardinality(reserved) <= GlobalLimit
            /\ \A s \in Sessions: Cardinality(Active(s)) <= SessionLimit
SlotsOwned == reserved = {r \in Requests: phase[r] \in {"queued", "running"}}
Serial == \A s \in Sessions: Cardinality(Running(s)) <= 1
FIFO == \A s \in Sessions: \A i, j \in 1..Len(started[s]):
          i < j => started[s][i] < started[s][j]
AuthorizedStart == \A r \in Requests: safeStart[r]
AuthorizedDelivery == \A r \in Requests: safeDelivery[r]
SkippedNeverCommits == \A r \in Requests: phase[r] = "skipped" => commits[r] = 0
=============================================================================
