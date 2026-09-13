# LangGraph JSON store

An optional TypeScript `BaseStore` adapter. Install its dependencies with `bun install` in this directory. Marina's standard install does not include LangGraph or an embedding model.

```ts
import { MarinaStore, MarinaMemoryClient } from "./extensions/langgraph-store";
const store = new MarinaStore(new MarinaMemoryClient(url, token), spaceId);
await store.put(["projects", "marina"], "handoff", { task: "Review sources", done: false });
const handoff = await store.get(["projects", "marina"], "handoff");
// Pass store to a LangGraph graph's compile({ store }) options.
```

The named `langgraph-store-json-v1` profile supports get, put, delete, namespace prefix searches, exact/comparison filters, and namespace listing with prefix/suffix wildcards. `createdAt` and `updatedAt` are JavaScript Dates. Writes capture the original JSON and update native versioned records. Deletion forgets the item and its captured source lineage. Existing grants and owner quotas apply.

Batches execute atomically in caller order, with at most 64 operations. Values are limited to 64 KiB; searches and namespace listing examine at most 2,000 candidate items and 4 MiB. Narrow a namespace prefix when a query exceeds that bound. Filters support top-level fields and `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`. Namespace labels cannot contain periods; the root `langgraph` is reserved.

This profile rejects semantic `query`, embedding index paths, TTL options and unsupported operation fields. Use Marina's explicit retrieval APIs separately. Stale or conflicting native store records require review; the adapter does not silently overwrite them. A read/write credential is needed for mutations. A batch failure rolls back its writes; retries preserve the original request key. New invocations are new operations.

The adapter implements [LangGraph's BaseStore interface](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint/src/store/base.ts), whose package is MIT licensed. This is a long-term JSON store adapter, not a graph checkpoint saver.
