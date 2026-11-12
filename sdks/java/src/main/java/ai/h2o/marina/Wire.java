// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code marina.wire.v1}: what the server sends, read into Java.
 *
 * <p>The protocol is protocol/README.md and protocol/marina.wire.v1.schema.json in the Marina
 * repository. The coding records name exactly the schema's fields; the repository's tests hold
 * them to it.
 */
public final class Wire {
  private Wire() {}

  public static final String WIRE_PROTOCOL = "marina.wire.v1";

  /** What kind of step a coding activity is. */
  public static final List<String> CODING_ACTIVITY_KINDS =
      List.of("read", "search", "edit", "write", "patch", "run", "verify", "plan", "summary", "other");

  /** What the checks said. Only {@code passed} means checks ran on the change and passed. */
  public static final List<String> VERIFICATIONS =
      List.of("passed", "failed", "not_run", "error", "missing", "stale", "unbound", "unavailable");

  /** How a run ended. {@code submitted}: the coder handed the change in for review. */
  public static final List<String> RUN_OUTCOMES =
      List.of("submitted", "failed", "cancelled", "interrupted");

  /** Well-known server frames, as the protocol's dispatch rule names them. */
  public enum Kind {
    WELCOME,
    SESSION,
    AUTH_ERROR,
    COMMAND_RESULT,
    ERROR,
    CAPABILITIES_REPLY,
    CONTEXT_PREVIEW_REPLY,
    MEMORY_SERVICE,
    EXEC_APPROVAL,
    CODE,
    TELL,
    ONBOARDING,
    /** Ordinary world output. */
    OUTPUT
  }

  static Map<String, Object> data(Map<String, Object> frame) {
    Map<String, Object> data = Json.object(frame.get("data"));
    return data != null ? data : Map.of();
  }

  private static boolean truthy(Object value) {
    if (value == null || Boolean.FALSE.equals(value)) return false;
    if (value instanceof String s) return !s.isEmpty();
    if (value instanceof Number n) return n.doubleValue() != 0;
    return true;
  }

  /** Which well-known frame this is, by the protocol's order ("Telling frames apart"). */
  public static Kind classify(Map<String, Object> frame) {
    Map<String, Object> data = data(frame);
    Object kind = frame.get("kind");
    Object tag = frame.get("tag");
    if ("auth_error".equals(kind)) return Kind.AUTH_ERROR;
    if ("error".equals(kind)) return Kind.ERROR;
    if (truthy(data.get("command_result"))) return Kind.COMMAND_RESULT;
    if ("system".equals(kind) && data.get("entityId") instanceof String) return Kind.SESSION;
    if ("system".equals(kind) && truthy(data.get("protocol")) && truthy(data.get("schema")))
      return Kind.WELCOME;
    if ("capabilities".equals(tag)) return Kind.CAPABILITIES_REPLY;
    if ("context_preview".equals(tag)) return Kind.CONTEXT_PREVIEW_REPLY;
    if (truthy(data.get("memory_service"))) return Kind.MEMORY_SERVICE;
    if (truthy(data.get("execApproval"))) return Kind.EXEC_APPROVAL;
    if (truthy(data.get("code"))) return Kind.CODE;
    if ("tell".equals(tag)) return Kind.TELL;
    if ("onboarding".equals(tag)) return Kind.ONBOARDING;
    return Kind.OUTPUT;
  }

  /** The frame's text for people (may carry ANSI colour codes), or "". */
  public static String text(Map<String, Object> frame) {
    String text = Json.string(data(frame).get("text"));
    return text != null ? text : "";
  }

  private static Long whole(Object value) {
    return value instanceof Long l ? l : null;
  }

  private static Double number(Object value) {
    return value instanceof Number n ? n.doubleValue() : null;
  }

  private static CodingActivity activity(Object value) {
    Map<String, Object> a = Json.object(value);
    if (a == null || !(a.get("label") instanceof String) || !(a.get("kind") instanceof String))
      return null;
    List<String> diff = null;
    List<Object> lines = Json.array(a.get("diff"));
    if (lines != null) {
      diff = new ArrayList<>();
      for (Object line : lines) if (line instanceof String s) diff.add(s);
    }
    return new CodingActivity(
        (String) a.get("kind"),
        (String) a.get("label"),
        Json.string(a.get("path")),
        diff,
        whole(a.get("more")),
        a.get("quiet") instanceof Boolean b ? b : null);
  }

  /** A run's end: a {@code code_lifecycle} event whose metadata says {@code terminal: true}. */
  private static RunResult runResult(Map<String, Object> code) {
    Map<String, Object> meta = Json.object(code.get("metadata"));
    if (!"code_lifecycle".equals(code.get("event"))
        || meta == null
        || !Boolean.TRUE.equals(meta.get("terminal"))) return null;
    String runId = Json.string(meta.get("runId"));
    if (runId == null) return null;
    Object phase = meta.containsKey("phase") ? meta.get("phase") : code.get("phase");
    String ended = "completed".equals(phase) ? "completed" : "failed";
    Map<String, Object> forced = Json.object(meta.get("budgetForced"));
    Map<String, Object> raw = new java.util.LinkedHashMap<>(meta);
    raw.put("phase", ended);
    return new RunResult(
        runId,
        true,
        ended,
        whole(meta.get("taskId")),
        Json.string(meta.get("agent")),
        Json.string(meta.get("outcome")),
        Json.string(meta.get("reason")),
        Json.string(meta.get("detail")),
        Json.string(meta.get("summary")),
        Json.string(meta.get("summaryId")),
        Json.string(meta.get("verification")),
        Json.string(meta.get("verificationReason")),
        forced == null
            ? null
            : new BudgetForced(
                String.valueOf(forced.getOrDefault("reason", "")),
                number(forced.get("used")),
                number(forced.get("cap"))),
        java.util.Collections.unmodifiableMap(raw));
  }

  /** The coding event a frame carries, or null. */
  public static CodeEvent codeEvent(Map<String, Object> frame) {
    Map<String, Object> code = Json.object(data(frame).get("code"));
    if (code == null || !(code.get("event") instanceof String)) return null;
    Map<String, Object> meta = Json.object(code.get("metadata"));
    if (meta == null) meta = Map.of();
    String type = Json.string(code.get("type"));
    return new CodeEvent(
        (String) code.get("event"),
        type != null ? type : "",
        text(frame),
        Json.string(code.get("sessionId")),
        Json.string(meta.get("runId")),
        Json.string(code.get("phase")),
        Json.string(meta.get("kind")),
        activity(meta.get("activity")),
        runResult(code),
        frame);
  }

  /** The exec approval request a frame carries, or null. */
  public static ExecApprovalRequest execApproval(Map<String, Object> frame) {
    Map<String, Object> request = Json.object(data(frame).get("execApproval"));
    if (request == null) return null;
    String token = Json.string(request.get("token"));
    String cwd = Json.string(request.get("cwd"));
    String rendered = Json.string(request.get("rendered"));
    List<Object> argv = Json.array(request.get("argv"));
    if (token == null || token.isEmpty() || cwd == null || rendered == null || argv == null)
      return null;
    List<String> args = new ArrayList<>();
    for (Object a : argv) if (a instanceof String s) args.add(s);
    return new ExecApprovalRequest(token, List.copyOf(args), cwd, rendered);
  }
}
