// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The TypeScript SDK's conformance driver: the reference every SDK's driver matches.
// The contract (scenarios, stdin/stdout lines, report fields) is protocol/conformance.md.
//
//   bun test/conformance/typescript.ts <scenario> <server url> '<args JSON>'

import { createInterface } from "node:readline";
import type { RunResult } from "../../src/sdk/coding";
import { composeCommand } from "../../src/sdk/command-forms";
import { Marina } from "../../src/sdk/marina";
import { retryMemoryOperation } from "../../src/sdk/memory-retry";
import type { Perception } from "../../src/sdk/protocol";

const [scenario = "", url = "", rawArgs = "{}"] = process.argv.slice(2);
const args = JSON.parse(rawArgs) as Record<string, unknown>;
const name = String(args.name ?? "tsdriver");
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
/** Tell the test we are waiting, then wait for its "go" line. */
async function ready(info: Record<string, unknown>): Promise<Record<string, unknown>> {
  say({ ready: info });
  const next = await lines.next();
  return next.done ? {} : ((JSON.parse(next.value) as { go?: Record<string, unknown> }).go ?? {});
}
const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return check();
};
/** The protocol's own field names, without empty fields. */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

const scenarios: Record<string, () => Promise<Record<string, unknown>>> = {
  async coding() {
    const marina = await Marina.connect(url, { name });
    await ready({ entity: marina.session.entityId });
    const frames: Perception[] = [];
    marina.onEvent((f) => {
      if (f.data?.code) frames.push(f);
    });
    const run = await marina.code.run(String(args.task), {
      verification: "candidate",
      timeoutMs: 120_000,
    });
    const events = [];
    for await (const e of run.events) events.push(e);
    const result: RunResult = await run.result;
    const report = {
      run_id: run.runId,
      result: { ...(result as unknown as Record<string, unknown>) },
      typed_result: wire({ ...result }),
      submitted: result.outcome === "submitted",
      summary: result.summary,
      steps: events.flatMap((e) => (e.activity ? [wire(e.activity)] : [])),
      last_event_run: events.at(-1)?.result?.runId ?? null,
      diff: await marina.code.diff(),
      frames,
    };
    await marina.code.review(result.runId, "approve");
    await marina.close();
    return report;
  },

  async commands() {
    const marina = await Marina.connect(url, { name });
    const look = (await marina.command("look")).map((p) => p.data.text).join("\n");
    let refused = "";
    await marina.command("frobnicate the moon").catch((e: Error) => {
      refused = e.message;
    });
    const manifest = await marina.capabilities();
    const sayEntry = manifest.commands.find((c) => c.name === "say");
    const form = sayEntry?.forms?.find((f) => f.syntax.startsWith("say "));
    if (!form) throw new Error("no say form");
    const field = form.fields.find((f) => f.label === "message") ?? form.fields[0]!;
    const missing = composeCommand(form, {}, {});
    const composed = composeCommand(form, { [field.id]: `hello from ${name}` }, {});
    const said = (await marina.command(composed.command)).map((p) => p.data.text).join("\n");
    await marina.close();
    return {
      look,
      refused,
      capability_count: manifest.commands.length,
      composed: composed.command,
      missing_errors: Object.keys(missing.errors).length,
      said,
    };
  },

  async reconnect() {
    const marina = await Marina.connect(url, { name });
    const { entityId, token } = marina.session;
    let reconnects = 0;
    marina.client.on("connect", () => reconnects++);
    await ready({ entity: entityId });
    const back = await until(() => reconnects > 0 && marina.client.isConnected(), 30_000);
    const look = back ? (await marina.command("look")).length > 0 : false;
    const report = {
      reconnected: back,
      same_entity: marina.session.entityId === entityId,
      token_changed: marina.session.token !== token,
      look_ok: look,
    };
    await marina.close();
    return report;
  },

  async agent() {
    const marina = await Marina.connect(url, { name });
    const peer = String(args.peer);
    const reply = await marina.client.tellAndAwait(peer, "ping", 15_000);
    await ready({ listening: true });
    const heard = await marina.client.waitForTell(peer, 15_000);
    await marina.client.tell(peer, `answer: ${heard}`);
    await marina.close();
    return { reply, heard };
  },

  async memory() {
    const marina = await Marina.connect(url, { name });
    const memory = marina.memory(String(args.credential));
    const space = (await memory.createSpace(`${name}-space`)).id;
    const first = await memory.remember(space, { content: "Deploys run from main" }, "conf-1");
    const again = await memory.remember(space, { content: "Deploys run from main" }, "conf-1");
    const record = await memory.get(space, first.id);
    const found = await memory.search(space, { query: "deploy" });
    let waits = 0;
    const count = Number(args.burst ?? 140);
    for (let i = 0; i < count; i++)
      await retryMemoryOperation(() => memory.remember(space, { content: `note ${i}` }), {
        sleep: (ms) => {
          waits++;
          return new Promise((r) => setTimeout(r, ms));
        },
      });
    await marina.close();
    return {
      space,
      receipt_id: first.id,
      replayed: first.id === again.id && first.version === again.version,
      content: record.content,
      found: JSON.stringify(found).includes("Deploys run from main"),
      written: count,
      rate_limit_waits: waits,
    };
  },

  async panels() {
    const marina = await Marina.connect(url, { name });
    const seen: { type: string; canvasId?: string }[] = [];
    let snapshot = false;
    const stop = marina.panels.watchChanges(
      (event) => seen.push(event),
      () => {
        snapshot = true;
      },
    );
    await until(() => snapshot, 10_000);
    await marina.command(`canvas create ${name}board`);
    await marina.command(`canvas post on:${name}board hello from ${name}`);
    const got = await until(() => seen.some((e) => e.canvasId), 10_000);
    stop();
    await marina.close();
    return { snapshot, got_canvas_event: got, event_types: [...new Set(seen.map((e) => e.type))] };
  },

  async routing() {
    const marina = await Marina.connect(url, { name });
    const routing = marina.routing;
    const a = await routing.join({ clientKey: `${name}-a`, label: "A", kind: "service" });
    const b = await routing.join({ clientKey: `${name}-b`, label: "B", kind: "service" });
    await routing.publish(a.id, [{ id: "e1", kind: "output", payload: { text: "hello" } }]);
    const sent = await routing.send(a.id, {
      clientMessageId: "m1",
      targetId: b.id,
      kind: "note",
      payload: "hi",
    });
    const inbox = await routing.inbox(b.id);
    await routing.acknowledge(b.id, sent.id);
    const events = await routing.events(a.id);
    await marina.close();
    return {
      session_a: a.id,
      inbox_has_message: JSON.stringify(inbox).includes(sent.id),
      published: JSON.stringify(events).includes("hello"),
    };
  },

  async local() {
    const marina = await Marina.local(String(args.folder), {
      fresh: true,
      command: args.command as string[],
    });
    const pid = (
      (await (await fetch(`${marina.httpUrl}/api/setup-status`)).json()) as { pid: number }
    ).pid;
    let refused = "";
    await marina.code.run("Add a README").catch((e: Error) => {
      refused = e.message;
    });
    const look = (await marina.command("look")).length > 0;
    const name = marina.session.name;
    await marina.close();
    let stopped = true;
    try {
      process.kill(pid, 0);
      stopped = false;
    } catch {
      // allow-empty-catch: gone, as expected
    }
    let missing = "";
    await Marina.local(`${String(args.folder)}/missing`, {
      command: args.command as string[],
    }).catch((e: Error) => {
      missing = e.message;
    });
    return { name, refused, look, stopped, missing };
  },
};

const run = scenarios[scenario];
if (!run) {
  say({ error: `unknown scenario ${scenario}` });
  process.exit(1);
}
run().then(
  (report) => {
    say({ report });
    process.exit(0);
  },
  (error: Error) => {
    say({ error: error.stack ?? String(error) });
    process.exit(1);
  },
);
