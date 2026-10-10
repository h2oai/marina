// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { compileCommandForms } from "./command-forms";
import { parseCodingCommandTarget } from "./command-target";
import { type A2UIComponent, type A2UINodeData, validatePanelDocument } from "./panel-document";

/** An ordinary publication: no new workspace, agent, routing session or execution authority. */
export function codingDesk(input: {
  sessionId: string;
  taskId?: string;
  participantId?: string;
  title?: string;
}): A2UINodeData {
  const target = parseCodingCommandTarget({ sessionId: input.sessionId });
  const form = compileCommandForms(["code ask <request>"])[0]!;
  const seeForm = compileCommandForms(["code see <path> [question]"])[0]!;
  const components: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: [
        "intro",
        "work",
        "request",
        "ask",
        "image",
        "see",
        ...(input.taskId ? ["task"] : []),
        ...(input.participantId ? ["participant", "message", "send"] : []),
        "world",
      ],
    },
    {
      id: "intro",
      component: "Text",
      text: "Your coding work, evidence and world activity. Opening or closing this desk leaves agents running.",
    },
    { id: "work", component: "Resource", reference: { kind: "coding", id: target.sessionId } },
    {
      id: "request",
      component: "TextField",
      label: "Request for coder",
      placeholder: "Describe the change or ask about the current work",
    },
    {
      id: "ask",
      component: "Button",
      label: "Review coding request",
      operation: {
        kind: "command",
        command: "code",
        syntax: form.syntax,
        codingTarget: target,
        values: { [form.fields[0]!.id]: { field: "request" } },
      },
    },
    {
      id: "image",
      component: "TextField",
      label: "Workspace image path",
      placeholder: "images/diagram.png",
    },
    {
      id: "see",
      component: "Button",
      label: "Review image inspection",
      operation: {
        kind: "command",
        command: "code",
        syntax: seeForm.syntax,
        codingTarget: target,
        values: { [seeForm.fields[0]!.id]: { field: "image" } },
      },
    },
    ...(input.taskId
      ? [
          {
            id: "task",
            component: "Resource" as const,
            reference: { kind: "task", id: input.taskId },
          },
        ]
      : []),
    ...(input.participantId
      ? [
          {
            id: "participant",
            component: "Resource" as const,
            reference: { kind: "participant", id: input.participantId },
          },
          { id: "message", component: "TextField" as const, label: "Message to participant" },
          {
            id: "send",
            component: "Button" as const,
            label: "Review message",
            operation: {
              kind: "message",
              targetId: input.participantId,
              message: { field: "message" },
            },
          },
        ]
      : []),
    { id: "world", component: "Resource", reference: { kind: "feed", limit: 10 } },
  ];
  const parsed = validatePanelDocument({
    schema: "marina.panel.v1",
    title: input.title ?? "Coding desk",
    components,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}
