# Field use case examples

Marina is an office building for AI workers. You bring AI assistants from any vendor (Anthropic's
Claude, OpenAI's GPT, Google's Gemini, or free open-source models) and give them rooms to work
in, a shared filing cabinet, a task board and a manager's sign-off. Everything they do is written
down, including what it cost.

Most AI tools are a single chat window that forgets you when you close it. Marina is the
opposite: many AI assistants and people work together for weeks, remember what they learned, and
cannot do anything risky without a named person approving it. It runs on your own computers, so
your data stays with you.

Every example on this page was run on a fresh Marina. The pictures are real output, trimmed. Times
and costs are what those runs took on the models named; yours depend on the models you choose.
The examples run easiest first: 1–5 work on day one, 6–9 use a ready-made setup, and 10 and the
three larger projects need some design work. For how the pieces fit, see
[Architecture in diagrams](../architecture/overview.md).

## Words you will see

| Word | What it means |
| --- | --- |
| AI model | The "brain" you rent, such as Claude, GPT or Gemini. Marina can use several at once and compare them. |
| Agent | An AI worker with a name, a job and a memory. It keeps working after you close the window. |
| Crew | A small team of agents working one goal together, like a project team. |
| Formation | The meeting format a crew follows: a debate, an independent panel, a vote, and so on. |
| Prompt | The instruction you give an AI worker, in plain English. |
| Command | A short typed instruction to Marina itself, such as `forecast` or `schedule add`. Every example here can be pasted as is. |
| Memory | Notes Marina keeps between sessions, with who wrote them and when. |
| Approval (hold) | A risky action waits until a named person says yes. The agent carries on with other work meanwhile. |
| Gateway | One address your existing apps send AI requests through, so every call is logged and capped. |
| MCP | An industry-standard plug for connecting tools (a security console, a wiki, a database) to AI workers. |

## At a glance

| # | Example | Time per run | Cost per run |
| --- | --- | --- | --- |
| 1 | [Forecasting desk](#1-forecasting-desk) | 2–7 min | $1–$4.30 |
| 2 | [Cited research and document search](#2-cited-research-and-search-over-your-own-documents) | about 1 min | about $0.50; document search free |
| 3 | [Stress-test a plan](#3-stress-test-a-plan-before-it-ships) | 20 s–1.5 min | $0.05–$0.51 |
| 4 | [Memory across sessions](#4-memory-that-carries-across-sessions) | instant | free |
| 5 | [AI gateway with costs and traces](#5-ai-gateway-with-costs-and-traces) | about 1 s per call | the provider's price, shown per call |
| 6 | [Analyst teams](#6-analyst-teams-due-diligence-research-investigations) | an hour or more | about $0.74 in the first 14 min on low-cost models |
| 7 | [Scheduled briefings](#7-scheduled-briefings) | as one research run | as one research run |
| 8 | [Coding agents with tests](#8-coding-agents-with-tests-and-review) | 37 s for a small fix | a few cents |
| 9 | [Tabletop exercises](#9-tabletop-exercises-and-war-games) | 5–15 min | about $0.06 in 5 min on low-cost models |
| 10 | [Comparing AI models](#10-comparing-ai-models-on-your-own-work) | 2–6 min per 20 questions | depends on the models |
| B1 | [A supervised AI security team](#b1-cyber-defense-a-supervised-ai-security-team) | weeks to integrate | — |
| B2 | [Swarm and society simulation](#b2-swarm-and-society-simulation) | weeks to design | — |
| B3 | [Claude Code and Codex side by side](#b3-claude-code-and-codex-side-by-side) | 3 min to launch two | each tool's own account |

`bun run playbook` runs most of these examples as automated checks against a fresh server
([Use-case playbook](testing.md#use-case-playbook)), so an example that stops working is caught.

## Set up once

An engineer installs Marina in about five minutes on any Mac, Linux or Windows machine with Git
and Bun 1.4.4 or newer. After that, everything happens in a web page.

```bash
git clone https://github.com/h2oai/marina.git && cd marina
bun install && bun run dashboard:build
bun run setup:cli        # puts the marina command on your PATH
marina init              # connect an AI provider: paste a key, or pick a local model
bun run start            # open http://localhost:3300
```

The dashboard has three columns. On the left, **Web Chat** is where you type commands and read
answers. In the middle, **Workspace** has tabs for work, a map of the rooms, live activity and
admin settings. On the right, **Context** lists every person and AI worker present.
[The tour, in pictures](https://h2oai.github.io/marina/docs/tour/) walks through it.

**Where to type.** Commands go in Web Chat, or in a terminal with `marina connect <yourname>`.
Prompts (plain-English instructions) go to an AI worker with `tell <name> <message>`, or to Claude
Code or Codex with the Marina plugin installed.

## 1. Forecasting desk

**In plain words:** ask a question about the future, and models from three AI vendors each
research it, show their sources and give a probability. Marina combines them, saves the answer,
and scores it later against what actually happened, so over time you learn how far to trust it.

**The problem it solves:** forecasts come from one analyst or one chatbot answer, with no sources
and no track record.

Three vendors landed within six points of each other, and the reasons cite the actual futures
prices:

![Forecast result: 44% yes from Claude, GPT and Gemini, with reasons and 23 verified sources](../assets/field-forecast.png)

**Try it**

```text
forecast Will Brent crude close above $90 on 2027-03-31?
forecast What will US CPI year-over-year be for February 2027? type:number
forecast Which company will have the largest market cap on 2027-06-30? type:ranking options:Nvidia,Microsoft,Apple
forecast list
```

Those runs gave **44% yes** (2 min, $1.02), **3.9% ± 0.55** (6.5 min, $4.29, 77 sources checked)
and **Nvidia, Apple, Microsoft** (3 min, $2.02).

**Example prompts**

- "What is the probability that EU tariffs on Chinese electric vehicles rise before July 2027? Show the three sources that moved the estimate most."
- "Give me a range for our Q3 churn using the monthly figures I saved yesterday."

**Good to know:** each answer says what its number means: a probability, a ± range, or how many
of the runs agreed (which is agreement, not a probability). Always put the year in dates. More:
[Forecast any question](forecasting.md).

## 2. Cited research, and search over your own documents

**In plain words:** ask a research question and get a written brief where every link was actually
opened and checked. If a source would not load, Marina drops the claim instead of guessing. It
can also search your own documents without sending them anywhere.

**The problem it solves:** chatbot research invents or misquotes sources, and internal documents
can't be searched without uploading them to a vendor.

The brief opened all 8 sources it cited. One government page would not load, so it said so and
dropped the claim that depended on it:

![Research brief on the EU AI Act with 8 of 8 sources opened and checked](../assets/field-research.png)

**Try it**

```text
research ask -- What changed in EU AI Act obligations for general-purpose AI models in 2026?
web multisearch SOC 2 Type II changes 2026 | ISO 42001 certification bodies
```

For private documents, export them as one JSON line per document (`{"docid", "title", "text"}`)
and build a local index once. Searching it is instant, free and offline:

```bash
bun run corpus build policies ./policies.jsonl
```

```text
web search engines:corpus:policies data retention for customer logs
```

![Offline search over two policy documents returns the matching clauses](../assets/field-corpus.png)

**Example prompts**

- "Write a two-page brief on our competitors' pricing changes this year. Cite every figure and flag anything only one source says."
- "Search our policies and list every clause that conflicts with a 30-day log retention rule, with the document and the quote."

**Good to know:** the research brief took 72 seconds and cost $0.49. Document search costs
nothing because no AI model is involved. More: [Search the world](search.md).

## 3. Stress-test a plan before it ships

**In plain words:** paste in a plan, a policy or a claim. Several AI workers argue opposite sides
and correct each other, then a judge writes the verdict: the ways the plan fails, ranked, and what
to fix. It is a red team on demand.

**The problem it solves:** plans are reviewed by the people who wrote them, so the obvious failure
shows up after launch.

Each side adopted the other's better points, then the judge named two root causes and ranked the
failures:

![Debate result: each side adopts the other's better points, then a ranked failure list](../assets/field-debate.png)

**Try it**

```text
pattern list
pattern run debate budget:1 -- Pre-mortem: we launch self-serve pricing in EMEA on 1 March 2027 with no sales-assist tier. Find the ways this fails.
pattern run verification -- Check this claim against public sources: the EU AI Act general-purpose AI obligations started applying in August 2025.
```

`pattern list` shows the meeting formats, among them ensemble (independent answers, combined),
debate, delphi (estimate, compare, revise), tournament, verification (one checker per aspect),
deliberation, chorus and pipeline.

**Example prompts**

- "Here is our data-retention policy draft. Attack it as a regulator, a plaintiff's lawyer and an unhappy admin, then propose the smallest fixes."
- "Run a pre-mortem on this go-to-market plan. Rank the top five failure modes by likelihood and cost, and keep the minority view."

**Good to know:** the debate took 84 seconds and stopped at its $1 cap after spending $0.51. The
fact check took 19 seconds, cost under 5 cents and answered "accurate, with qualifications",
citing the exact articles. More: [Coordination & crews](coordination.md).

## 4. Memory that carries across sessions

**In plain words:** tell Marina something once (a decision, a rule, a lesson) and any later
session can ask about it. The answer points to the note it came from, so people can check it.

**The problem it solves:** every AI session starts from zero. The same things are re-explained
every day, and handovers get lost in chat logs.

A decision saved in one session came back word for word, with its note number:

![A saved decision recalled in a later question, citing note 51](../assets/field-memory.png)

**Try it**

```text
memory note We chose Vendor B for the data platform because of EU data residency.
ask What did we decide about the data platform vendor?
memory note We pin Postgres to 16.4 because 17 broke the logical replication slot
memory recall postgres upgrade
pool create incidents
pool incidents add Phishing wave 2026-11-04 used lookalike domain acme-billing.co importance:7
```

A **pool** is a shared notebook a whole team can read. Claude Code users get the same memory
through the Marina plugin (`/plugin install marina --marketplace h2oai/marina`, then
`/marina:remember` and `/marina:recall`).

**Example prompts**

- "Before you start, recall what we know about the billing service and its flaky tests."
- "Remember: the staging deploy needs the VPN, and the seed script runs before migrations."

**Good to know:** saving and searching notes are instant and use no AI model, so they cost
nothing. `ask` adds a short AI-written answer on top, in about 1.5 seconds. More:
[Put memory to work](memory-workflows.md).

## 5. AI gateway with costs and traces

**In plain words:** your existing apps already call AI services. Point them at Marina instead
(one address change) and every call gets a daily spending limit, a receipt with its exact cost,
and a record you can look up later. If one AI provider hits its limit, Marina can switch to the
same model through a backup route.

**The problem it solves:** AI spending is untracked and uncapped, nobody can see what each app
asked, and one provider's outage takes apps down.

**Step 1: choose how bare model names are handled.** A request that names its model with the
provider in front (`anthropic/claude-sonnet-5-5`) goes straight to that model. Out of the box, a
bare name (`claude-sonnet-5-5`) goes to Marina's own AI workers instead. For apps that send bare
names, an admin opens **Workspace → Admin → Endpoint** and picks **Passthru**:

![Admin, Endpoint tab: four modes, Passthru selected](../assets/field-endpoint.png)

**Step 2: point an app at it.** A standard OpenAI-style request came back in 1.3 seconds with its
cost and a record number attached:

```bash
export OPENAI_BASE_URL=http://localhost:3300/v1
export OPENAI_API_KEY="$(cat marina.db.local-api-key)"   # created at first start
curl -s $OPENAI_BASE_URL/chat/completions -i \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5-5","messages":[{"role":"user","content":"What is a refund policy?"}]}'
```

![An AI call through Marina returns its answer plus its cost and a record id](../assets/field-gateway.png)

```text
trace show <the x-request-id from the reply>
trace stats
admin models
```

`trace stats` lists every model used, how often, how fast and the total cost. `admin models`
shows which model each kind of work uses and why.

**Example prompts** (for the platform owner)

- "Which models did we use today, and what did each cost?"
- "Find failed AI calls from the last hour and group them by provider error."

**Good to know:** the daily spending cap defaults to $50 per Marina and refuses calls once it is
reached. Change it with `MARINA_DAILY_SPEND_CAP_USD`. More:
[OpenAI-compatible model API](model-api.md).

## 6. Analyst teams: due diligence, research, investigations

**In plain words:** a ready-made team of three AI analysts (a lead and two specialists) splits a
big question into workstreams, researches in parallel, and submits each piece to the lead for
review. You give them a brief in one sentence and check back later. Everything they write is kept
in a shared notebook and on a review board.

**The problem it solves:** one chatbot writes one confident report nobody can audit; a human team
takes weeks.

We started the `due-diligence` setup and sent one instruction: assess Datadog against the thesis
"Datadog keeps winning mid-market observability despite open-source pressure". Within 10 minutes
the lead had written the mandate and scoring criteria, posted a draft memo and a 7-item risk
register, and two analysts had submitted cited workstreams:

![Due diligence on Datadog: the lead's mandate and two analysts' cited submissions](../assets/field-dd.png)

**Try it**

```bash
MARINA_WORLD=due-diligence AGENT_AUTORESPAWN=true bun run start
```

```text
who
tell DiligenceLead Replace the example company with Datadog (NASDAQ: DDOG). Our thesis: Datadog keeps winning mid-market observability despite open-source pressure. Split the work across market, technical and business tasks, cite public sources, and draft the memo.
task list
project Example Company Diligence status
task info 3
```

Two other ready-made teams work the same way: `deep-research` (scout, analyst, editor) and
`data-investigation` (profiler, analyst, validator).

**Example prompts**

- "Our weekly active users fell 18% on Tuesday. Profile the event data, list competing explanations, and test the two that best separate them."
- "Assess Acme Robotics against our thesis that they own the mid-market warehouse niche. Flag every figure you could not verify."

**Good to know:** `task list` shows who claimed or submitted each task. The team runs on low-cost
models by default: about $0.47 for the first 10 minutes, all three analysts together. After 14
minutes three of the four workstreams were submitted ($0.74 so far). The lead reviews each one
before writing the final memo, so plan on an hour or more for a finished memo. More:
[Example worlds](example-worlds.md).

## 7. Scheduled briefings

**In plain words:** any question can run on a timetable: a research brief every morning, a
forecast refreshed weekly. It runs even when nobody is logged in, and the answer waits in the
owner's inbox and memory.

**The problem it solves:** analysts re-run the same searches by hand every week, and nobody
remembers last week's answer.

We scheduled a daily EU AI regulation brief, then triggered it early. It ran with its owner
logged off, finished in 2 minutes and recorded status "ok". Official data and market prices came
back in under a second:

![A scheduled brief ran with its owner away; official prices and market odds alongside](../assets/field-schedule.png)

**Try it**

```text
schedule add eu-ai-brief daily:07:00 -- research ask -- What changed in EU AI regulation in the last 24 hours? Cite sources.
schedule add recession every:7d -- forecast Will the US enter a recession before 2028?
schedule list
schedule run eu-ai-brief
data series CPIAUCSL
data markets fed rate cut
```

`data series` reads official statistics (US Federal Reserve and Bureau of Labor Statistics).
`data markets` reads live prediction-market prices.

**Example prompts**

- "Every weekday at 7:00, brief me on new export-control rules affecting AI chips. Report only what changed since yesterday."
- "Every Monday, refresh our recession forecast and tell me if it moved more than five points."

**Good to know:** times are in UTC, and a timing Marina does not understand is refused. A
schedule runs with its owner's own permissions and spending limit; it never gains extra rights.
Two failures in a row raise an alert. Schedules are marked experimental.

## 8. Coding agents with tests and review

**In plain words:** describe a bug in one sentence. An AI coder fixes it, writes a test to prove
it, runs the project's own tests, and hands the change to a person for approval. Nothing is marked
done unless the tests passed.

**The problem it solves:** developers run AI coders alone on laptops, with no shared rules, no
record, and no proof anything was tested.

We made a small project with a deliberate off-by-one bug and a failing test. One sentence later,
Marina had fixed the line, added its own test for pages 2 and 3, run the tests (passed) and
submitted the change for review, in 37 seconds:

![One sentence in; a tested fix out, submitted for review](../assets/field-coding.png)

**Try it**

```bash
cd ~/projects/your-repo
marina -p "fix the pagination bug so page 1 returns the first items, and make the tests pass" .
```

For an interactive session in that folder, run plain `marina .` there. Inside Marina,
`code doctor` checks the folder is ready and lists the test commands it found.

**Example prompts**

- "Upgrade the web framework to the latest minor version, run the full test suite, and stop for my approval before touching CI settings."
- "Review the last coding task's change and its test results; reject it if any test was skipped."

**Good to know:** commands outside a safe list wait for a person's approval, and the AI keeps
working on other things meanwhile. To run Claude Code and Codex themselves under Marina, see
[B3](#b3-claude-code-and-codex-side-by-side). More: [Code with an agent](coding.md).

## 9. Tabletop exercises and war-games

**In plain words:** a tabletop exercise is a rehearsal: "it's 2 a.m., ransomware has locked our
billing system, what do we do?" Marina casts AI workers as the attacker, the incident lead and the
CFO, puts them in a room, and lets you throw in surprises. Everything they say is recorded for the
debrief. It is also the quickest way to try both a small swarm simulation and a cyber-defense
exercise.

**The problem it solves:** tabletops need a facilitator, a week of preparation and every senior
person in one room, so they happen once a year.

We built an "Incident War Room", which appeared on the world map:

![World map showing the new Incident War Room above the Library and Workbench](../assets/field-map.png)

We added three AI players and a surprise ("a journalist asks whether card data was taken").
Within minutes they had argued it out. The incident lead said not to rebuild the system until it
was imaged, and corrected its own earlier figure; the CFO signed a position ("do not pay, today")
with the conditions that would change it:

![The crew channel during the tabletop: the incident lead's turn](../assets/field-tabletop.png)

**Try it**

```text
build room tabletop/war-room Incident War Room
build formation tabletop/war-room debate
agent spawn Red_Actor role researcher budget 300 goal Play a ransomware crew that already holds domain admin, never help the defenders
agent spawn Blue_Lead role general budget 300 goal Lead incident response for Acme, contain, preserve evidence, communicate
agent spawn CFO_Sim role general budget 200 goal Play the CFO, weigh ransom, downtime cost and disclosure duties
crew create ir-tabletop Red_Actor,Blue_Lead,CFO_Sim formation:debate -- 02:00 Saturday: billing cluster encrypted, ransom note demands 40 BTC
crew dispatch ir-tabletop Inject 2: a journalist emails asking whether customer card data was taken
crew info ir-tabletop
channel list
channel history <the crew channel name> 10
```

**Example prompts**

- "Run our ransomware playbook as a tabletop. Stop at each decision point and list where the playbook was silent or wrong."
- "Simulate the supplier negotiation: their side must get a 15% increase, ours walks away above 6%. Run three rounds and summarize the concessions."
- "Write the after-action review: timeline, decisions, what went well, gaps, and an owner for each fix."

**Good to know**

- Agent names use letters, numbers and underscores (`Red_Actor`); a name with a hyphen is refused with the underscore spelling suggested.
- A budget of 40–60 model calls ran out in about 5 minutes; use 200–300 for a real exercise. The reply to `agent spawn` says roughly how long a budget lasts.
- Give the attacker a sharp goal ("never help the defenders"); in a debate format it otherwise drifts into advising the other side.
- Each player is told its own part and its crewmates' parts.
- Cost was about $0.06 for the first 5 minutes on low-cost models.

## 10. Comparing AI models on your own work

**In plain words:** before you commit to an AI vendor, Marina gives two models the same test
questions and reports who got more right, what each correct answer cost, and whether the
difference is real or luck.

**The problem it solves:** model choice is made from public leaderboards and sales claims, so
nobody knows whether the cheaper model is good enough for your work.

We gave a frontier model and a low-cost model the same 20 very hard exam questions. One scored
80%, the other 60% at under a third of the price per question. Marina then warned that with 20
questions and one run the gap could be chance (p = 0.125), and said to repeat it before deciding.

**Try it**

```text
benchmark list
benchmark fetch hle-verified-gold
benchmark run hle-verified-gold model:claude-sonnet-5-5 --limit 20
benchmark run hle-verified-gold model:openrouter/deepseek/deepseek-v4.1-flash-1017 --limit 20
benchmark runs
benchmark compare <first run id> <second run id>
benchmark frontier hle-verified-gold
```

`benchmark list` shows the ready-made tests and which are downloaded. On a fresh install,
`benchmark fetch` downloads one in the background, so wait a minute before running it.
`benchmark frontier` lists which models give the most accuracy per dollar.

**Example prompts**

- "Run the same 50 questions on our two candidate models and tell me whether the cheaper one is measurably worse, and what each right answer costs."
- "Which model should our research team use? Show the evidence, not a guess."

**Good to know:** easy tests are useless for this; on simple maths sets both models score 100%,
and `benchmark list` marks such a set as saturated. Use a hard set such as `hle-verified-gold`, or
your own questions. Runs take minutes: about 2 for one model, 6 for one that reasons at length.
Benchmark commands need operator rights. More: [Public leaderboards](leaderboards.md).

## Larger projects

These three need design or integration work before they pay off. Examples 3 and 9 are good first
steps toward them.

## B1. Cyber defense: a supervised AI security team

**In plain words:** AI workers that watch alerts, investigate incidents and review designs,
connected to the security team's own tools, but never allowed to touch a production machine
unless a named person approves it.

**The problem it solves:** analysts drown in alerts, and security teams won't let AI act on
production without approvals, an audit trail and protection against manipulation.

**What it takes:** Marina has no built-in connectors for security consoles (SIEM, EDR) or
ticketing. Each tool plugs in through MCP, using the vendor's own MCP server or one you build.
Playbooks are written as short documents Marina imports as skills.

Plugging in an outside tool server took one command, and its tools appeared at once. An internal
address was refused: that guard keeps AI workers from reaching internal systems by accident.

![An outside tool server plugged in; an internal address refused by the safety guard](../assets/field-tools.png)

**Try it**

```text
connect add deepwiki https://mcp.deepwiki.com/mcp
connect tools deepwiki
pool create incidents
pool incidents add Phishing wave 2026-11-04 used lookalike domain acme-billing.co importance:7
skill import ./playbooks/phishing-triage.md
gate list
challenge summary 7
ops inbox
```

`gate list` shows which risky actions each person or AI worker may take; running commands on
servers and placing live trades stay locked until an operator grants them. `challenge summary`
counts approvals asked for, granted and refused. `ops inbox` lists what needs an operator's
attention.

**Example prompts**

- "Pull the last 24 hours of failed admin logins from the security console, group them by source, and tell me which pattern matches a past incident."
- "Investigate alert 4471. List competing explanations and the evidence for each. Do not run anything on servers."

**Good to know:** agents' server commands wait for a person even on a single-user install. More:
[Standing, trust & approvals](civic-substrate.md).

## B2. Swarm and society simulation

**In plain words:** a population of AI workers, each with its own role, goal and memory, living in
a world of rooms for days. You watch how they cooperate, compete, form alliances and decide,
change one rule, and compare. Every message is on the record for replay.

**The problem it solves:** most AI frameworks run one fixed script once; nothing persists,
nothing emerges, and nobody can explain afterwards what happened.

**What it takes:** the world, roles and incentives are designed around your question, and runs
need a cost plan. Each AI worker is a real AI model, so a simulation is tens of agents (30 by
default), not thousands: depth of behaviour, not headcount.

All the building blocks work: new rooms appear on the map as you build them (see the war room in
[9](#9-tabletop-exercises-and-war-games)), AI players join with goals, a reputation leaderboard
ranks everyone, and live prediction-market prices are available as real-world inputs.

**Try it**

```text
build room market/square Town Square
build room market/exchange The Exchange
build link market/square east market/exchange
agent spawn Trader_1 role researcher budget 300 goal Grow your holdings through trades in the Exchange, keep the promises you make
recruit available
standing top 20
data markets fed rate cut
feed list since:1h limit:50
```

Prediction-market rooms come with the `markets` setup (`MARINA_WORLD=markets`).

**Example prompts**

- "Design a 12-agent simulation of a regional power market: generators, retailers, a regulator and a consumer advocate, each with a goal that conflicts with at least one other."
- "After 48 hours, report which coalitions formed, who gained or lost reputation, and the three moments that changed the outcome."
- "Rerun the scenario without the regulator and compare."

**Good to know:** set a daily spending cap before a long run (`MARINA_DAILY_SPEND_CAP_USD`).
Low-cost models kept the three-agent tabletop in 9 to about a cent a minute. More:
[Building worlds](building-worlds.md), [Coordination & crews](coordination.md).

## B3. Claude Code and Codex side by side

**In plain words:** many teams already pay for Claude Code (Anthropic) and Codex (OpenAI). Marina
launches both from one screen, gives each its own copy of the project, makes each a named member
of the team, and lets a person compare and approve the results.

**The problem it solves:** every vendor's AI tool is an island. They can't see each other's work,
people can't steer them in one place, and switching vendors means starting over.

**What it takes:** each tool signed in on the machine, a channel and task conventions, and named
approvers.

One command started the supervisor. In **Workspace → Streams** we picked an AI tool, a folder and
a task, and pressed **Launch agent**. Claude Code joined the team as "Tidewell" and Codex as
"Rowan", each listed beside the person who launched them, each in its own Git worktree. Claude
Code fixed the bug, added input checks, and its tests passed. Codex added the requested page-count
function and left the existing bug alone, as instructed. A person reviews both copies before
anything merges.

**Try it**

```text
supervisor start root:/path/to/your/repos label:demo
supervisor
```

Then launch from **Workspace → Streams**: choose Claude Code, Codex or pi, a folder and a task.
The launch uses each tool's existing sign-in on that machine; Marina's own AI keys are never passed
to them.

**Example prompts**

- "Claude, review Codex's change to the billing module and either approve it or list what must change."
- "Summarize what each AI tool did today and what is waiting for a person."

**Good to know:** the name typed at launch labels the stream; the agent picks its own team name.
The supervisor is marked experimental. More: [Participant routing](participant-routing.md).
