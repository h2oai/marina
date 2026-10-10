// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  getSessionInfo,
  type HookCallback,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { getErrorMessage } from "../engine/errors";
import type { RuntimeRequest, RuntimeState } from "../sdk/routing-runtime-types";
import { AgentTransport, type WireMessage } from "./agent-transport";

export interface AgentOptions {
  cwd: string;
  model?: string;
  /** Only a native identity previously recorded by this managed supervisor. */
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  executable: string;
  emit: (kind: string, payload: unknown) => void;
  state: (patch: Partial<RuntimeState>) => void;
  ask: (
    request: Omit<RuntimeRequest, "id">,
    signal?: AbortSignal,
  ) => Promise<{ allow: boolean; answer?: string }>;
}
export interface ManagedAgent {
  prompt(text: string, id: string): Promise<void>;
  interrupt(): Promise<void>;
  stop(): void | Promise<void>;
}
export interface AgentAdapter {
  id: string;
  label: string;
  executable: string;
  start: (options: AgentOptions) => Promise<ManagedAgent>;
  supportsResume?: boolean;
}
function record(value: unknown): WireMessage {
  return value && typeof value === "object" ? (value as WireMessage) : {};
}

async function codex(options: AgentOptions): Promise<ManagedAgent> {
  let threadId = "";
  let turnId = "";
  let stopping = false;
  const transport = new AgentTransport({
    command: options.executable,
    args: ["app-server", "--listen", "stdio://"],
    cwd: options.cwd,
    env: options.env,
    onStderr: (text) => options.emit("stderr", { text }),
    onExit: (error) =>
      options.state({
        status: stopping ? "stopped" : "failed",
        error: stopping ? undefined : (error ?? "Native process exited"),
      }),
    onMessage: (message) => {
      const method = String(message.method ?? "");
      const params = record(message.params);
      if (message.id !== undefined && method) {
        void (async () => {
          if (
            ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
              method,
            )
          ) {
            const answer = await options.ask({ kind: "permission", title: method, input: params });
            await transport.send({
              id: message.id,
              result: { decision: answer.allow ? "accept" : "decline" },
            });
          } else if (method === "item/tool/requestUserInput") {
            const answer = await options.ask({
              kind: "question",
              title: "Codex needs input (JSON answers by question id)",
              input: params,
            });
            const answers = answer.allow && answer.answer ? JSON.parse(answer.answer) : {};
            await transport.send({ id: message.id, result: { answers } });
          } else {
            options.emit("approval.unsupported", { method, params });
            await transport.send({
              id: message.id,
              error: {
                code: -32601,
                message: "Marina does not support this request; no permission granted",
              },
            });
          }
        })().catch((error) => {
          options.emit("adapter.error", { text: getErrorMessage(error) });
          void transport
            .send({
              id: message.id,
              error: { code: -32603, message: "Request could not be handled" },
            })
            .catch((err) => options.emit("adapter.error", { text: getErrorMessage(err) }));
        });
        return;
      }
      if (method === "item/agentMessage/delta" || method === "item/commandExecution/outputDelta")
        options.emit("output", { text: params.delta, method, itemId: params.itemId });
      else if (!method.endsWith("/delta"))
        options.emit(`native.${method || "notification"}`, params);
      if (method === "turn/started") {
        turnId = String(record(params.turn).id);
        options.state({ status: "running" });
      }
      if (method === "turn/completed") {
        turnId = "";
        options.state({ status: "idle" });
      }
    },
  });
  try {
    await transport.request({
      method: "initialize",
      params: {
        clientInfo: { name: "marina", version: "0.7.0" },
        capabilities: { experimentalApi: false },
      },
    });
    await transport.send({ method: "initialized", params: {} });
    if (options.resumeSessionId) {
      const read = await transport.request({
        method: "thread/read",
        params: { threadId: options.resumeSessionId, includeTurns: false },
      });
      const thread = record(record(read.result).thread);
      if (thread.id !== options.resumeSessionId)
        throw new Error("Codex returned a different stored thread");
      if (record(thread.status).type === "active")
        throw new Error("Codex thread is already active; inspect it before taking over");
    }
    const response = await transport.request({
      method: options.resumeSessionId ? "thread/resume" : "thread/start",
      params: {
        ...(options.resumeSessionId ? { threadId: options.resumeSessionId } : {}),
        cwd: options.cwd,
        model: options.model,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    });
    threadId = String(record(record(response.result).thread).id ?? "");
    if (!threadId) throw new Error("Codex did not return a thread id");
    if (options.resumeSessionId && threadId !== options.resumeSessionId)
      throw new Error("Codex did not resume the recorded thread");
    options.state({ nativeSessionId: threadId, status: "idle" });
  } catch (error) {
    await transport.stop();
    throw error;
  }
  return {
    async prompt(text, id) {
      if (turnId)
        throw new Error(
          "Codex is busy; wait for this turn or interrupt it before sending another prompt",
        );
      const response = await transport.request({
        method: "turn/start",
        params: {
          threadId,
          clientUserMessageId: id,
          input: [{ type: "text", text, text_elements: [] }],
        },
      });
      turnId = String(record(record(response.result).turn).id ?? "");
    },
    async interrupt() {
      if (turnId)
        await transport.request({ method: "turn/interrupt", params: { threadId, turnId } });
    },
    stop() {
      stopping = true;
      return transport.stop();
    },
  };
}

async function pi(options: AgentOptions): Promise<ManagedAgent> {
  let stopping = false;
  const transport = new AgentTransport({
    command: options.executable,
    args: [
      "--mode",
      "rpc",
      ...(options.resumeSessionId ? ["--session", options.resumeSessionId] : []),
      ...(options.model ? ["--model", options.model] : []),
    ],
    cwd: options.cwd,
    env: options.env,
    onStderr: (text) => options.emit("stderr", { text }),
    onExit: (error) =>
      options.state({
        status: stopping ? "stopped" : "failed",
        error: stopping ? undefined : (error ?? "Native process exited"),
      }),
    onMessage: (message) => {
      const type = String(message.type ?? "notification");
      const assistant = record(message.assistantMessageEvent);
      if (type === "message_update" && assistant.type === "text_delta")
        options.emit("output", { text: assistant.delta });
      else if (type !== "message_update") options.emit(`native.${type}`, message);
      if (type === "agent_start") options.state({ status: "running" });
      if (type === "agent_settled") options.state({ status: "idle" });
      if (
        type === "extension_ui_request" &&
        ["confirm", "select", "input", "editor"].includes(String(message.method))
      ) {
        void options
          .ask({
            kind: message.method === "confirm" ? "permission" : "question",
            title: String(message.title ?? "pi extension request"),
            input: message,
            choices: Array.isArray(message.options) ? message.options.map(String) : undefined,
          })
          .then((answer) =>
            transport.send({
              type: "extension_ui_response",
              id: message.id,
              ...(message.method === "confirm"
                ? { confirmed: answer.allow }
                : answer.allow
                  ? { value: answer.answer ?? "" }
                  : { cancelled: true }),
            }),
          )
          .catch((error) => options.emit("adapter.error", { text: getErrorMessage(error) }));
      }
    },
  });
  try {
    const state = await transport.request({ type: "get_state" });
    const nativeSessionId = String(record(state.data).sessionId ?? "");
    if (options.resumeSessionId && nativeSessionId !== options.resumeSessionId)
      throw new Error("pi did not resume the recorded session");
    options.state({ nativeSessionId, status: "idle" });
  } catch (error) {
    await transport.stop();
    throw error;
  }
  return {
    async prompt(message) {
      await transport.request({ type: "prompt", message, streamingBehavior: "followUp" });
    },
    async interrupt() {
      await transport.request({ type: "abort" });
    },
    stop() {
      stopping = true;
      return transport.stop();
    },
  };
}

/** The two SDK entry points the Claude adapter uses; injectable so tests need no CLI. */
export interface ClaudeSdk {
  query: typeof query;
  getSessionInfo: typeof getSessionInfo;
}

export const CLAUDE_RESUME_MISMATCH = "Claude did not resume the recorded session";
const UNCONFIRMED_TOOL = "Tool use is held until Claude confirms it resumed the recorded session";

/**
 * Claude Code reports its session identity (`system/init`) only after it consumes the
 * first user message, so a resume cannot be confirmed before input. Instead: the recorded
 * transcript must exist before the process starts; every tool is denied until `init`
 * names the recorded session; a different session interrupts the query and fails the run.
 * The first prompt text reaches the opened conversation before confirmation; no tool can.
 */
export function createClaudeAdapter(sdk: ClaudeSdk): AgentAdapter["start"] {
  return (options) => claude(sdk, options);
}

async function claude(sdk: ClaudeSdk, options: AgentOptions): Promise<ManagedAgent> {
  const resumeId = options.resumeSessionId;
  if (resumeId && !(await sdk.getSessionInfo(resumeId, { dir: options.cwd })))
    throw new Error("Claude has no recorded session with this id in this directory; not resuming");
  // Fresh sessions have no identity to confirm; a resume confirms on `init`.
  let confirmed = !resumeId;
  let mismatch: string | undefined;
  const holdTools: HookCallback = async () =>
    confirmed
      ? { continue: true }
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: UNCONFIRMED_TOOL,
          },
        };
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    while (!stopped) {
      if (!pending.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      while (pending.length && !stopped) yield pending.shift()!;
    }
  }
  const stream = sdk.query({
    prompt: messages(),
    options: {
      cwd: options.cwd,
      model: options.model,
      ...(resumeId
        ? {
            resume: resumeId,
            // Settings allow-rules skip canUseTool; this hook holds those tools as well.
            hooks: { PreToolUse: [{ hooks: [holdTools] }] },
          }
        : {}),
      env: options.env,
      pathToClaudeCodeExecutable: options.executable,
      permissionMode: "default",
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      stderr: (text) => options.emit("stderr", { text }),
      canUseTool: async (tool, input, context) => {
        if (!confirmed) return { behavior: "deny", message: UNCONFIRMED_TOOL };
        const question = tool === "AskUserQuestion";
        const answer = await options.ask(
          {
            kind: question ? "question" : "permission",
            title: question
              ? "Claude needs input (JSON answers by question text)"
              : `Claude: ${tool}`,
            input,
          },
          context.signal,
        );
        if (!answer.allow)
          return { behavior: "deny", message: "The operator declined this request" };
        return {
          behavior: "allow",
          updatedInput: question ? { ...input, answers: JSON.parse(answer.answer ?? "{}") } : input,
        };
      },
    },
  });
  const completed = (async () => {
    try {
      for await (const message of stream) {
        const event = record(message);
        if (event.type === "system" && event.subtype === "init") {
          const sessionId = String(event.session_id);
          if (resumeId && sessionId !== resumeId) {
            mismatch = CLAUDE_RESUME_MISMATCH;
            options.emit("adapter.error", { text: mismatch, nativeSessionId: sessionId });
            options.state({ status: "failed", error: mismatch });
            stopped = true;
            wake?.();
            await stream
              .interrupt()
              .catch((error) => options.emit("adapter.error", { text: getErrorMessage(error) }));
            stream.close();
            break;
          }
          confirmed = true;
          options.state({ nativeSessionId: sessionId });
        }
        const partial = record(event.event);
        const delta = record(partial.delta);
        if (event.type === "stream_event" && delta.type === "text_delta")
          options.emit("output", { text: delta.text });
        else if (message.type !== "stream_event") options.emit(`native.${message.type}`, message);
        if (message.type === "result") options.state({ status: "idle" });
      }
      if (mismatch) return;
      options.state({
        status: stopped ? "stopped" : "failed",
        error: stopped ? undefined : "Claude stream ended",
      });
    } catch (error) {
      if (mismatch) return;
      options.state({
        status: stopped ? "stopped" : "failed",
        error: stopped ? undefined : getErrorMessage(error),
      });
    }
  })();
  options.state({ status: "idle" });
  return {
    async prompt(text, id) {
      if (mismatch) throw new Error(mismatch);
      if (stopped) throw new Error("Claude session stopped");
      pending.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
        uuid: id as `${string}-${string}-${string}-${string}-${string}`,
      });
      wake?.();
    },
    async interrupt() {
      await stream.interrupt();
    },
    async stop() {
      stopped = true;
      wake?.();
      stream.close();
      await completed;
    },
  };
}

/** Registry is extensible; transport, supervisor and dashboard do not assume a participant count. */
export const BUILTIN_AGENT_ADAPTERS: AgentAdapter[] = [
  {
    id: "claude",
    label: "Claude Code",
    executable: "claude",
    start: createClaudeAdapter({ query, getSessionInfo }),
    supportsResume: true,
  },
  { id: "codex", label: "Codex", executable: "codex", start: codex, supportsResume: true },
  { id: "pi", label: "pi", executable: "pi", start: pi, supportsResume: true },
];
