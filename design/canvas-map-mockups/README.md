# Canvas-Map Convergence Mockups

Six HTML mockups produced during the canvas + world-map convergence work (see `docs/canvas-map-convergence.md` for the research brief that informed them). Kept for historical reference — these are static prototypes, not live components, and the dashboard has since evolved past several of the patterns shown.

## Files

| Mockup | Pattern explored |
|---|---|
| `01-living-canvas.html` | Continuous canvas with embedded room cells; "what if the canvas IS the map?" |
| `02-od-matrix.html` | Origin-destination matrix overlay — communication flows between rooms as glowing arcs |
| `03-entity-focus.html` | Per-entity focus panel; precursor to today's EntityRoster + EntityPanel expansion |
| `04-full-hud.html` | Mission-control HUD with every panel laid out at once |
| `05-dynamic.html` | Reactive layout — panels resize based on activity, not user drag |
| `06-tiled.html` | BSP-style focused layout — picked an entity / panel and the rest tile around it |

## What landed vs what didn't

- **Picked up** — the glass-panel visual language (everything), `EntityRoster` expansion model (#03), the BSP focused-layout template you can see in `App.tsx`'s `FOCUS_SLOTS_LG` (#06).
- **Not adopted** — the OD-matrix overlay (#02, the data engineering was too expensive for the value); the reactive layout (#05, lost to React Grid Layout's user-drag-first model).

These mockups are static HTML so they open standalone — no build step required.
