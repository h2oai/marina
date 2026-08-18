// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Eval Chamber",
  long: "Evaluation and quality assessment. Score outputs, compare approaches, validate results. Use 'bench scores' for benchmark results, 'novelty stats' for proficiency analysis.",
  exits: {
    north: "bench/arena" as RoomId,
    south: "integration/bay" as RoomId,
    west: "strategy/room" as RoomId,
    nw: "markets/floor" as RoomId,
    sw: "channels/hub" as RoomId,
  },
  items: {
    evaluator: "Quality evaluation tools. Compare outputs, score accuracy, assess completeness.",
    leaderboard: "Agent capability leaderboard across all benchmark categories.",
  },
};

export default room;
