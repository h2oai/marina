# Custom rooms

Drop `.ts` files here to extend the world without forking a world definition. Each file exports a `RoomModule` and is auto-loaded at boot by `src/world/room-loader.ts`. The room id is the file path relative to this directory, minus the extension.

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

Files in this directory load on top of whatever world `MARINA_WORLD` selected, so a custom room can extend a built-in world without modifying it.
