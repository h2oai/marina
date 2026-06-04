# Marina Use Case UI

Standalone React example surfaces for Marina:

- Search: calls `POST /api/ask`
- Deep Research: calls `POST /api/command` with `usecase research <topic>`
- Predict: calls `POST /api/command` with `usecase predict <question>`

The UI is intentionally only a renderer and launch surface. Behavior remains in
Marina words, commands, memory, rooms, tasks, pools, and agents.

## Run

Start the Marina server from the repo root:

```bash
bun run start
```

Then in a second terminal, install the example's dependencies (first time only) and start its dev server:

```bash
cd examples/usecase-ui
bun install
bun run dev
```

Open:

```text
http://localhost:5174
```

The dev server proxies `/api/*` to `http://localhost:3300`.

If Marina is running on another port:

```bash
MARINA_HTTP_URL=http://localhost:18300 bun run dev
```
