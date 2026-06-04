# Canvas-Map Convergence: Design Brief

## Research Summary

Five parallel investigations were conducted across the agent visualization landscape, plus a deep audit of Marina's existing dashboard and canvas systems.

### Competitive Landscape

| Project | Rendering | Key Pattern | Agents | Real-time |
|---------|-----------|-------------|--------|-----------|
| **AI Town** (a16z) | PixiJS 2D tilemap | Spatial encoding of social dynamics — agents walk toward each other to converse | 5-8 | Yes (Convex reactive) |
| **ClawMUD** | Web dashboard + map | AI-as-player spectator model, 268 real-world cities, atomic tick resolution | Many | Yes (tick-based) |
| **Pixel Agents** ecosystem | Canvas 2D / Phaser / PixiJS | Activity-driven animation — agent state maps to sprite behavior | Per-session | Yes (JSONL tailing) |
| **GitCity** landscape | Three.js / WebGL | Height=metric, glow=activity, arcs=communication flows, treemap neighborhoods | N/A | Partial (DynaCity) |
| **Marina** (current) | SVG map + ReactFlow canvas | Room aggregates, dual WebSocket, intent system, 7 draggable panels | Unlimited | Yes (WS batching) |

### Key Patterns Extracted

1. **Spatial encoding of social dynamics** (AI Town): Physical proximity = interaction. Walking toward = intention. Standing together = participating. Leaving = disengaging. This makes social dynamics watchable without reading text.

2. **Activity-driven animation** (Pixel Agents): What the agent does maps directly to visual state. Coding → typing sprite. Reading → scanning sprite. Idle → wandering. The visual IS the status.

3. **Luminance/glow for real-time activity** (DynaCity, Git City Pulse): Active entities glow brighter. Communication paths pulse. Errors shift color. The "night city where active services glow" metaphor is the most compelling dynamic visualization pattern.

4. **OD arcs for inter-entity communication** (DynaCity): Glowing arcs between entities show message flows, task handoffs, coordination patterns. Brightness = volume. Color = type.

5. **Progressive disclosure** (AI Town): Map shows positions + minimal state → Click reveals identity + conversation → Sidebar shows full history. Information layers by attention zoom.

6. **"Solves anxiety, not productivity"** (Pixel Agents): Making invisible agent work visible and charming is the feature. The psychological reassurance of seeing what agents are doing is the core value.

7. **Height as primary metric** (GitCity): For any scalar metric (rank, activity, task completions), vertical dimension is the most immediately legible visual channel.

8. **Mobile avatars + static structures** (unexplored whitespace): The combination of agents moving through spatial environments with buildings/structures is largely unexplored. AI Town has it simply. Nobody has it richly.

---

## Current State Assessment

### What Marina Has (Strengths to Preserve)
- **ReactFlow canvas** — extensible node graph with 9 node types, drag-drop, intent system
- **Dual WebSocket channels** — dashboard events + canvas mutations, rAF batching
- **Glass panel aesthetic** — Orbitron/Share Tech Mono fonts, scanlines, 5 themes (H2O gold, Cyberpunk cyan, Synthwave purple, Matrix green, Ocean blue)
- **SVG world map** — room circles with population pulses, district coloring, hover tooltips
- **7 draggable panels** — react-grid-layout with focus mode, flip animations, keyboard nav
- **Intent system** — canvas nodes trigger agent tasks with lifecycle tracking
- **Motion** — spring-based animations integrated after replacing `animejs`

### What's Missing (The Gap)
- **No spatial entity positioning** — entities are room aggregates, not individual positions
- **No movement visualization** — can't see agents move between rooms
- **No interaction arcs** — messages/coordination invisible on the map
- **Canvas is secondary** — separate route, not integrated with dashboard
- **No activity-driven visual state** — agent status is text in a list, not visual on map
- **No HUD overlay** — dashboard panels and map are separate, not composited

---

## Convergence Vision: The Living Canvas

**One view. Canvas IS the map. Rooms are spatial regions. Entities are positioned within them. Interactions arc between them. HUD panels overlay the living world.**

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        LIVING CANVAS                             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              WORLD LAYER (rooms as regions)              │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │    │
│  │  │  Nexus   │──│ Workshop │──│ Research │              │    │
│  │  │  ◉ ◉ ◈  │  │  ◈   ◉  │  │    ◉     │              │    │
│  │  └──────────┘  └──────────┘  └──────────┘              │    │
│  │       │              │                                    │    │
│  │  ┌──────────┐  ┌──────────┐                              │    │
│  │  │  Market  │──│  Garden  │   ◉ = agent (glowing)       │    │
│  │  │    ◉     │  │          │   ◈ = human (bright)        │    │
│  │  └──────────┘  └──────────┘   ── = exit path            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ARC LAYER: animated lines between communicating entities         │
│  ════════════════════════════════════════════════════════════     │
│                                                                   │
│  ┌─ HUD ──────────────────────────────────────────────────┐     │
│  │ [Activity Feed]  [Entity Detail]  [Metrics]  [Chat]    │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### Three Rendering Layers

**Layer 1: World Substrate** — Rooms as bounded regions with district coloring. Exits as connecting paths. Room names as labels. This replaces the current SVG WorldMap.

**Layer 2: Entity Layer** — Agents and humans as positioned icons/nodes within room regions. Each entity has:
- Position (x, y) within its room region
- Visual state driven by activity (thinking glow, speaking pulse, moving trail, idle dim)
- Rank indicator (size, ring color, or badge)
- Focus indicator (what they're working on, shown on hover)

**Layer 3: Arc Layer** — Dynamic connections between entities:
- **Message arcs**: Pulse when entities communicate (color by channel)
- **Task arcs**: Show delegation/coordination (emerald for active, gold for complete)
- **Proximity lines**: Faint connections between entities in same room
- **OD matrix mode**: Toggle to show aggregate flow patterns between rooms

### HUD Overlay Panels

Glass panels float over the canvas, translucent and repositionable:

| Panel | Purpose | Position |
|-------|---------|----------|
| **Compass Bar** | Entity count, active arcs, uptime, memory | Top center |
| **Activity Stream** | Flowing event ticker (slim, horizontal) | Top edge |
| **Entity Detail** | Click-to-inspect: memory, notes, activity | Right sidebar (slide-in) |
| **Chat** | WebChat for human interaction | Bottom right (collapsible) |
| **Coordination** | Projects/tasks/boards mini-view | Bottom left (collapsible) |
| **Mini-map** | Zoomed-out overview of entire world | Top right corner |

### Entity Visual States

| Agent State | Visual Treatment |
|-------------|-----------------|
| **Thinking** (LLM call in progress) | Pulsing glow ring, thought indicator |
| **Speaking** (sending message) | Speech arc to target, bright pulse |
| **Working** (executing command) | Steady glow, activity icon |
| **Moving** (changing rooms) | Animated position transition along exit path |
| **Idle** | Dim, slightly transparent |
| **Stuck** | Warning ring (amber pulse) |
| **Error** | Red flash, danger ring |

### OD Matrix Overlay

Toggle-able view showing aggregate flow between rooms:
- Line thickness = message volume between rooms
- Line color = interaction type (coordination=gold, social=cyan, task=emerald)
- Animated particles flowing along lines = real-time activity direction
- Room nodes sized by total throughput

---

## Implementation Strategy

### Phase 1: Canvas as Primary View (Merge Routes)
- Unify `/dashboard` and `/canvas` into single route
- Canvas becomes full-screen background
- Existing dashboard panels become floating HUD overlays
- Keep all current panel functionality intact

### Phase 2: Room Regions on Canvas
- Rooms rendered as ReactFlow group nodes (bounded regions with district coloring)
- Exit connections as styled edges between room nodes
- Auto-layout using existing `world-graph.ts` force-directed algorithm
- Room labels, population indicators preserved

### Phase 3: Entity Positioning
- Add entity nodes within room group nodes
- WebSocket broadcasts entity position updates
- Activity-driven visual states (glow, pulse, dim)
- Click entity → detail slide-in panel

### Phase 4: Interaction Arcs
- Animated edges between communicating entities
- Message arcs (pulse on send, fade after)
- Task delegation arcs (persistent while active)
- OD matrix toggle for aggregate flows

### Phase 5: Polish
- Smooth movement animations (entity room changes)
- Mini-map overlay
- Compass metrics bar
- Theme-aware arc colors
- Performance optimization (viewport culling)

### Technical Notes
- **ReactFlow** stays — it handles the node graph, grouping, viewport, zoom, pan
- **Entity nodes** are custom ReactFlow nodes (like existing canvas node types)
- **Room group nodes** use ReactFlow's built-in grouping
- **Arcs** use ReactFlow animated edges with custom styling
- **HUD panels** are positioned absolute over the ReactFlow viewport
- **WebSocket** extended to broadcast entity positions (server already tracks rooms)
- **Motion** handles smooth transitions between states

---

## Mockup Concepts

Three HTML mockups are provided in `design/canvas-map-mockups/`:

1. **`01-living-canvas.html`** — The primary vision: rooms as glowing regions, entities as positioned dots with activity states, interaction arcs pulsing between them, HUD panels overlaying

2. **`02-od-matrix.html`** — OD matrix overlay: aggregate flow visualization between rooms, particle animation along flow lines, room nodes sized by throughput

3. **`03-entity-focus.html`** — Entity detail view: click an entity to see expanded state, memory, activity, with the world dimmed behind. Progressive disclosure from map → entity → detail.

4. **`04-full-hud.html`** — The convergence proof: every existing dashboard panel mapped to its new home as a HUD overlay on the living canvas. Entity roster sidebar, expandable activity feed, contextual room detail, full coordination with tabs, admin panel (gear toggle), system metrics bar, chat. Nothing lost from the current dashboard — everything gained from spatial context.

All mockups use the H2O theme (black & gold) with pixel fonts (Press Start 2P, VT323, Orbitron), scanline overlay, and pixel grid to match the existing dashboard aesthetic.
