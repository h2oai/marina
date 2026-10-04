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
A provider that fails — a key out of credit (Tavily answers HTTP 432), an outage, the daily spend
cap — falls through to the next one for the category (Tavily → SearXNG → DuckDuckGo), and the reply
names the failure instead of saying "No results found". A provider that keeps failing, or reports a
quota or key problem, is skipped for ten minutes. `readiness` shows each backend's health (check
`search`), from real calls only — it never spends a credit to probe. Tavily calls are priced into
the daily spend ledger (source `search`).

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

## Research retrieval for live questions

`search` (the default research retriever together with OpenRouter web search) searches every
query the forecast planner decomposed — the named entities, recent news, the resolution source,
official data, base rates, market or expert expectations — through the backend chain
(`MARINA_RESEARCH_SEARCH_BACKENDS`, default: Tavily, Exa, SearXNG as configured, then DuckDuckGo,
then OpenRouter's Exa web plugin with `OPENROUTER_API_KEY` — a paid fallback for when DuckDuckGo
throttles bulk callers, which it does). A page the question names as its resolution source is read
before any search.

- **Breadth:** results are fused across queries, at most `MARINA_RESEARCH_DOMAIN_CAP` pages per site
  (default 3), up to `MARINA_RESEARCH_MAX_PAGES` (default 14) pages read in parallel through the
  SSRF guard, each with a timeout; no-fetch publishers are never read.
- **Depth:** the main text of each page is extracted (navigation, link lists and teaser cards
  dropped), and the passages most relevant to the question — not the head of each page — are
  quoted verbatim, dated, within the forecast's evidence budget — at most
  `MARINA_RESEARCH_MAX_PASSAGES` (15) per round, and none far below the best one.
- **Recency:** for a live question recent pages rank higher and every line carries its publication
  date; pages dated after the cutoff are dropped. `search` is not date-strict — use `asof` for
  backtests.
- **Status:** each research round records a funnel (hits, pages read, failed reads, passages, and
  each backend's calls and failures), so a thin dossier says why it is thin.

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
markets <query> [asof:<date>]   prediction-market prices (Polymarket, Kalshi)
odds <sport_key|team…>          pre-game sports odds, margin removed (ODDS_API_KEY)
series <id|query> [asof:<date>] official series (FRED, BLS)
```

The data verbs are the `data` command's sources (see [Commands](commands.md#structured-data)),
cached per query for ten minutes when live and six hours for a past `asof:`.

A world can also add a dedicated room, `searchRoom({ exits })`, whose verbs are `search`, `fetch`,
`wiki` and `sources`. To mount the tool on any existing room under verbs of your choosing, use
`searchToolCommands({ verbs })`. Both are in `src/world/rooms/search-room.ts`.

- **Caching:** replies are cached in the room's KV store per (engine, query, bound) for six hours.
- **Rate limit:** each entity is limited to one query every few seconds.
- **Tracing:** commands run through the normal command path, so they are recorded and traced like
  any other action.

## Local corpora

A local corpus is a fixed document collection with an offline BM25 index (SQLite FTS5, Porter stemming). It needs no network and no key. Use it for a benchmark's closed corpus, an archive or a team's documents.

```bash
bun run corpus build <name> <docs.jsonl> [--replace] [--source <label>]   # {"docid","text","title"?,"url"?} per line
bun run corpus list
bun run corpus search <name> <query> [--k 5]
bun run corpus get <name> <docid>
```

- **Location:** indexes live in `MARINA_CORPUS_DIR` (default `~/.local/share/marina/corpora`), one `<name>.db` each. Building writes a side file and renames it into place, so a half-built index is never served. Large corpora need a real disk: set `SQLITE_TMPDIR` too, if `/tmp` is small.
- **Search:** `web search engines:corpus:<name> <query>`. In a search room, use `search engine:corpus:<name> <query>` (in the Library, `find`).
- **Read:** `web fetch corpus://<name>/<docid>`, or the room's fetch verb (`fetch` / `archive`) with the same URL.
- **Research:** the research retriever takes `corpus:<name>` (`MARINA_FORECAST_RETRIEVER`, `MARINA_ARENA_RESEARCH_RETRIEVER`). It searches the brief's queries and cites `corpus://` URLs.
- **Discovery:** a corpus built after startup is picked up the first time it is named.
- **Not in open searches:** a corpus answers only searches that name it. It has no date bound, so it never answers a `before:` search.
- **Queries:** free text is reduced to its words, without English stopwords (Lucene's set, as in Anserini's BM25), so FTS5 syntax in a query is harmless and common words do not slow ranking.

[BrowseComp-Plus](browsecomp-plus.md) uses a local corpus.

## Building your own tool rooms

A room is a natural home for a tool: its commands, KV state and room agents are scoped to the room.

- **Write a room** with `build` (agents, behind the `world.code` gate). Its commands can call
  `ctx.httpGet` or any provider here, and keep state in `ctx.store`.
- **Wrap an MCP search server** with `connect add …` (mcporter). Calls look like
  `connect call <server> <tool> <json>`, and a room command or a `macro` can wrap that as a short
  verb. Stdio connectors need `shell.exec`.
