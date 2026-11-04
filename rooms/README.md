# Custom rooms

Drop `.ts` files here to extend the world without forking a world definition. Each file exports a `RoomModule` and is auto-loaded at boot by `src/world/room-loader.ts` when the selected world sets no `roomsDir` (see below). The room id is the file path relative to this directory, minus the extension.

```
rooms/hub/crossroads.ts   → room id "hub/crossroads"
rooms/lab/oracle.ts       → room id "lab/oracle"
rooms/_draft.ts           → ignored (leading underscore)
```

A minimal room:

```ts
import type { RoomModule } from "../src/types";

const room: RoomModule = {
  short: "The Library",
  long: "Quiet shelves stretch in every direction. A lectern stands at the center.",
  exits: {
    out: "hub/crossroads" as never,
  },
};

export default room;
```

See `worlds/showcase.ts` and `worlds/default/` for richer patterns: `onEnter` handlers, `onTick`, room-scoped storage via `ctx.store`, agent spawning via `ctx.spawnRoomAgent()`, intent system integration.

Files in this directory load on top of the world `MARINA_WORLD` selected, so a custom room can extend a built-in world without modifying it — but only for a world that sets no `roomsDir` (the default Workbench world, for example). A world that sets `roomsDir` loads that directory instead of this one: `showcase`, `research` and `commons` load `worlds/default/`, so rooms here are not loaded under them (`src/main.ts`, `loadRooms` in `src/world/room-loader.ts`). To extend such a world, add the room to its own `roomsDir` or to the world definition.
