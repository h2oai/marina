# Canvas-Map Convergence: Implementation Roadmap and Reconciliation

Reference mockup: `design/canvas-map-mockups/06-tiled.html`
Design brief: `docs/canvas-map-convergence.md`

## Architecture Overview

Replace the current split dashboard (grid panels) + canvas (separate ReactFlow page) with a single unified view where:
- The world map IS the canvas (ReactFlow)
- Rooms are custom ReactFlow group nodes with geometric visualizations
- Canvas nodes (documents, intents, A2UI, media) coexist on the same surface
- Entities are positioned within their room nodes
- Floating panels overlay the map for auxiliary views
- A persistent command bar handles all input/output

## Current Reconciliation

Last reconciled: 2026-05-03.

The unified canvas-map exists under `dashboard/src/unified/` and can be opened with `?unified`. It is also embedded behind the WorldMap panel's back face in the existing dashboard. The original `/dashboard` grid and `/canvas` standalone canvas routes still exist; the unified view has not yet replaced route selection in `main.tsx`.

| Area | Status | Notes |
|---|---|---|
| Unified ReactFlow surface | Implemented | `UnifiedCanvas.tsx` renders room, canvas, graph, and feed layers together. |
| Route replacement | Not done | `main.tsx` still routes `/dashboard`, `/canvas`, and `?unified` separately. |
| Room nodes | Implemented | `RoomNode.tsx` renders geometric rooms, activity rings, entity orbits, and status markers. |
| Canvas/media nodes | Implemented | Existing canvas node renderers are reused through `use-canvas-integration.ts`; multiple canvas selection is available in `WorldNav`. |
| Graph/feed overlays | Implemented | `GraphNoteNode`, `GraphLinkEdge`, `TimelineStrip`, and layer chips are present. |
| Context/command/entity panels | Implemented | `ContextPanel`, `CommandBar`, and `EntityPanel` are active. Admin and Feed panels exist, but their functions are mostly merged into command/admin tabs. |
| Activity metrics | Implemented | `use-activity.ts` and event ingestion drive rings, arcs, timeline, and room/entity activity. |
| Layout engine | Partial | Grid-aware room layout and collision helpers are in `layout-utils.ts`; there is no WebWorker layout engine yet. |
| Drag/drop and viewer | Implemented | `DropDialog` and full-screen `Viewer` are wired from `UnifiedCanvas`. |
| Edge editing | Implemented | `EdgeContextMenu` handles relationship changes and deletes for graph/canvas edges. |
| Keyboard/layer controls | Implemented | Global layer toggles, clear view, reset, fit, arrow navigation, and command-bar shortcuts are present. |
| Production build | Passing | Reconciled by removing stale `animejs` vendor chunk from `vite.config.ts`. |

## Tech Stack (unchanged from current)

- React 19 + Vite
- ReactFlow (`@xyflow/react`) — already a dependency
- Zustand — already used for state
- React Query — already used for API caching
- Motion — used for React animation; `animejs` was removed from dashboard dependencies
- Tailwind CSS 4 — already used for styling
- WebSocket — already implemented (dashboard-ws + canvas-ws)

## Phase 1: Foundation (replace routes, base rendering)

### 1.1 Unified Route
- Status: **not done**
- `main.tsx` still uses `/canvas` path detection and `?unified` query-param selection.
- Old dashboard and canvas components remain active.

### 1.2 ReactFlow World Map
- Status: **implemented as `UnifiedCanvas.tsx`**
- Main component: `UnifiedCanvas.tsx` — full-viewport ReactFlow instance
- Custom node type: `RoomNode.tsx`
  - Renders geometric crown (SVG) based on `room.district`
  - Spinning rings as CSS animations (not SVG SMIL — GPU composited)
  - Column beam + entity dots inside the node
  - Ring speed driven by activity metrics (Zustand store)
- Canvas content nodes
  - Wraps existing canvas node types (image, video, pdf, a2ui, etc.)
  - Rose border for imported items
  - Intent status ring overlay
- Custom edge type: `FlowEdge.tsx` — animated dashed line with particles
- Custom edge type: `InteractionArc.tsx` — temporary agent-to-agent arcs
- Custom graph edge type: `GraphLinkEdge.tsx`

### 1.3 Activity Metrics Store
- Status: **implemented as `use-activity.ts`**
- Store tracks sliding-window event counts per room/entity.
- 30-second sliding window event counters per room and per entity
- Fed by dashboard WebSocket events
- Drives: ring speed, crown rotation, entity dot state, sonar pulses
- Exponential decay counters (O(1) per event, not arrays)

### 1.4 Auto-Layout Engine
- Status: **partial**
- `layout-utils.ts` contains grid-aware layout, cluster placement, ring positioning, and collision repulsion.
- No WebWorker implementation exists yet.
- Port `autoLayout()` from mockup to a WebWorker
- Force-directed room positioning (center gravity, exit attraction, repulsion)
- Ring distribution for canvas nodes around rooms
- Collision detection via spatial grid (not O(n²) pairwise)
- Pinning: user-dragged items excluded from auto-layout
- Runs async, posts results back to main thread

## Phase 2: Core Interaction

### 2.1 Context Panel
- Status: **implemented**
- Component: `ContextPanel.tsx` — floating overlay, not structural
- Cascade sections as React components: `PropertySection`, `SourceSection`, `EntityList`, `ExitList`, etc.
- Click any ReactFlow node → context panel opens with auto-zoom
- Click same node → closes (toggle behavior)
- All items in cascade are clickable (navigate to entity/room/canvas node)

### 2.2 Command Bar
- Status: **implemented**
- Component: `CommandBar.tsx` — persistent floating terminal
- Tabs: All | Room | Tell | Channels | Projects | Tasks | Boards | Pools | Groups
- Message stream fed by WebSocket events + user commands
- Arrow-key command history
- `/` toggles visibility
- Reuse existing `parse-input.ts` for command parsing
- Connect to existing WebSocket for sending commands

### 2.3 Floating Panels
- Status: **partial**
- Entity roster: `EntityPanel.tsx` — Online | Launch | Roles tabs
- Admin: `AdminPanel.tsx` — Keys | Adapters | MCP | Config tabs
- Activity Feed: `FeedPanel.tsx` — event stream
- `FloatingPanel.tsx` supplies drag, resize, roll, close, and auto-fade behavior.
- In current `UnifiedCanvas`, feed and admin functions are mostly merged into `CommandBar`; standalone `AdminPanel` and `FeedPanel` remain available but are not the primary path.

### 2.4 Auto-Zoom
- Status: **implemented**
- Click any node → `reactFlowInstance.fitView({nodes: [id], padding: 0.3})`
- Smooth animation via ReactFlow's built-in transition
- Double-click empty space → `fitView()` for full world
- Home button in topbar → `fitView()`

## Phase 3: Canvas Integration

### 3.1 Canvas Nodes on World Map
- Status: **implemented**
- Existing canvas node types become ReactFlow custom nodes
- Position relative to their room (ReactFlow parent node)
- Intent status overlay (pending/active/done/failed rings)
- Relationship edges from canvas nodes to claiming agents

### 3.2 Media Previews
- Status: **implemented for existing canvas node renderers; zoom-level LOD still partial**
- Image nodes show thumbnail at zoom > 0.7 (LOD)
- Video nodes show poster frame + play icon
- PDF nodes show first page preview
- Document nodes show text snippet

### 3.3 Full Viewer
- Status: **implemented**
- Double-click canvas node → full-screen overlay
- Reuse existing node renderers (ImageNode, VideoNode, PdfNode, etc.)
- A2UI nodes render interactive components (buttons, tables, etc.)

### 3.4 Drag-Drop Upload
- Status: **implemented**
- Drop handler on ReactFlow viewport
- MIME detection → node type inference
- Create canvas node via existing API (`POST /api/canvases/{id}/nodes`)
- Rose color for imported items
- Auto-open context panel

### 3.5 Intent Workflow
- Status: **implemented**
- Visual: pending=amber ring, active=cyan ring+arc, done=green, failed=red
- Click intent node → cascade shows prompt, status, claimed-by
- Agents discover intents via existing `canvas intent list` command
- Results create child nodes (existing behavior)

## Phase 4: Polish

### 4.1 Theme Switcher
- Status: **implemented**
- Reuse existing `themes.ts` definitions
- `applyTheme()` already works — just add a toggle button
- Room structure colors update with theme

### 4.2 Activity-Driven Animation
- Status: **implemented/partial**
- Port the metaphor system from mockup:
  - Ring speed = events/sec
  - Crown rotation = event diversity
  - Breathing = recency of last event
  - Sonar = actual event trigger
  - Idle = frozen, dim
- CSS `@keyframes` with `animation-duration` set via CSS custom properties driven by the activity store

### 4.3 World Ring
- Status: **implemented**
- SVG overlay behind all ReactFlow nodes
- Computed from bounding box of all rooms
- Spin speed = total system events/sec

### 4.4 Interaction Arcs
- Status: **implemented**
- Temporary ReactFlow edges created on say/tell events
- Fade after 6 seconds (remove edge after timeout)
- Color by type (cyan=say, violet=tell)

### 4.5 Global Search
- Status: **implemented**
- Command: `search <query>` or `?<query>`
- Search entities, rooms, canvas nodes, projects
- Results in command bar + auto-zoom to first match

### 4.6 LOD System
- Status: **partial**
```
zoom < 0.3  → rooms as simple colored dots with name labels
zoom 0.3-0.7 → rooms show spinning rings + crown outline
zoom 0.7-1.2 → full structure + entity dots + canvas node icons
zoom > 1.2   → full detail + entity names + canvas previews + arcs
```

### 4.7 Touch/Mobile
- Status: **partial**
- ReactFlow handles touch pan/zoom natively
- Larger touch targets at `@media (pointer: coarse)`
- Command bar as bottom sheet on mobile

## Phase 5: Remaining Gaps

- Replace `/dashboard` and `/canvas` routing with the unified view once visual parity is accepted.
- Move layout computation to a WebWorker or explicitly remove the WebWorker target if the grid-aware layout remains fast enough.
- Finish zoom-level LOD behavior and validate it across dense worlds.
- Complete mobile/touch treatment for the command bar and side panels.
- Canvas node editing in unified context panel: rename and resize are still primarily standalone-canvas workflows; delete is present.
- MUD-style perception rendering for `look` command in unified command output needs explicit visual QA.
- Message type styling for shout/emote/whisper needs explicit visual QA.
- Group rank badges are richer in the classic coordination card than in the unified command-bar group detail.
- Back-face analytics charts exist in the classic dashboard; decide whether they remain there or move into unified panels.
- Keyboard navigation within panels should be reconciled with the unified global arrow-key node navigation.

## Performance Targets

| Metric | Current Dashboard | Target |
|---|---|---|
| Rooms rendered | All always | Viewport-culled (ReactFlow) |
| Re-render on event | Full innerHTML rebuild | React reconciliation (diff) |
| Layout computation | Main thread O(n²) | WebWorker O(n log n) |
| Concurrent animations | ~500 SMIL | ~50 CSS (viewport-limited) |
| Max rooms | ~30 before jank | 500+ |
| Max entities | ~50 | 1000+ |
| Max canvas nodes | ~100 | 5000+ |
| Frame budget | ~100ms rebuild | <16ms incremental |

## Migration Strategy

1. Build new unified view as a separate component tree. **Done.**
2. Expose unified view behind an opt-in selector. **Done via `?unified`; not via `MARINA_NEW_DASHBOARD`.**
3. Keep old dashboard and canvas routes during parity work. **Current state.**
4. Run visual smoke tests and route-level browser checks for the unified view.
5. Promote unified view to default dashboard route.
6. Remove or archive old dashboard/canvas-only components after validation.

## File Plan

```
dashboard/src/
├── unified/                    # New unified view
│   ├── UnifiedCanvas.tsx       # Main component (ReactFlow viewport)
│   ├── nodes/
│   │   ├── RoomNode.tsx        # Geometric room structure
│   │   └── GraphNoteNode.tsx   # Knowledge graph note node
│   ├── edges/
│   │   ├── FlowEdge.tsx        # Room-to-room flow
│   │   └── InteractionArc.tsx  # Agent-to-agent arc
│   ├── panels/
│   │   ├── ContextPanel.tsx    # Click-to-inspect overlay
│   │   ├── CommandBar.tsx      # Persistent terminal
│   │   ├── EntityPanel.tsx     # Roster + Launch + Roles
│   │   ├── AdminPanel.tsx      # Keys + Adapters + MCP + Config
│   │   └── FeedPanel.tsx       # Activity stream (mostly merged into CommandBar)
│   ├── overlays/
│   │   ├── Viewer.tsx          # Full-screen media viewer
│   │   └── WorldRing.tsx       # Ambient world boundary
│   ├── hooks/
│   │   ├── use-activity.ts     # Activity metrics store
│   │   ├── use-canvas-integration.ts
│   │   └── use-interactions.ts
│   └── lib/
│       ├── layout-utils.ts     # Grid-aware layout + collision helpers
│       ├── ansi.ts             # ANSI escape rendering
│       └── search.ts           # Unified search
├── components/                 # Existing (kept during migration)
├── canvas/                     # Existing (kept during migration)
└── main.tsx                    # Feature flag routing
```
