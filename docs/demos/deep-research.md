# Deep Research Loop Demo

A long investigation needs background in memory, evidence gathered on demand, a check that
repeats on its own, and a way to read everything back. This walkthrough builds that loop on a
fresh default world. Seeding, retrieval, web evidence and schedules work without a provider
key. Steps marked **(provider)** need one (**Admin → Keys**). `dig` and `web search` need
network access.

## 1. Seed background from outside

Any script can feed the world through `marina connect`, one command per line. Use the name you
will log in with, since notes belong to the account that writes them:

```bash
printf '%s\n' \
  'memory note NOAA watches a North Pacific marine heatwave !7' \
  'memory note Marine heatwaves stress kelp forests and salmon runs' \
  'memory remember Coastal fisheries in the North Pacific are the first industry exposed to marine heatwaves' \
  | marina connect driver
```

```text
Note #45 saved (importance=7).
Note #47 saved. Auto-linked to notes #45 (related_to).
Memory service — space 79b7b28d-…
{ "id": "5f9be7fd-…", "version": 1, "seq": 30 }
```

`memory note` writes a numbered note. `memory remember` writes a plain durable record and
returns its id. `share <pool> <text>` puts a finding where other members can read it. An HTTP
client uses the memory service at `/v1/memory` with a scoped credential; see
[memory service](../guides/memory-service.md). The older `/mem/notes` endpoint is deprecated.

Check what is stored, without a model:

```text
> recall marine heatwave
  #45 3.13 !7 today NOAA watches a North Pacific marine heatwave
  #47 3.01 !5 today Marine heatwaves stress kelp forests and salmon runs

> memory retrieve marine heatwave exposure
Evidence: 3 items. Sufficiency remains for you to assess.
[record 8ed696a3-… v1] NOAA watches a North Pacific marine heatwave
[record 3b98d1de-… v1] Marine heatwaves stress kelp forests and salmon runs
[record 5f9be7fd-… v1] Coastal fisheries in the North Pacific are the first industry exposed to marine heatwaves
```

## 2. Start the investigation

```text
> usecase research north pacific marine heatwave forecast
Use case launched: research
  Project: research: north pacific marine heatwave forecast
  Tasks: 4 created (#5–#8)
  Pool: usecase:research: north pacific marine heatwave forecast
  Agents: none (no model provider configured)
```

This creates the project, pool, board and tasks described in
[research coordination](coordination-research.md). **(provider)** It also spawns a researcher
that works the tasks in order: Survey existing knowledge → Identify key questions → Deep
investigation → Synthesize findings.

## 3. Dig into specific questions

`recap` only retrieves. `dig` adds web evidence and, with a provider, a synthesis. Neither
writes notes, so record what you learn yourself.

```text
> recap marine heatwave
Your Notes
  #45 NOAA watches a North Pacific marine heatwave
  #47 Marine heatwaves stress kelp forests and salmon runs
Shared Pools
  #51 [usecase:research: north pacific marine heatwave forecast] Research topic: …
World Search
  [task:open] research: north pacific marine heatwave forecast
  [task:open] Survey existing knowledge
  …

> dig marine heatwave coastal industry exposure
Your Notes
  #45 NOAA watches a North Pacific marine heatwave
  #47 Marine heatwaves stress kelp forests and salmon runs
Web Evidence
  Marine Heatwaves : NOAA Physical Sciences Laboratory
    https://psl.noaa.gov/marine-heatwaves/
  …
No synthesis — Model request failed (HTTP 503): No upstream LLM providers configured. …
Write what you learned: `note <observation>` or `share <pool> <finding>`.

> memory note Salmon returns fell during the 2025 event !7
Note #57 saved (importance=7). Auto-linked to notes #47 (related_to).
```

`ask <question>` answers from notes, pools and world search. Without a provider it lists what
matched (`No model provider — answering from notes only`). **(provider)** With one, `ask`
writes an answer and `dig` adds its synthesis.

## 4. Keep a check running

A schedule runs one of your own commands on a repeat, with your own rank and gates:

```text
> schedule add heatwave-recap every:1d -- recap marine heatwave
schedule heatwave-recap: every 1d; next run 2026-11-05T19:06Z (in 1d). Runs "recap marine heatwave" as driver.

> schedule run heatwave-recap
schedule heatwave-recap: runs at the next pass (within ~10 s).

> schedule show heatwave-recap
schedule heatwave-recap — on; every 1d; last ok 0s ago
  command: recap marine heatwave
  2026-11-04T19:07:03.054Z  ok  3ms
```

For a market question, `watch create resolving venue:kalshi ticker:<id> cadence:1h` records
whether the market has resolved. `probe` with no arguments lists the resolver kinds.
**(provider)** Steer a running agent with `agent attention <name> <message>`.

## 5. Read it back

```text
> brief full
── Recent Notes ──
  • #57 [observation] Salmon returns fell during the 2025 event (just now)
  • #47 [observation] Marine heatwaves stress kelp forests and salmon runs (just now)
── Projects ──
  • research: north pacific marine heatwave forecast [research]: Deep research investigation …
── Staffing ──
  • research: north pacific marine heatwave forecast [research] 4 open, 1 members
```

Export the world state for later replay. From the checkout root, pass the world database and
an output file. The export is a private JSON file, and credentials are left out unless you
pass `--include-secrets`:

```bash
./scripts/export.sh marina.db deep-research.json
```
