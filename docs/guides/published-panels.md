# Published panels

A published panel is an A2UI Canvas node containing a declarative view of Marina resources. Opening it adds a view beside your work. It does not create, stop or control an agent. Each open view has its own input drafts; the published definition and referenced resources are shared.

## Open and arrange

In the dashboard, select **Canvas → Published panels**, choose a canvas and select **Open beside my work**. Canvas nodes and rich chat previews also have **Open as panel**. The dashboard uses one Canvas panel host, with the familiar tiled layout. Older `?surface=canvas` links open the same workspace. Save a layout preset to restore its resource targets and geometry. Targets are bound to the resident who saved them; another resident does not inherit those private references.

You can open the same publication twice. Closing a tile removes only that view. Up to four additional tiles are supported. Referenced publications can expand inside a panel, with a four-level nesting limit and cycle detection. Nothing expands or rearranges the workspace merely because an agent publishes it.

## Create a coding desk

Start a coding session with the normal `code start` workflow. Select it in **Work** to open a personal Coding desk without publishing anything. It shows the target repository: Marina itself or any project you are working on. To share a composition, choose **Canvas → Published panels → Create coding desk**. Select the existing session, optionally attach a task and a visible participant, and select **Publish and open desk**. One coder is enough; additional participants are optional.

The desk shows recent coding activity, artifacts and recorded verification, a request composer, optional task evidence and participant messages, and world activity. The request button opens a review and targets that exact coding session, even if Chat is currently working in another session. The same ownership and command gates still apply. A recorded passing check describes the candidate that was checked; it does not establish that later filesystem edits passed.

Authors can reuse and customize the same ordinary document through the SDK:

```typescript
import { codingDesk, MarinaPanelClient } from "@marina/agent-sdk";

const panels = new MarinaPanelClient({ url: marinaUrl, token: residentToken });
await panels.publish(canvasId, codingDesk({
  sessionId,
  // taskId and participantId can be added when needed.
}));
```

Publishing and closing a desk never start, stop, assign or interrupt its worker. Drafts survive live updates, view switching and transport reconnects within the open application. Layout presets restore references and geometry; they do not persist unsent draft contents across a page reload.

## Author through existing Canvas facilities

Upload a JSON asset and use `canvas publish a2ui <asset_id> <canvas>`, or complete an existing intent with `canvas intent complete-rich <node_id> <json>`. The HTTP Canvas node API accepts the same document. Documents loaded from assets use configured Marina storage, not publisher-supplied remote code or URLs.

The SDK exposes `MarinaPanelClient`:

```typescript
import { MarinaPanelClient } from "@marina/agent-sdk";

const panels = new MarinaPanelClient({ url: marinaUrl, token: residentToken });
const node = await panels.publish(canvasId, {
  schema: "marina.panel.v1",
  title: "Project activity",
  sources: { work: { kind: "task", id: "42" } },
  components: [
    { id: "root", component: "Column", children: ["title", "task", "events"] },
    {
      id: "title", component: "Text",
      bindings: { text: { source: "work", path: ["title"] } },
    },
    { id: "task", component: "Resource", reference: { kind: "task", id: "42" } },
    { id: "events", component: "Resource", reference: { kind: "feed", limit: 10 } },
  ],
});
```

Use real resource IDs from your world. Read a publication with `panels.get(canvasId, nodeId)`. Copying its validated document and publishing it creates an independent definition; opening it again creates another view of the original. For shared edits, `panels.revise(canvasId, nodeId, current.data.panelRevision, document)` refuses a stale revision. Existing generic Canvas PATCH clients retain their compatibility contract; supply `revision` to get this conflict check.

Public Canvas definitions are public content. Store references to private resources rather than copying their contents into a definition. Each reader's credentials determine whether a source resolves. The author does not grant access by mentioning an ID.

## Discover and compose data

Agents and humans use the same catalog: `canvas resources [filter]`, `GET /api/panel-resources`, `panels.resources()`, or **Published panels → Compose a panel**. The terminal also offers `/panel resources [filter]`. Each entry declares an ID, path parameters and accepted query fields. Sources span coding sessions and artifacts, participant output and messages, coordination, memory, world activity, canvases, media, operations and experiments. Catalog entries describe readers; they do not grant access.

Here is a coded composition that keeps an existing coder alongside coordination data. Run it against the same Marina instance that owns the session, whether its repository is Marina or an external project:

```typescript
import { codingDesk, MarinaPanelClient } from "@marina/agent-sdk";

const panels = new MarinaPanelClient({ url: marinaUrl, token: residentToken });
const desk = codingDesk({ sessionId });
await panels.publish(canvasId, {
  ...desk,
  title: "Development and coordination",
  sources: {
    channels: { kind: "resource", resource: "channels" },
    coding: { kind: "resource", resource: "coding.session", params: { id: sessionId } },
  },
  components: [
    ...desk.components.map((c) => c.id === "root"
      ? { ...c, children: [...c.children as string[], "repository", "channels"] } : c),
    { id: "repository", component: "Text",
      bindings: { text: { source: "coding", path: ["session", "workspace_root"] } } },
    { id: "channels", component: "DataTable", columns: ["name", "type"],
      bindings: { rows: { source: "channels", path: [] } } },
  ],
});
```

Use `query: {limit: 25}` on adapters declaring `limit`, and inspect the canonical API response to choose binding paths. Detail IDs go in `params`; a Resource component can also render the whole response. Coded panel documents are validated data, not executable browser JavaScript. Agents can author them in any coding workspace, upload and publish an A2UI asset, or use the SDK directly. Publication leaves everyone else's layout and autonomous work untouched.

The catalog exposes existing read APIs, not raw database tables or arbitrary network paths. Credentials, side-effecting reads and unpublished internal state are not panel sources. To expose a new domain, first provide its authorized read API, then add its adapter to `src/sdk/panel-resource-catalog.ts`; all clients discover the same contract. Durable memory records also use the resident memory adapter below. The original short references remain semantic adapters for richer coding, participant and task views.

## Sources and components

Existing components remain supported: `Text`, `Button`, `TextField`, `CheckBox`, `DateTimeInput`, `Row`, `Column`, `Card`, `Surface`, `DataTable` and `Timeline`. `Resource` adds a view of an existing resource. Historical `Text.value` and string table columns normalize to `Text.text` and `{key, label}` columns.

| Source | Reference |
|---|---|
| Any catalog resource | `{kind: "resource", resource: "channels"}`; detail sources also accept `params`, collections accept declared `query` fields |
| Task and its evidence | `{kind: "task", id: "42"}` |
| Numeric note | `{kind: "note", id: "123"}` |
| Durable memory record | `{kind: "memory", id, spaceId}` |
| Coding artifact | `{kind: "artifact", id, sessionId}` |
| Coding attempt | `{kind: "run", id}` |
| Coding session, activity and artifacts | `{kind: "coding", id: sessionId}` |
| Participant and bounded recent output | `{kind: "participant", id}` |
| Another published node | `{kind: "canvas", canvasId, id}` |
| Recent world events | `{kind: "feed", limit: 25, filter: "optional-event-kind"}` |

Named `sources` may supply component `bindings` using `{source, path}`. `source: "dataModel"` reads the document's static data model. Paths traverse own JSON properties; they are not expressions. Bindable properties are `text`, `rows`, `items`, `value`, `checked` and `disabled`. Bound values must still match the component's type.

Documents are limited to 256 KiB, 128 components, eight distinct live resources, depth 20 and 512 rendered component occurrences. Missing children, cycles, unsupported versions and malformed values are rejected at publication. Resource errors remain visible; they do not silently become authoritative empty results.

Canvas updates use a shared subscription per canvas and credential. Other sources use content-free world change notices to trigger fresh, authorized reads. Repeated views share the dashboard query cache and event subscription; bursts are coalesced without indefinitely postponing refresh. Reconnect triggers a fresh read, with a five-second active-view polling fallback for missed or externally written changes. Hidden workspace views suspend their reads. Each resource keeps its existing authorization policy; a private read failure hides cached content. Participant history reports retention gaps, and task evidence retains its verification/review semantics.

## Actions

Buttons can declare one `operation`. Opening or refreshing a panel never executes it. The web client displays a review with the destination and captured values; **Confirm action** submits as the clicking resident. Input values remain local for operational forms.

```json
{
  "id": "send",
  "component": "Button",
  "label": "Ask for a review",
  "operation": {
    "kind": "message",
    "targetId": "actual-participant-session-id",
    "message": { "field": "request" }
  }
}
```

Include a `TextField` with `id: "request"` in the same document. The reader explicitly selects an active participant they own as the sender. A normal message is a request to its recipient, not a forced runtime action.

| Operation | Contract |
|---|---|
| `message` | `targetId`, `message` as a literal string or `{field}`. Uses existing routing scopes and durable delivery receipts. |
| `control` | `targetId`, `control: "prompt" | "interrupt" | "stop" | "resume" | "respond"`, and `values`. Requires session ownership and the existing `code.exec` gate. Prompt uses `text`; respond uses `requestId`, boolean `allow`, and optional `answer`. |
| `command` | `command`, exact live `syntax`, optional `values` keyed by command-form field ID, optional `enabled` group IDs. Reuses the live command manifest, permissions and per-entity FIFO. |

An operation's values can be string/boolean literals or `{field: "component-id"}`. Command forms come from the capability manifest, not a new panel-specific command grammar. Changed definitions or command capabilities require another review.

For the `code` command, an optional `codingTarget: {sessionId, runId?}` binds the request to an existing session and, when supplied, attempt. It is validated and authorized by the existing command path. It neither changes the resident's selected session nor grants access to a session owned by someone else.

Routing retries preserve the captured request ID, source, destination and payload. A queued or acknowledged receipt is not evidence that the requested work completed. World commands have no delivery deduplication guarantee: after a lost response, inspect world activity before another submission. Started commands keep their normal execution slot; a timeout reports an uncertain outcome.

Legacy `action.event` buttons and field notifications still update `lastAction`. This is the latest notification, not a durable mailbox. New operational integrations should use typed operations. Failures are shown in the panel.

## Terminal

The existing Marina coding terminal has a separate panel view. Coding, world output and requests remain live, with their composers preserved.

```text
/panel list
/panel list <canvas-id>
/panel desk
/panel publish <canvas-id>
/panel views
/panel use 2
/panel resources coding
/panel open <canvas-id> <node-id>
/panel field request Please review the latest verification evidence
/panel act send <my-sending-participant-id>
/panel confirm
/view world
/view coding
/view panel
/panel close
```

`/panel desk [session-id]` opens a personal view of the selected or explicit coding session. `/panel publish <canvas-id> [session-id]` explicitly publishes and opens a shared desk; it replaces the former publishing meaning of `/panel desk`. Up to four local views preserve separate drafts and captured reviews. Use `/panel views` and `/panel use <number>`, or **Alt+Left / Alt+Right** in the panel form, to switch. Only the selected, visible view reads live data. Closing it returns to another open view. In the full-screen TUI, **F8** focuses the panel. **Tab / Shift+Tab** move between fields and actions; type directly in a selected text field, use **Space** for a checkbox, and **Enter** to review an action. Reviews initially focus **Cancel**. Select **Confirm action** separately to submit, or use **Escape** to close the review. For messages, choose the sending participant with the arrow keys. **F6** returns to Coding/World, and **F7** opens requests. Each conversation retains its draft.

The slash controls remain available in the scrollback terminal: `act` captures and displays the action; `confirm` submits it. A failed routing delivery can be retried with `confirm` using the same identity. Active views refresh on world change notices with a five-second fallback; `/panel refresh` requests an update. Terminal projections show semantic text, resources and actions rather than reproducing graphical geometry or media playback. Closing the view does not stop its producer.
