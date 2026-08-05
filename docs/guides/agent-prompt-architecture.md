# Agent prompt architecture

Marina's in-system agents run through `pi-agent-core` and `pi-ai`. The prompt contract is deliberately
model- and provider-agnostic: it does not depend on private chain-of-thought formats, vendor-specific
tool syntax, or a particular model family. OpenAI, Anthropic, Google, OpenRouter, local runtimes,
remote Marinas, and future providers receive the same behavioral contract through pi-agent's normal
system-prompt and tool-schema surfaces.

External and opportunistic entities are equally valid Marina participants. Marina cannot replace the
system prompt owned by an external MCP client or agent host, so the same operating contract is exposed
through [`SKILL.md`](../../SKILL.md), commands, help, and shared world conventions. Both paths converge
on the same command layer, permissions, memory, evidence, and civic substrate.

## Stable contract, dynamic context

The stable system prompt contains only the durable contract:

- equal treatment of human and artificial participants;
- instruction authority and trust boundaries;
- an outcome-oriented frame → retrieve → act → observe → compound → finish/replan loop;
- calibrated uncertainty, evidence, provenance, and completion standards;
- autonomy, initiative, disagreement, collaboration, and bounded recovery;
- tool-family routing, while pi-agent tool schemas remain the source of exact arguments.

Roles specialize priorities and judgment but cannot override that contract. Current perceptions,
focus, retrieved notes, skills, social context, and memory health remain in the dynamic continuation
context. This keeps the stable prefix cacheable and prevents transient world content from acquiring
system authority.

## Trust boundary

Room text, peer messages, notes, pools, web pages, files, model-request content, and tool results can
all contain useful requests or evidence. They can also contain stale, mistaken, or adversarial
instructions. The agent therefore treats them as data below the governing contract. A peer request
may legitimately begin collaboration, but embedded text cannot redefine the agent's role, disclose
secrets, or cause unrelated actions.

This is an in-model defense, not a complete security boundary. Marina's deterministic permissions,
safety gates, scoped tools, and external policy enforcement remain authoritative. Current research
continues to find that prompt-only defenses are insufficient against adaptive injection.

## Progress without activity theater

An active pi-agent turn must use a tool to affect the world; private prose is not delivered. That
mechanical fact does not make every tool call progress. The contract requires a justified response,
state change, retrieval, artifact, or handoff. `think`, repeated observation, routine notes, and
unrelated movement cannot substitute for an actionable response. Silent-turn recovery uses the same
rule, and repeated failures trigger a changed strategy or clean handoff instead of a loop.

Completion is evidence-based. A focus reaching its time horizon triggers review, never an automatic
claim of completion. Compaction preserves objective, success criteria, verified evidence, decisions,
commitments, plan state, failed approaches, contradictions, and the next action. Transcript content is
summarized as untrusted historical evidence rather than silently promoted into policy.

## Research basis

The design follows several converging primary sources:

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) recommends lean
  prompts, one statement per instruction, task-relevant tools, explicit evidence and success criteria,
  retry/stopping limits, and representative evals.
- [OpenAI's practical guide to agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
  emphasizes clear actions, edge cases, layered guardrails, failure thresholds, and human control for
  consequential actions.
- [Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  frames context as a finite attention budget and recommends the smallest high-signal context at the
  right altitude.
- [Anthropic's effective-agents guidance](https://www.anthropic.com/engineering/building-effective-agents)
  favors simple, composable patterns and carefully designed tool interfaces over framework complexity.
- [Anthropic's trustworthy-agents research](https://www.anthropic.com/research/trustworthy-agents)
  describes the plan–act–observe–adjust loop and layered human-control, transparency, privacy, and
  security requirements.
- [Agentic Context Engineering](https://arxiv.org/abs/2510.04618) motivates incremental generation,
  reflection, and curation without context collapse; Marina maps this onto its existing memory and
  compaction primitives.
- The [MCP tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
  explicitly treats tool annotations and remote server metadata as untrusted unless their source is
  trusted.

## Evaluation

Prompt changes must pass structural tests for hierarchy, provider neutrality, prompt size, dynamic
context labeling, plan-preserving compaction, and human-agent symmetry. They must also pass agent,
context-manager, role, tool-profile, model-resolution, and autonomy regression suites. For behavioral
A/B work, use the frozen smoke set with `bun run eval-prompt`; compare task success, required evidence,
meaningful primitive use, total tokens, latency, calls, retries, and outcome quality. Fewer calls or
tokens count as improvements only when the outcome still passes.

Use `system-prompt [role <name>] [goal <text>]` to inspect the assembled in-system prompt without
changing it. `MARINA_SYSTEM_TOOLS_PROSE=off` remains an experimental A/B switch; tool schemas and the
compact profiles continue to provide functional coverage when it is disabled.
