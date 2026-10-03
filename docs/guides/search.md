# Search: open, date-bounded, and as a room

Marina searches the web through pluggable providers (`src/engine/search-providers/`). Everything
on this page works with **no API keys**.

## Open search

```
web search transformer architectures        DuckDuckGo + academic engines, intent-routed
web search engines:news,academic <query>    pick engine categories
web fetch https://example.com/page          readable text of a page
```

Tavily (`TAVILY_API_KEY`) and SearXNG (`SEARXNG_URL`) take over the web category when configured.

## Searching as of a date

Add `before:<date>` (alias `asof:`) and only **date-strict** providers answer. A bare
`YYYY-MM-DD` means the start of that UTC day; give an ISO time for an exact instant.

```
web search before:2026-09-30 senate polls          news, encyclopedia, HN, arXiv up to then
web search before:2026-09-30 engines:gdelt,hn <q>  name providers directly
web fetch https://example.com/page asof:2026-09-30 the page as archived at or before then
```

A bounded search never falls back to an unfiltered engine. The orchestrator also re-checks every
result: anything undated, or dated after the bound, is dropped.

| Provider | What it searches | How the bound is enforced |
|---|---|---|
| `gdelt` | worldwide news (GDELT DOC 2.0) | `startdatetime`/`enddatetime` server-side; each article's first-seen date re-checked. Covers roughly the last three months. Titles and dates only. |
| `wikipedia` | encyclopedia articles | Today's index nominates titles; the text is each article's revision at the bound (`rvstart`, `rvdir=older`). Articles created later are dropped. Results link to the `oldid` permalink. |
| `hn` | Hacker News stories (Algolia) | `created_at_i` window server-side; re-checked. |
| `arxiv` | preprints by submission date | `submittedDate:[… TO …]` in the query; entries first published, or last updated, after the bound are dropped. |
| `wayback` | a URL, not a search | Internet Archive CDX `to=<bound>` picks the latest capture at or before it (the timestamp is re-checked), then reads the `id_` replay. |

Residual effects to keep in mind:
- Wikipedia's search ranking is today's.
- HN points are current.
- GDELT only reaches back a few months.

None of these lets post-bound text into a result.

## Date-strict research for forecasts

The research retriever (`MARINA_FORECAST_RETRIEVER`, `MARINA_ARENA_RESEARCH_RETRIEVER`) accepts
`asof[:<providers>]`, for example `asof:gdelt,wikipedia,hn,arxiv,wayback`, or bare `asof` for all
of them.

- **Bound:** each research round is bounded to the forecast's cutoff instant.
- **News text:** news hits are read from their Wayback capture at or before the cutoff, and that
  capture is the cited URL, so the citation check reads the same as-of text.
- **Backtests:** call `retrieverFromSpec(spec, keys, { requireDateStrict: true })` to refuse any
  spec that mixes in an unfiltered engine. `isDateStrictSpec(spec)` answers the question without
  building the retriever.

## The search room

The search tool is a set of room commands, so it exists only for entities standing in that room:
local and scoped by construction.

- **Default world:** the Workbench **Library** carries it.
- **Showcase world:** the **Research Lab** carries it.
- **Verbs:** there they avoid shadowing the global `search` command:

```
find <query> [before:<date>] [engine:<name|category>] [limit:N]
archive <url> asof:<date>       the page as archived at or before the date
wiki <title> [asof:<date>]      the article's revision as of the date
sources                         engines, and how each enforces a date bound
```

A world can also add a dedicated room, `searchRoom({ exits })`, whose verbs are `search`, `fetch`,
`wiki` and `sources`. To mount the tool on any existing room under verbs of your choosing, use
`searchToolCommands({ verbs })`. Both are in `src/world/rooms/search-room.ts`.

- **Caching:** replies are cached in the room's KV store per (engine, query, bound) for six hours.
- **Rate limit:** each entity is limited to one query every few seconds.
- **Tracing:** commands run through the normal command path, so they are recorded and traced like
  any other action.

## Building your own tool rooms

A room is a natural home for a tool: its commands, KV state and room agents are scoped to the room.

- **Write a room** with `build` (agents, behind the `world.code` gate). Its commands can call
  `ctx.httpGet` or any provider here, and keep state in `ctx.store`.
- **Wrap an MCP search server** with `connect add …` (mcporter). Calls look like
  `connect call <server> <tool> <json>`, and a room command or a `macro` can wrap that as a short
  verb. Stdio connectors need `shell.exec`.
