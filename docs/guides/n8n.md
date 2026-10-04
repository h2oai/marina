# n8n workflows with Marina

Start with n8n's HTTP Request node. It works with Marina's stateless memory and model APIs,
keeps credentials in n8n's credential store, and makes retries inspectable. Use world MCP when
your n8n client can preserve a logged-in MCP session for the whole agent run.

## Workflow: retain evidence and a reusable handoff

This recipe needs no model. Start a standalone memory service using
[memory-service setup](memory-service.md#start-a-private-service). Its provisioned credential
file contains a `token` and `spaceId`.

1. In n8n, create a **Header Auth** credential: name `Authorization`, value
   `Bearer YOUR_MEMORY_TOKEN`. This is a memory credential, not a model-provider key.
2. Add a **Manual Trigger**, followed by **Edit Fields**. Keep these non-secret fields:
   `memoryUrl`, `spaceId`, `eventId`, and `content`. For a first run, use a unique event ID
   such as `demo-handoff-001` and content such as `Review the pagination patch before release.`
3. Add **HTTP Request**, named `Capture source`: POST to
   `{{ $('Edit Fields').item.json.memoryUrl }}/v1/memory/spaces/{{ $('Edit Fields').item.json.spaceId }}/sources`.
   Select Generic Credential Type → Header Auth and your credential. Send JSON, with these fields:

   ```json
   {
     "content": {"role": "user", "content": "Review the pagination patch before release."},
     "session_id": "n8n-handoff-demo"
   }
   ```

   Map `content.content` from the Edit Fields node for actual input. Add the header
   `Idempotency-Key` with expression `{{ $('Edit Fields').item.json.eventId + ':source:v1' }}`.
4. Add a second HTTP Request, named `Remember handoff`: POST to the same space's `/records`.
   Use the same credential and the distinct idempotency key
   `{{ $('Edit Fields').item.json.eventId + ':record:v1' }}`. Use a JSON expression body:

   ```javascript
   {{ {
     content: $('Edit Fields').item.json.content,
     source_ids: [$('Capture source').item.json.id]
   } }}
   ```
5. Inspect the returned record ID. Add a GET request to
   `/v1/memory/spaces/SPACE_ID/records/RECORD_ID` using that ID and the same credential.
   The content and source reference should match the input.

Configure `memoryUrl` for where **n8n runs**: `http://127.0.0.1:3301` only works when it shares
the server's host network. On a container network, use the memory service's DNS name and a
deliberate reachable bind address. n8n Cloud needs a reachable HTTPS deployment. Do not put
credentials in Edit Fields, workflow JSON, published panels, or example URLs.

For webhook input, use an immutable upstream delivery/event ID. Reuse the same key and payload
after a timeout; a new n8n execution ID on every retry would create a new logical write. Marina
rejects reuse of a key with a different payload with HTTP 409. A real edit needs an explicit new
operation/version. Capture and remember are two operations: a failed second step may leave a
source, and retrying it should reuse the first source receipt. See the
[memory contract](memory-service.md#http-contract) for mutation/version rules.

The [n8n HTTP Request reference](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
describes JSON expressions and generic credentials. The credential and node labels may vary
with your installed n8n version; the Marina HTTP contract above is the integration boundary.

## Ask a Marina model from a workflow

Use an HTTP Request node with POST `https://YOUR_MARINA/v1/chat/completions`, a **separate**
Header Auth credential containing an actual `MODEL_API_KEYS` secret, and JSON:

```json
{
  "model": "MODEL_FROM_V1_MODELS",
  "stream": false,
  "messages": [{"role": "user", "content": "Suggest three checks for this release."}]
}
```

First GET `/v1/models` with that credential to select a valid model. The reply text is under
`choices[0].message.content`. Model calls can incur provider cost. Keep inference separate from
publishing or mutating production systems: a model's text is not evidence that an action ran.
If your n8n OpenAI-compatible model node exposes a configurable base URL, the equivalent base
is `https://YOUR_MARINA/v1`; otherwise use the HTTP Request path.

## World participation through MCP

Marina serves **Streamable HTTP at `/mcp`**, not a legacy `/sse` endpoint. n8n's
[MCP Client Tool documentation](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)
documents bearer/header credentials and tool selection, but does not establish that every
version preserves the same session between tools. Verify the node version you deploy:

1. Configure a client transport that supports Streamable HTTP and the actual Marina `/mcp` URL.
2. Configure the transport bearer if Marina requires it.
3. Call `login`, then `look` on the same session. The second call must see the logged-in resident.
4. Reconnect with `auth` and a saved resident token after transport/session expiry.

If the node only offers legacy SSE or creates a new session per invocation, use the HTTP recipes
above or a persistent application bridge such as the [LangChain example](langchain.md).
Do not assume that an HTTP bearer alone logs in a world resident. Filter tools to the workflow's
needs, and use live `capabilities` to discover command forms instead of maintaining another catalog.

## Let Marina call an n8n workflow

The direction can also be reversed: expose a deliberately selected workflow through n8n's
[MCP Server Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/),
then configure it as an outbound Marina MCP connector using [MCP connections](mcp-integration.md#outbound-connectors).
Check the node's production URL and transport. Expose only workflows you intend agents to run;
their external actions remain subject to your workflow credentials and approval rules.
