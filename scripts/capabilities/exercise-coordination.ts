// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseCoordination(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check(
    "tell CleanWorker ttl:30s qa-direct-message-941",
    /CleanWorker|941/,
    ["tell <entity> "],
    "SELECT id FROM direct_messages WHERE content='qa-direct-message-941'",
  );
  const dm = value("SELECT id FROM direct_messages WHERE content='qa-direct-message-941'");
  await check("tell inbox", /qa-direct-message-941/, ["tell inbox"], undefined, "worker");
  await check(
    `tell ack ${dm}`,
    /acknowledged|ack/i,
    ["tell ack "],
    `SELECT id FROM direct_messages WHERE id=${dm} AND status='acknowledged'`,
    "worker",
  );
  await check(`tell status ${dm}`, /acknowledged/, ["tell status "]);
  await check(
    "re qa-reply-942",
    /CleanOwner|942/,
    ["re <message>"],
    "SELECT id FROM direct_messages WHERE content='qa-reply-942'",
    "worker",
  );
  await check(
    `re #${dm} qa-explicit-reply-943`,
    /CleanOwner|943/,
    ["re #"],
    "SELECT id FROM direct_messages WHERE content='qa-explicit-reply-943'",
    "worker",
  );
  for (const [input, pattern, selectors] of [
    ["say qa-say-944", /qa-say-944/, ["say "]],
    ["emote checks the qualification ledger", /checks the qualification ledger/, ["emote "]],
    ["shout qa-shout-945", /qa-shout-945/, ["shout "]],
    ["who", /CleanWorker/, ["who"]],
    ["who watch CleanWorker idle once", /CleanWorker|watch/i, ["who watch <name> "]],
    ["who watch", /CleanWorker/i, ["who watch"]],
    ["who watch CleanWorker off", /off|removed|stop|unwatch/i, ["who watch <name> off"]],
    ["brief watch 60", /watch|subscrib|brief/i, ["brief watch "]],
    ["brief unwatch", /watch|unsubscrib|brief/i, ["brief unwatch"]],
    ["brief", /CleanOwner|task|world|World|Void/, ["brief"]],
    ["brief full", /CleanOwner|task|world|World|Void/, ["brief full"]],
    ["brief social", /CleanWorker|social|Social/, ["brief social"]],
    ["observe CleanWorker", /CleanWorker/, ["observe <entity>"]],
    ["observe log CleanWorker", /CleanWorker|activity|events/i, ["observe log "]],
    ["observe stats", /command|entity|active|stats/i, ["observe stats"]],
    ["channel list", /cleanroom/, ["channel list", "channel list <name> [args]"]],
    ["channel listall", /cleanroom/, ["channel listall", "channel listall <name> [args]"]],
    ["ignore CleanWorker", /ignor/i, ["ignore <name>"]],
    ["ignore list", /CleanWorker/, ["ignore list"]],
    ["ignore remove CleanWorker", /removed|no longer|unignor/i, ["ignore remove "]],
    ["rank", /rank|Newcomer/i, ["rank"]],
    ["rank CleanWorker", /rank|Newcomer/i, ["rank <entity>"]],
    ["standing", /standing|Standing/, ["standing"]],
    ["standing show CleanWorker", /CleanWorker/, ["standing show ", "standing <name>"]],
    ["standing top 10", /CleanWorker|CleanOwner/, ["standing top "]],
    ["productivity", /productivity|Productivity|primitive/i, ["productivity"]],
    ["productivity agent CleanWorker", /CleanWorker/, ["productivity agent "]],
    ["productivity leaderboard", /CleanWorker|CleanOwner/, ["productivity leaderboard"]],
    ["productivity primitives CleanWorker", /task|CleanWorker/, ["productivity primitives "]],
    ["productivity prompts", /prompt|Prompt|Productivity Outcomes/, ["productivity prompts"]],
    ["productivity trend", /Productivity Outcomes/, ["productivity trend"]],
    [
      "competence mine",
      /task|competence|evidence/i,
      ["competence mine ", "competence [<family prefix>]"],
    ],
    ["competence judged", /judged|evidence|competence/i, ["competence judged "]],
    ["competence best task", /task|evidence|candidate/i, ["competence best "]],
    ["feed", /^Feed —/, ["feed"]],
    ["feed kinds", /task|channel/i, ["feed kinds"]],
    ["feed list entity:CleanOwner limit:5", /CleanOwner|task|qa-/, ["feed list "]],
    ["chronicle", /task|Task|CleanOwner|qa-/, ["chronicle"]],
    ["chronicle about CleanWorker", /CleanWorker/, ["chronicle about "]],
    ["chronicle kinds", /Chronicle sources/, ["chronicle kinds"]],
    ["chronicle since 1h", /CleanOwner|qa-|Task|task/, ["chronicle since "]],
    ["chronicle pending", /Pending|task|feed/, ["chronicle pending "]],
    ["time", /\d{2}:\d{2}/, ["time"]],
    ["uptime", /uptime|tick|second|minute/i, ["uptime"]],
    ["score", /rank|standing|Score/i, ["score"]],
    ["work", /task|work|goal/i, ["work"]],
    ["next", /task|goal|next|action/i, ["next"]],
    ["orient", /Marina|Void|world|task/i, ["orient"]],
    ["debrief", /Debrief: CleanOwner/, ["debrief"]],
  ] as Array<[string, RegExp, string[]]>)
    await check(input, pattern, selectors);
  await check("channel leave cleanroom", /left|leave/i, ["channel leave "], undefined, "worker");
  await check("channel join cleanroom", /join/i, ["channel join "], undefined, "worker");
  await check(
    "rank CleanWorker 1",
    /rank|set/i,
    ["rank <entity> <level>"],
    "SELECT id FROM users WHERE name='CleanWorker' AND rank=1",
    "operator",
  );
  await check("rank CleanWorker 0", /rank|set/i, ["rank <entity> <level>"], undefined, "operator");
  await check(
    "gate grant CleanWorker world.code",
    /grant|world.code/i,
    ["gate grant "],
    undefined,
    "operator",
  );
  await check("gate list CleanWorker", /world.code/, ["gate list "]);
  await check(
    "gate revoke CleanWorker world.code",
    /revok|world.code/i,
    ["gate revoke "],
    undefined,
    "operator",
  );
  await check("gate audit", /world.code|CleanWorker/, ["gate audit"]);
  await check(
    "gate reset CleanWorker world.code",
    /reset|would|world.code/i,
    ["gate reset "],
    undefined,
    "operator",
  );

  await check("project cleanroom join", /join/i, ["project <name> join"], undefined, "worker");
  await check("project cleanroom budget tokens 10000 cost 0.25 duration 1h", /budget|10000|0.25/i, [
    "project <name> budget [",
  ]);
  await check("project cleanroom budget", /10000|10,000|0.25/, ["project <name> budget"]);
  await check("project cleanroom usage 10 0.0001", /record|usage|10/i, ["project <name> usage <"]);
  await check("project cleanroom usage", /10|0.0001/, ["project <name> usage"]);
  for (const strategy of [
    "custom",
    "htdag",
    "lazy-expansion",
    "non-overlapping",
    "plan-exec-verify",
    "workload-tiers",
  ])
    await check(
      `project cleanroom decompose ${strategy} Split checking into independent artifacts`,
      new RegExp(`${strategy}|decompos|configured|saved|strategy`, "i"),
      [`project <name> decompose ${strategy} `],
    );
  await check("project cleanroom decompose", /Workload Tiers/i, ["project <name> decompose"]);
  for (const strategy of ["custom", "generative", "graph", "shared", "tiered"])
    await check(
      `project cleanroom memory ${strategy} Preserve checked evidence`,
      new RegExp(`${strategy}|memory|saved|strategy`, "i"),
      [`project <name> memory ${strategy} `],
    );
  await check("project cleanroom memory", /tiered/, ["project <name> memory"]);
  await check(
    "project cleanroom orchestrate custom Independent evidence review",
    /custom|orchestrat/i,
    ["project <name> orchestrate custom "],
  );
  await check("project cleanroom orchestrate", /custom|Independent evidence review/, [
    "project <name> orchestrate",
  ]);
  await check(
    "project cleanroom outcome 0.8 | Completed checked coordination with an explicit missing-provider limitation",
    /outcome|recorded/i,
    ["project <name> outcome <"],
  );
  await check("project cleanroom outcome", /0.8|80%|checked coordination/, [
    "project <name> outcome",
  ]);
  for (const sub of ["tasks", "propose", "recommend", "verify"])
    await check(
      `project cleanroom ${sub}`,
      /cleanroom|task|proposal|recommend|verif|none|workflow/i,
      [`project <name> ${sub}`],
    );
  await check("project list", /cleanroom/, ["project list"]);

  await check("bankroll set 100", /100/, ["bankroll set "]);
  await check("bankroll cap 10", /10/, ["bankroll cap "]);
  await check("bankroll floor 20", /20/, ["bankroll floor "]);
  await check("bankroll kelly 0.25", /0.25|25/, ["bankroll kelly "]);
  await check("bankroll show", /100/, ["bankroll show"]);
  await check("position size kalshi QA-FIXTURE yes 0.7 50", /Kelly|size|stake|contract/i, [
    "position size ",
  ]);
  await check(
    "position open kalshi QA-FIXTURE yes 2 50",
    /paper|opened/i,
    ["position open "],
    "SELECT id FROM board_posts WHERE body LIKE '%QA-FIXTURE%' AND body LIKE '%order_id%'",
  );
  const orderBody = value(
    "SELECT body FROM board_posts WHERE body LIKE '%QA-FIXTURE%' AND body LIKE '%order_id%' ORDER BY id DESC LIMIT 1",
  );
  const order = JSON.parse(orderBody.match(/\{[\s\S]*\}/)?.[0] ?? orderBody) as {
    order_id: string;
  };
  await check("position list", /QA-FIXTURE/, ["position list "]);
  await check(`position close ${order.order_id} 1`, /closed|paper/i, ["position close "]);
  for (const suffix of ["", " all", " today", " week"])
    await check(`position pnl${suffix}`, /P&L|realized|profit|loss/i, [`position pnl${suffix}`]);
  await check(
    'position propose {"items":[{"venue":"kalshi","ticker":"QA-PROPOSAL","side":"yes","count":1,"price":50}]}',
    /proposal|proposed/i,
    ["position propose "],
  );
  const proposal = value(
    "SELECT id FROM board_posts WHERE body LIKE '%QA-PROPOSAL%' ORDER BY id DESC LIMIT 1",
  );
  await check(`position reject ${proposal} qualification rejection`, /reject/i, [
    "position reject ",
  ]);
  await check("bankroll reset", /reset|clear/i, ["bankroll reset"]);
}
