// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Peer reply loops, end to end without a model: simulated members run the
 * real attention (`assessPerception`), the real reply ledger
 * (`OutstandingRequests`), the real outgoing acknowledgement refusal and the
 * real `tell` delivery (`deliverTell` over an in-memory `MarinaDB`, which
 * stamps the envelope depth). Only the model is replaced: a policy that
 * writes the reply text.
 *
 * Regression for the 2026-10-21 answerer crew run, where two Answerers traded
 * "[re:mapping] terminal, no reply needed" tells without bound: the echoed
 * thread tag made every closing line a request, so each one owed the next.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { declinesReply, outgoingAcknowledgementRefusal } from "../src/agent/acknowledgement";
import {
  type AttentionDecision,
  type AttentionState,
  assessPerception,
  createAttentionState,
  rememberThreadTags,
} from "../src/agent/attention";
import { type OutstandingRequest, OutstandingRequests } from "../src/agent/outstanding-requests";
import { flattenPeerText } from "../src/agent/peer-text";
import { SocialAwareness } from "../src/agent/social";
import { deliverTell, type TellDeps } from "../src/engine/commands/tell";
import { stripAnsi } from "../src/net/ansi";
import { MarinaDB } from "../src/persistence/database";
import {
  type Entity,
  type EntityId,
  entityId,
  type Perception,
  type RoomContext,
} from "../src/types";

/** What the stand-in model writes for one owed request (undefined = stays silent). */
type ReplyPolicy = (request: OutstandingRequest, member: Member) => string | undefined;
/** What it writes, unprompted, to a message that woke it but owes nothing. */
type ChatPolicy = (decision: AttentionDecision, from: string, member: Member) => string | undefined;

class Member {
  readonly attention: AttentionState = createAttentionState();
  readonly social = new SocialAwareness();
  readonly ledger = new OutstandingRequests();
  readonly inbox: Perception[] = [];
  /** Kept decisions, in arrival order (for assertions). */
  readonly decisions: Array<{ from: string; decision: AttentionDecision }> = [];
  private seq = 0;
  /** Messages that woke this member but owed nothing, awaiting a voluntary reply. */
  private woken: Array<{ from: string; decision: AttentionDecision }> = [];

  constructor(
    readonly entity: Entity,
    readonly world: World,
    readonly reply: ReplyPolicy,
    readonly chat?: ChatPolicy,
    readonly peerReplyDepth = 6,
  ) {}

  get name(): string {
    return this.entity.name;
  }

  /** The adapter's perception handler, minus buffering and prompting. */
  perceive(p: Perception): void {
    const text = flattenPeerText(stripAnsi(String(p.data.text ?? p.data.message ?? "")));
    const events = this.social.handlePerception(p);
    const decision = assessPerception(
      {
        perception: p,
        text,
        selfName: this.name,
        events,
        scorer: this.social,
        nudgeMode: "requests",
        peerReplyDepth: this.peerReplyDepth,
      },
      { mode: "balanced", threshold: 50 },
      this.attention,
    );
    if (decision.releasePeer) this.ledger.complete(this.ledger.idsForPeer(decision.releasePeer));
    if (!decision.keep) return;
    const from = String(p.data.senderName ?? "");
    this.decisions.push({ from, decision });
    if (decision.owed) {
      const tracked = this.ledger.track(p, ++this.seq, text);
      if (tracked) this.ledger.present(tracked.id);
    } else if (decision.wake === "now") {
      this.woken.push({ from, decision });
    }
  }

  /** One model turn: answer what is owed (echoing its tag, as the harness asks), then chat. */
  turn(): number {
    let sent = 0;
    for (const p of this.inbox.splice(0)) this.perceive(p);
    for (const request of this.ledger.entries()) {
      const body = this.reply(request, this);
      if (body === undefined) continue;
      const tag = request.correlation ? ` [re:${request.correlation}]` : "";
      if (this.send(request.speaker ?? request.target, `${body}${tag}`)) sent++;
    }
    for (const { decision, from } of this.woken.splice(0)) {
      const body = this.chat?.(decision, from, this);
      if (body !== undefined && this.send(from, body)) sent++;
    }
    return sent;
  }

  /** A `marina_tell`: the adapter's before-tool-call refusal, then the world's `tell`. */
  send(target: string, message: string): boolean {
    const owedTargets = new Set(this.ledger.entries().map((r) => r.target.toLowerCase()));
    const args = { target, message };
    if (outgoingAcknowledgementRefusal("marina_tell", args, owedTargets)) return false;
    rememberThreadTags(this.attention, message);
    const id = this.world.tell(this, target, message);
    if (id === undefined) return false;
    // The server's delivery receipt settles the reply it answers.
    const eligible = new Set(this.ledger.entries().map((r) => r.id));
    this.ledger.settle({ deliveries: [{ kind: "tell", target, message }] }, eligible);
    return true;
  }
}

class World {
  readonly db = new MarinaDB(":memory:");
  readonly members = new Map<string, Member>();
  readonly people = new Map<string, Entity>();
  /** Every tell delivered, in order. */
  readonly log: Array<{ from: string; to: string; message: string; depth: number }> = [];

  private entity(name: string): Entity {
    return {
      id: entityId(`e_${name.toLowerCase()}`),
      name,
      short: name,
      long: name,
      properties: {},
    } as unknown as Entity;
  }

  add(name: string, reply: ReplyPolicy, chat?: ChatPolicy, peerReplyDepth?: number): Member {
    const member = new Member(this.entity(name), this, reply, chat, peerReplyDepth);
    this.members.set(name.toLowerCase(), member);
    return member;
  }

  person(name: string): Entity {
    const e = this.entity(name);
    this.people.set(name.toLowerCase(), e);
    return e;
  }

  private byId(id: EntityId): { entity: Entity; member?: Member } | undefined {
    for (const m of this.members.values())
      if (m.entity.id === id) return { entity: m.entity, member: m };
    for (const e of this.people.values()) if (e.id === id) return { entity: e };
    return undefined;
  }

  private deps(): TellDeps {
    return {
      getEntity: (id) => this.byId(id)?.entity,
      findEntityGlobal: (name) => {
        const e =
          this.members.get(name.toLowerCase())?.entity ?? this.people.get(name.toLowerCase());
        return e ? { id: e.id, name: e.name } : undefined;
      },
      sendGlobal: (target, message, _senderId, tag, metadata) => {
        const to = this.byId(target);
        const p: Perception = {
          kind: "message",
          timestamp: Date.now(),
          ...(tag ? { tag } : {}),
          data: { text: stripAnsi(message), ...metadata },
        };
        to?.member?.inbox.push(p);
        this.log.push({
          from: String(metadata?.senderName),
          to: String(metadata?.to),
          message: String(metadata?.message),
          depth: Number(metadata?.depth ?? 0),
        });
      },
      db: this.db,
      isAgent: (id) => !!this.byId(id)?.member,
    };
  }

  /** The sender's own receipt (`You tell X: …`, `delivery`) comes back as a perception. */
  private ctxFor(sender?: Member): RoomContext {
    return {
      send: (
        _target: EntityId,
        message: string,
        tag?: string,
        metadata?: Record<string, unknown>,
      ) => {
        sender?.inbox.push({
          kind: "message",
          timestamp: Date.now(),
          ...(tag ? { tag } : {}),
          data: { text: stripAnsi(message), ...metadata },
        });
      },
    } as unknown as RoomContext;
  }

  tell(from: Member | Entity, to: string, message: string): number | undefined {
    const sender = from instanceof Member ? from : undefined;
    const entity = from instanceof Member ? from.entity : from;
    return deliverTell(this.deps(), this.ctxFor(sender), entity.id, entity, to, message);
  }

  /** Give every member turns until nobody sends anything (or `maxRounds`). */
  run(maxRounds = 40): number {
    let rounds = 0;
    for (; rounds < maxRounds; rounds++) {
      let sent = 0;
      for (const member of this.members.values()) sent += member.turn();
      if (sent === 0 && [...this.members.values()].every((m) => m.inbox.length === 0)) break;
    }
    return rounds;
  }

  between(a: string, b: string) {
    const pair = new Set([a.toLowerCase(), b.toLowerCase()]);
    return this.log.filter((t) => pair.has(t.from.toLowerCase()) && pair.has(t.to.toLowerCase()));
  }
}

let n = 0;
/** The closing line the Answerers kept sending (evidence #105/#126), made unique per call. */
const closingLine: ReplyPolicy = (_r, m) =>
  `Acknowledged terminal; ${m.name} queue clear, serving own target only, no reply needed (${++n}).`;
/** A model that answers every owed request with a substantive line. */
const answers: ReplyPolicy = () => `Paris — verified against two sources (${++n}).`;

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(() => world.db.close());

describe("acknowledgement loops between two agents", () => {
  it("a terminal 'no reply needed' line owes nothing, even under a thread tag", () => {
    const a3 = world.add("Answerer3", closingLine);
    const a4 = world.add("Answerer4", closingLine);
    // Answerer4 opened the [re:mapping] thread earlier; Answerer3 knows the tag.
    rememberThreadTags(a3.attention, "[re:mapping]");
    rememberThreadTags(a4.attention, "[re:mapping]");
    world.tell(
      a4,
      "Answerer3",
      "[re:mapping] Closing — do not reply further; this is terminal from me. Standing state only: e_4 queue clear.",
    );
    world.run();
    expect(world.between("Answerer3", "Answerer4")).toHaveLength(1);
    expect(a3.ledger.size).toBe(0);
  });

  it("two members exchanging acknowledgements stop after at most one exchange", () => {
    world.add("Answerer3", closingLine);
    const a4 = world.add("Answerer4", closingLine);
    // Worst case: the thread opens with a FRESH tag on a message that does owe
    // a reply, and both models answer every owed request with a closing line
    // that echoes the tag (as the "[Reply still owed — … with [re:mapping]]"
    // section tells them to).
    a4.send("Answerer3", "Map settled: e_3 = you, e_4 = me. Confirm the map [re:mapping]");
    world.run();
    const thread = world.between("Answerer3", "Answerer4");
    // The ask, then exactly one reply; the reply owes nothing back.
    expect(thread.map((t) => t.from)).toEqual(["Answerer4", "Answerer3"]);
    expect(thread[1]!.message).toContain("[re:mapping]");
    for (const m of world.members.values()) expect(m.ledger.size).toBe(0);
  });

  it("replays the 2026-10-21 closing lines: none owes a reply once the tag is the thread's", () => {
    // Bodies from the aborted FRAMES crew run (direct_messages #101–#178).
    const lines = [
      '[re:mapping] Closed from my side too — no reply needed after this. Only non-echo state: any e_1-target candidate goes by tell to bare "Answerer" (e_1\'s holder). e_4 queue clear.',
      '[re:mapping] Acknowledged and closed: e_3-only guard matches; e_1 held by bare "Answerer"; no unheld queues remain. Nothing further from me.',
      "[re:mapping] Closing — do not reply further; this is terminal from me. Standing state only: e_4 queue clear; non-own candidates go by tell to the target's holder.",
      "[re:mapping] Acknowledged terminal; e_3 queue clear, serving e_3 only.",
      "[re:mapping] Terminal — no content beyond standing state: e_4 queue clear, serving e_4 only. No reply needed; thread ends here.",
      "[re:mapping] Thread closed on my side too; e_3 queue clear, serving e_3 only.",
      "[re:mapping] RESOLVED — this thread is closed. Do not send further [re:mapping] acks; the exchange is complete and repeated closures only re-trigger each side's reply gate.",
      "[re:mapping] cannot — thread already closed; no reply due.",
      "[re:mapping] Ack-only, no reply owed. Nothing from me pending on any target; I serve e_4 only and hold no unanswered request. Do not reply.",
      "[re:mapping] Latch only — e_3 queue clear, thread closed, no reply due. [re:mapping]",
      "[re:mapping] Gate artifact; no reply due. e_4 queue clear (req-b94efe21 served). No further [re:mapping] replies.",
      "[re:gw8dlt] Concur — thread closed, map final (e_1=Answerer bare, e_2=you/Answerer2, e_3=Answerer3, e_4=me).",
      "[re:gw8dlt] Agreed: ownership follows the request's target id; e_1 mine, e_4 yours. No further action. [re:gw8dlt]",
    ];
    const state = createAttentionState();
    rememberThreadTags(state, "[re:mapping] [re:gw8dlt]");
    for (const body of lines) {
      const decision = assessPerception(
        {
          perception: {
            kind: "message",
            timestamp: 1,
            tag: "tell",
            data: { senderName: "Answerer4", message: body, text: `Answerer4 tells you: ${body}` },
          },
          text: `Answerer4 tells you: ${body}`,
          selfName: "Answerer3",
          events: [],
          scorer: { scorePerception: () => 100, shouldRespond: () => true },
          nudgeMode: "requests",
        },
        { mode: "balanced", threshold: 50 },
        state,
      );
      expect({ body, owed: decision.owed }).toEqual({ body, owed: false });
    }
  });

  it("a peer's 'no reply needed' releases the replies still owed to that peer", () => {
    const b = world.add("Bea", () => undefined); // silent: the ask stays owed
    world.add("Ada", () => undefined);
    world.tell(world.members.get("ada")!, "Bea", "Can you check the e_3 queue?");
    b.turn();
    expect(b.ledger.size).toBe(1);
    world.tell(world.members.get("ada")!, "Bea", "Never mind, found it myself — no reply needed.");
    b.turn();
    expect(b.ledger.size).toBe(0);
  });
});

describe("real collaboration still works", () => {
  it("a peer's genuine question gets exactly one reply", () => {
    const ada = world.add("Ada", answers);
    world.add("Bea", answers);
    ada.send("Bea", "What is the capital of France?");
    world.run();
    const thread = world.between("Ada", "Bea");
    expect(thread.map((t) => t.from)).toEqual(["Ada", "Bea"]);
    expect(thread[1]!.depth).toBe(1);
  });

  it("a tellAndAwait-style tagged ask gets one tagged reply, which owes the asker nothing", () => {
    const ada = world.add("Ada", answers);
    const bea = world.add("Bea", answers);
    ada.send("Bea", "What is the capital of France? [re:ab12cd]");
    world.run();
    const thread = world.between("Ada", "Bea");
    expect(thread).toHaveLength(2);
    expect(thread[1]!.message).toEndWith("[re:ab12cd]");
    // The asker read the answer as information, not a new ask.
    const last = ada.decisions.at(-1)!.decision;
    expect(last.owed).toBe(false);
    expect(last.reason).toBe("information");
    expect(bea.ledger.size).toBe(0);
  });

  it("a follow-up question inside a known thread is still a request", () => {
    world.add("Ada", () => undefined);
    const bea = world.add("Bea", () => undefined);
    rememberThreadTags(bea.attention, "[re:ab12cd]");
    world.tell(world.members.get("ada")!, "Bea", "[re:ab12cd] Thanks. Which source did you use?");
    bea.turn();
    expect(bea.ledger.size).toBe(1);
  });
});

describe("the depth bound on agent-only reply chains", () => {
  /** Two chatty agents: each owed request and each message that wakes them gets a substantive reply. */
  const chatty: ChatPolicy = (_d, _from, m) =>
    `Noting e_${++n} for ${m.name}: the second source agrees (${n}).`;
  const asks: ReplyPolicy = (_r, m) => `${m.name} here — which source did you use for item ${++n}?`;

  it("a chain of genuine-looking questions between two agents stops at the depth limit", () => {
    const ada = world.add("Ada", asks, chatty, 4);
    world.add("Bea", asks, chatty, 4);
    ada.send("Bea", "Which year did Chelsea last win the UCL?");
    world.run();
    const thread = world.between("Ada", "Bea");
    // Depths 0..4 are delivered; the depth-4 tell owes nothing and wakes no one.
    expect(thread.map((t) => t.depth)).toEqual([0, 1, 2, 3, 4]);
    const deepest = [...world.members.values()]
      .flatMap((m) => m.decisions)
      .find((d) => d.decision.reason === "depth-limit");
    expect(deepest?.decision.owed).toBe(false);
    expect(deepest?.decision.wake).toBe("next");
  });

  it("the default limit bounds a chain that never reads as an acknowledgement", () => {
    const ada = world.add("Ada", asks, chatty);
    world.add("Bea", asks, chatty);
    ada.send("Bea", "Which year did Chelsea last win the UCL?");
    world.run(100);
    expect(world.between("Ada", "Bea")).toHaveLength(7); // depths 0..6
  });

  it("MARINA_PEER_REPLY_DEPTH=0 turns the bound off (the chain runs to the round cap)", () => {
    const ada = world.add("Ada", asks, chatty, 0);
    world.add("Bea", asks, chatty, 0);
    ada.send("Bea", "Which year did Chelsea last win the UCL?");
    world.run(12);
    expect(world.between("Ada", "Bea").length).toBeGreaterThan(7);
  });
});

describe("a person's message is unaffected", () => {
  it("a person keeps getting answers however long the conversation runs", () => {
    const bea = world.add("Bea", answers, undefined, 2);
    const jeff = world.person("Jeff");
    for (let i = 0; i < 6; i++) {
      world.tell(jeff, "Bea", `Question ${i}: which source backs item ${i}?`);
      world.run();
    }
    const fromJeff = world.log.filter((t) => t.from === "Jeff");
    const toJeff = world.log.filter((t) => t.to === "Jeff");
    expect(fromJeff.every((t) => t.depth === 0)).toBe(true);
    expect(toJeff).toHaveLength(6);
    expect(bea.decisions.filter((d) => d.from === "Jeff").every((d) => d.decision.owed)).toBe(true);
  });

  it("a person's 'no reply needed' line owes nothing, but their question still does", () => {
    const bea = world.add("Bea", () => undefined);
    const jeff = world.person("Jeff");
    world.tell(jeff, "Bea", "FYI the run finished, no reply needed.");
    world.tell(jeff, "Bea", "Did the run finish?");
    bea.turn();
    expect(bea.decisions.map((d) => d.decision.owed)).toEqual([false, true]);
  });
});

describe("declinesReply", () => {
  it.each([
    "No reply needed.",
    "Terminal — thread closed, no reply due, no content.",
    "Do not reply; this is terminal from me.",
    "Ack-only, no reply owed.",
    "Do not send further acks.",
    "Nothing owed either way.",
  ])("declines: %s", (m) => expect(declinesReply(m)).toBe(true));

  it.each([
    "No reply needed unless you disagree — do you?",
    "Which source did you use?",
    "Reply when the queue is clear.",
    "",
  ])("does not decline: %s", (m) => expect(declinesReply(m)).toBe(false));
});
