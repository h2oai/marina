/** Bounded reconnect soak with rotating session-token verification. */
const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, "").split("=");
  if (key && value) args.set(key, value);
}

const clients = Number(args.get("clients") ?? 10);
const cycles = Number(args.get("cycles") ?? 10);
const url = args.get("url") ?? "ws://localhost:3300";
const maxErrors = Number(args.get("max-errors") ?? 0);
const maxP95 = Number(args.get("max-p95") ?? 2_000);
if (![clients, cycles, maxErrors, maxP95].every(Number.isFinite) || clients < 1 || cycles < 1) {
  throw new Error("Invalid churn parameters");
}

const latencies: number[] = [];
let errors = 0;
let reconnects = 0;

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * (percentileValue / 100)) - 1)]!;
}

async function connectCycle(name: string, token?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = new WebSocket(`${url}/ws`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("cycle timeout"));
    }, 10_000);
    let nextToken = token;
    let authenticated = false;
    let commandSent = false;

    socket.onopen = () => {
      socket.send(JSON.stringify(token ? { type: "auth", token } : { type: "login", name }));
    };
    socket.onmessage = (event) => {
      const perception = JSON.parse(String(event.data)) as {
        kind?: string;
        data?: { entityId?: string; token?: string; text?: string };
      };
      if (!authenticated && perception.kind === "system" && perception.data?.entityId) {
        authenticated = true;
        nextToken = perception.data.token;
        socket.send(JSON.stringify({ type: "command", command: "who" }));
        commandSent = true;
        return;
      }
      if (authenticated && commandSent) {
        clearTimeout(timeout);
        latencies.push(performance.now() - started);
        socket.close();
        if (!nextToken) reject(new Error("missing rotated session token"));
        else resolve(nextToken);
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error"));
    };
  });
}

async function runClient(index: number): Promise<void> {
  let token: string | undefined;
  for (let cycle = 0; cycle < cycles; cycle++) {
    try {
      token = await connectCycle(`Churn_${index}`, token);
      if (cycle > 0) reconnects++;
    } catch {
      errors++;
      token = undefined;
    }
    await Bun.sleep(25);
  }
}

await Promise.all(Array.from({ length: clients }, (_, index) => runClient(index)));
const p95 = percentile(latencies, 95);
const expectedReconnects = clients * Math.max(0, cycles - 1);
const failures: string[] = [];
if (errors > maxErrors) failures.push(`errors ${errors} > ${maxErrors}`);
if (reconnects !== expectedReconnects) {
  failures.push(`reconnects ${reconnects}/${expectedReconnects}`);
}
if (p95 > maxP95) failures.push(`p95 ${p95.toFixed(1)}ms > ${maxP95}ms`);
console.log(
  JSON.stringify({
    qualified: failures.length === 0,
    target: url,
    clients,
    cycles,
    reconnects,
    errors,
    p95Ms: Number(p95.toFixed(1)),
    failures,
  }),
);
await Bun.sleep(50);
process.exit(failures.length > 0 ? 1 : 0);
