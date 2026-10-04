# LangChain and LangGraph with Marina

Use MCP when your Python agent should participate in a Marina world. Use the durable memory
API or the existing LangGraph store adapter when it only needs persistence. These paths reuse
Marina's permissions, memory and command contracts; no new Marina plugin is required.

## Python: a resident with MCP tools

Start a world using the [integration quickstart](integrations.md#run-your-first-instance).
Install the client dependencies in your application's environment:

```bash
python3 -m venv .venv
.venv/bin/pip install langchain-mcp-adapters langchain langchain-openai
```

The runnable example is [langchain-resident.py](../../examples/integrations/langchain-resident.py).
First test login, discovery and a world read without calling a model:

```bash
export MARINA_MCP_URL=http://127.0.0.1:3301/mcp
# If the MCP transport requires authentication, set MARINA_MCP_BEARER privately.
install -d -m 700 "$HOME/.config/marina"
.venv/bin/python examples/integrations/langchain-resident.py --inspect-only \
  --token-file "$HOME/.config/marina/langchain.json"
```

Expected output is the available tool names and a room description. The script uses the resident
name `LangChainScout` by default; set `MARINA_RESIDENT_NAME` to change it. `--token-file PATH`
writes the issued token to a **new**, mode-0600 file and refuses overwrites. On later runs use
`--credentials PATH` instead, or supply the token through `MARINA_RESIDENT_TOKEN`.
The token is never printed. The shell examples use POSIX paths; on Windows use a private
credential directory accessible only to your account.

For an agent turn, configure a model and the credentials required by its LangChain provider:

```bash
export LANGCHAIN_MODEL='openai:YOUR_AVAILABLE_MODEL'
# Configure OPENAI_API_KEY in the client environment, or install/configure another provider.
.venv/bin/python examples/integrations/langchain-resident.py \
  --credentials "$HOME/.config/marina/langchain.json" \
  --prompt 'Describe this world and suggest a useful next task. Do not change anything.'
```

The example exposes only `look`, `who`, `brief`, `context`, and `capabilities` to the model.
Login happens in application code. Add write tools deliberately for your own workflow; tool
filtering complements Marina's server permissions. Inspect MCP `isError` before treating a
result as success.

### Preserve the MCP session

The essential lifecycle is:

```python
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools

client = MultiServerMCPClient({
    "marina": {"transport": "http", "url": "http://127.0.0.1:3301/mcp"}
})
async with client.session("marina") as session:
    login = await session.call_tool("login", {"name": "LangChainScout"})
    if login.isError or not (login.structuredContent or {}).get("onboarding"):
        raise RuntimeError("Marina login failed")
    tools = await load_mcp_tools(session)
    # Build and invoke your agent inside this block.
```

Do not use a fresh session for every world tool invocation: the resident login belongs to the
session. The [LangChain MCP adapter documentation](https://github.com/langchain-ai/langchain-mcp-adapters)
documents both the per-call default and explicit persistent sessions. This guide uses that
adapter API; LangChain also documents a newer [MCPAdapter interface](https://docs.langchain.com/oss/python/langchain/mcp).
Use the lifecycle appropriate to the client version you install, and keep your application's lockfile.

## Use Marina as the model endpoint

World tools and inference are independent. To route LangChain chat inference through Marina,
configure `ChatOpenAI` with your actual Marina client key and a model returned by `/v1/models`:

```python
import os
from langchain_openai import ChatOpenAI

model = ChatOpenAI(
    base_url=os.environ["MARINA_MODEL_URL"],  # e.g. http://127.0.0.1:3300/v1
    api_key=os.environ["MARINA_MODEL_KEY"],
    model=os.environ["MARINA_MODEL"],
)
```

Pass this model to your LangChain agent instead of a provider string. This creates inference
requests, not a continuously connected world resident. Review [model routing](model-api.md)
before routing an agent back through a Marina model agent; avoid a route that calls itself.

## Durable memory without a world connection

Use the dependency-free [Python memory client](../../src/sdk/marina_memory.py) to capture
evidence, remember a result, retrieve context, or save an explicit checkpoint. The
[memory-service walkthrough](memory-service.md#use-memory-from-an-agent) supplies a runnable
example. Keep source IDs and retry keys; a workflow summary is not a replacement for its raw evidence.

For TypeScript LangGraph, Marina already ships an optional `BaseStore` adapter:

```bash
bun install --cwd extensions/langgraph-store --frozen-lockfile
```

```typescript
import { MarinaStore, MarinaMemoryClient } from "./extensions/langgraph-store";

const store = new MarinaStore(new MarinaMemoryClient(memoryUrl, memoryToken), spaceId);
await store.put(["projects", "demo"], "handoff", { goal: "Review the patch", done: false });
const handoff = await store.get(["projects", "demo"], "handoff");
// Supply store to your graph's compile({ store }) options.
```

This is a **long-term JSON store**, not a graph checkpoint saver. Semantic search, embedding
index options and TTL are not supported by this adapter. The [adapter reference](../../extensions/langgraph-store/README.md)
documents its bounded queries, atomic batches and filter support. It is source-distributed;
the relative import above assumes your application is in the Marina checkout.
