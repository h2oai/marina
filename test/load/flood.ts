/**
 * Load test: spawn N concurrent WebSocket connections, each sending commands.
 *
 * Usage:
 *   bun run test/load/flood.ts --connections=50 --duration=30 --rate=2
 *
 * Options:
 *   --connections  Number of concurrent connections (default: 50)
 *   --duration     Test duration in seconds (default: 30)
 *   --rate         Commands per second per connection (default: 2)
 *   --url          WebSocket server URL (default: ws://localhost:3300)
 */

const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const [key, val] = arg.replace(/^--/, "").split("=");
  if (key && val) args.set(key, val);
}

const CONNECTIONS = Number(args.get("connections") ?? 50);
const DURATION_S = Number(args.get("duration") ?? 30);
const RATE = Number(args.get("rate") ?? 2);
const WS_URL = args.get("url") ?? "ws://localhost:3300";

const COMMANDS = ["look", "who", "help", "inventory", "north", "south", "east", "west"];

interface Stats {
  connected: number;
  commands: number;
  responses: number;
  errors: number;
  roundTripTimes: number[];
  connectTimes: number[];
}

const stats: Stats = {
  connected: 0,
  commands: 0,
  responses: 0,
  errors: 0,
  roundTripTimes: [],
  connectTimes: [],
};

async function spawnClient(id: number): Promise<void> {
  const connectStart = performance.now();

  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}/ws`);
    let entityId: string | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let pendingSendTime: number | null = null;
    const name = `LoadBot_${id}`;

    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, DURATION_S * 1000);

    ws.onopen = () => {
      stats.connectTimes.push(performance.now() - connectStart);
      stats.connected++;
      ws.send(JSON.stringify({ type: "login", name }));
    };

    ws.onmessage = (event) => {
      try {
        const p = JSON.parse(event.data as string);

        // Track round-trip time for command responses
        if (pendingSendTime !== null) {
          stats.roundTripTimes.push(performance.now() - pendingSendTime);
          stats.responses++;
          pendingSendTime = null;
        }

        if (p.data?.entityId && !entityId) {
          entityId = p.data.entityId;
          // Start sending commands
          const delayMs = 1000 / RATE;
          interval = setInterval(() => {
            const cmd = COMMANDS[Math.floor(Math.random() * COMMANDS.length)]!;
            pendingSendTime = performance.now();
            ws.send(JSON.stringify({ type: "command", command: cmd }));
            stats.commands++;
          }, delayMs);
        }
      } catch {
        stats.errors++;
      }
    };

    ws.onerror = () => {
      stats.errors++;
    };

    ws.onclose = () => {
      if (interval) clearInterval(interval);
      clearTimeout(timeout);
      resolve();
    };
  });
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * (p / 100)) - 1;
  return sorted[Math.max(0, idx)]!;
}

async function main() {
  console.log(`Load test: ${CONNECTIONS} connections, ${DURATION_S}s, ${RATE} cmd/s each`);
  console.log(`Target: ${WS_URL}\n`);

  const startTime = performance.now();

  // Spawn all connections
  const clients = Array.from({ length: CONNECTIONS }, (_, i) => spawnClient(i));
  await Promise.all(clients);

  const elapsed = (performance.now() - startTime) / 1000;

  // Fetch server-side metrics if available
  let serverMemory = "";
  try {
    const httpUrl = WS_URL.replace("ws://", "http://").replace(/\/ws$/, "");
    const resp = await fetch(`${httpUrl}/dashboard`);
    if (resp.ok) {
      const data = (await resp.json()) as {
        memory?: { heapUsed?: number; rss?: number };
      };
      if (data.memory) {
        const heapMB = ((data.memory.heapUsed ?? 0) / 1024 / 1024).toFixed(1);
        const rssMB = ((data.memory.rss ?? 0) / 1024 / 1024).toFixed(1);
        serverMemory = `  Server heap: ${heapMB}MB, RSS: ${rssMB}MB`;
      }
    }
  } catch {}

  console.log("─── Results ───────────────────────────────────────");
  console.log(`Duration:          ${elapsed.toFixed(1)}s`);
  console.log(`Connections:       ${stats.connected}/${CONNECTIONS}`);
  console.log(`Total commands:    ${stats.commands}`);
  console.log(`Total responses:   ${stats.responses}`);
  console.log(`Errors:            ${stats.errors}`);
  console.log(`Throughput:        ${(stats.commands / elapsed).toFixed(1)} cmd/s`);
  console.log("");
  console.log(`Connect time p50:  ${percentile(stats.connectTimes, 50).toFixed(1)}ms`);
  console.log(`Connect time p95:  ${percentile(stats.connectTimes, 95).toFixed(1)}ms`);
  console.log(`Connect time p99:  ${percentile(stats.connectTimes, 99).toFixed(1)}ms`);
  console.log("");
  console.log(`Round-trip p50:    ${percentile(stats.roundTripTimes, 50).toFixed(1)}ms`);
  console.log(`Round-trip p95:    ${percentile(stats.roundTripTimes, 95).toFixed(1)}ms`);
  console.log(`Round-trip p99:    ${percentile(stats.roundTripTimes, 99).toFixed(1)}ms`);
  console.log("");
  console.log(`Client memory:     ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`);
  if (serverMemory) console.log(serverMemory);
}

main().catch(console.error);
