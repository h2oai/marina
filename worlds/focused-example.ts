import type { MarinaDB } from "../src/persistence/database";
import type { RoomId, RoomModule } from "../src/types";
import type { GuideNote, WorldDefinition } from "../src/world/world-definition";
import { seedBoard, seedChannel, seedProject, seedSystemAgent, seedTraitsAndRoles } from "./seed";

export interface FocusedExampleSpec {
  slug: string;
  name: string;
  purpose: string;
  project: {
    name: string;
    description: string;
    orchestration: string;
    tasks: { title: string; description: string; standing?: number }[];
    principles: string[];
  };
  stages: [
    { id: string; name: string; description: string },
    { id: string; name: string; description: string },
    { id: string; name: string; description: string },
    { id: string; name: string; description: string },
    { id: string; name: string; description: string },
  ];
  agents: { name: string; role: "general" | "researcher" | "scholar"; goal: string }[];
  guideNotes: string[];
}

function room(id: string, spec: FocusedExampleSpec): RoomId {
  return `${spec.slug}/${id}` as RoomId;
}

function buildRooms(spec: FocusedExampleSpec): Record<string, RoomModule> {
  const [intake, evidence, work, review, archive] = spec.stages;
  return {
    [room(intake.id, spec)]: {
      short: intake.name,
      long: intake.description,
      exits: { east: room(evidence.id, spec), south: room(work.id, spec) },
      items: { brief: `The canonical ${spec.project.name} brief and its acceptance criteria.` },
    },
    [room(evidence.id, spec)]: {
      short: evidence.name,
      long: evidence.description,
      exits: { west: room(intake.id, spec), south: room(review.id, spec) },
      items: { sources: "A shared evidence ledger. Record provenance, confidence, and conflicts." },
    },
    [room(work.id, spec)]: {
      short: work.name,
      long: work.description,
      exits: {
        north: room(intake.id, spec),
        east: room(review.id, spec),
        south: room(archive.id, spec),
      },
      items: { workspace: "The active project, task queue, and shared memory pool." },
    },
    [room(review.id, spec)]: {
      short: review.name,
      long: review.description,
      exits: {
        north: room(evidence.id, spec),
        west: room(work.id, spec),
        south: room(archive.id, spec),
      },
      items: { gate: "Work crosses this gate only with explicit evidence and a recorded review." },
    },
    [room(archive.id, spec)]: {
      short: archive.name,
      long: archive.description,
      exits: { north: room(work.id, spec), east: room(review.id, spec) },
      items: {
        record: "Approved findings, dissent, decisions, and unresolved questions persist here.",
      },
    },
  };
}

export function focusedExampleWorld(spec: FocusedExampleSpec): WorldDefinition {
  const channel = `${spec.slug}-work`;
  const board = `${spec.slug}-review`;
  const guideNotes: GuideNote[] = [
    {
      content:
        `Welcome to ${spec.name}. ${spec.purpose} ` +
        `Join the golden path with 'project ${spec.project.name} join', then use 'project ${spec.project.name} status'.`,
      importance: 10,
      type: "skill",
    },
    {
      content:
        `Operating loop: orient in ${spec.stages[0].name}; collect evidence in ${spec.stages[1].name}; ` +
        `execute in ${spec.stages[2].name}; challenge work in ${spec.stages[3].name}; preserve the result in ${spec.stages[4].name}.`,
      importance: 10,
      type: "skill",
    },
    {
      content:
        `Collaboration surfaces: channel '${channel}', board '${board}', project '${spec.project.name}', ` +
        `and pool '${spec.project.name.toLowerCase()}'. Completion means every seeded task reaches an accepted terminal state.`,
      importance: 9,
      type: "fact",
    },
    ...spec.guideNotes.map((content) => ({ content, importance: 9, type: "principle" })),
  ];

  return {
    name: spec.name,
    startRoom: room(spec.stages[0].id, spec),
    rooms: buildRooms(spec),
    gridPositions: {
      [room(spec.stages[0].id, spec)]: { row: 0, col: 0 },
      [room(spec.stages[1].id, spec)]: { row: 0, col: 1 },
      [room(spec.stages[2].id, spec)]: { row: 1, col: 0 },
      [room(spec.stages[3].id, spec)]: { row: 1, col: 1 },
      [room(spec.stages[4].id, spec)]: { row: 2, col: 0 },
    },
    quests: [],
    guideNotes,
    canvas: {
      name: spec.slug,
      description: `${spec.name} evidence, work products, reviews, and decisions`,
      scope: "global",
    },
    autoBootstrap: [`channel join ${channel}`],
    seed(db: MarinaDB): void {
      seedTraitsAndRoles(db);
      seedChannel(db, channel);
      seedBoard(db, board, {
        title: `${spec.name}: review protocol`,
        body:
          `Review the evidence, assumptions, dissent, and acceptance criteria before approving work. ` +
          `Post unresolved risks instead of hiding them.`,
      });
      seedProject(db, {
        ...spec.project,
        poolNotes: spec.project.principles.map((content) => ({ content, importance: 9 })),
      });
      const model = process.env.MARINA_CREW_MODEL ?? "marina/default";
      for (const agent of spec.agents) seedSystemAgent(db, { ...agent, model });
    },
  };
}
