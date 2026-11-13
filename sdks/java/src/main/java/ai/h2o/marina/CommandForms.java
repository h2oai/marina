// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Typed command forms: the {@code forms} each command in {@link Marina#capabilities()} carries, and
 * {@link #compose} to fill one in with the same validation as the TypeScript SDK's {@code
 * composeCommand}.
 *
 * <pre>{@code
 * CommandForms.Form say = marina.forms("say").stream().filter(f -> f.syntax().startsWith("say ")).findFirst().orElseThrow();
 * CommandForms.Composed c = CommandForms.compose(say, Map.of("message", "hello"), Map.of());
 * if (c.ok()) marina.command(c.command());
 * }</pre>
 */
public final class CommandForms {
  private CommandForms() {}

  /**
   * One value a form takes.
   *
   * @param id the field's id ({@code field-0}): the key for {@link #compose}
   * @param label its name for people ({@code message}); {@link #compose} accepts it too
   * @param placeholder as the syntax writes it
   * @param optionalGroup the optional group it belongs to, or null
   * @param kind {@code text}, {@code number}, {@code json} or {@code choice}
   * @param choices the allowed values of a choice, or null
   * @param multiline free text that may hold spaces
   * @param allowNewlines kept as typed, line breaks included
   * @param min lowest number, or null
   * @param max highest number, or null
   * @param integer a whole number, or null
   * @param defaultValue used when no value is given, or null
   */
  public record Field(
      String id,
      String label,
      String placeholder,
      String optionalGroup,
      String kind,
      List<String> choices,
      boolean multiline,
      boolean allowNewlines,
      Double min,
      Double max,
      Boolean integer,
      String defaultValue) {}

  /** An optional part of a form, switched on by its id in {@link #compose}'s {@code enabled}. */
  public record Group(String id, String label, String parent) {}

  /** One piece of a form: a literal word, a field, or an optional group of parts. */
  public record Part(String literal, String field, String group, List<Part> children) {}

  /**
   * One way to write a command.
   *
   * @param encoding {@code command}, {@code named} (a named tool payload, not a command), or null
   * @param syntax {@code say <message>}
   * @param label for people
   * @param effect {@code read}, {@code write}, {@code delete}, {@code execute} or {@code unknown}
   * @param description what it does, or null
   * @param inputSchema a JSON Schema for its values, or null
   * @param raw everything the server sent
   */
  public record Form(
      String encoding,
      String syntax,
      String label,
      String effect,
      String description,
      List<String> examples,
      List<Field> fields,
      List<Group> groups,
      List<Part> parts,
      Map<String, Object> inputSchema,
      Map<String, Object> raw) {

    /** A form as the capabilities reply carries it. */
    public static Form from(Map<String, Object> form) {
      List<Field> fields = new ArrayList<>();
      for (Object f : list(form.get("fields"))) {
        Map<String, Object> m = Json.object(f);
        if (m == null) continue;
        List<String> choices = null;
        if (m.get("choices") instanceof List<?> items) {
          choices = new ArrayList<>();
          for (Object c : items) if (c instanceof String s) choices.add(s);
        }
        fields.add(
            new Field(
                str(m.get("id")),
                str(m.get("label")),
                str(m.get("placeholder")),
                Json.string(m.get("optionalGroup")),
                m.get("kind") instanceof String k ? k : "text",
                choices,
                Boolean.TRUE.equals(m.get("multiline")),
                Boolean.TRUE.equals(m.get("allowNewlines")),
                m.get("min") instanceof Number n ? n.doubleValue() : null,
                m.get("max") instanceof Number n ? n.doubleValue() : null,
                m.get("integer") instanceof Boolean b ? b : null,
                Json.string(m.get("default"))));
      }
      List<Group> groups = new ArrayList<>();
      for (Object g : list(form.get("groups"))) {
        Map<String, Object> m = Json.object(g);
        if (m != null) groups.add(new Group(str(m.get("id")), str(m.get("label")), Json.string(m.get("parent"))));
      }
      List<String> examples = new ArrayList<>();
      for (Object e : list(form.get("examples"))) if (e instanceof String s) examples.add(s);
      return new Form(
          Json.string(form.get("encoding")),
          str(form.get("syntax")),
          str(form.get("label")),
          Json.string(form.get("effect")),
          Json.string(form.get("description")),
          List.copyOf(examples),
          List.copyOf(fields),
          List.copyOf(groups),
          CommandForms.parts(form.get("parts")),
          Json.object(form.get("inputSchema")),
          Collections.unmodifiableMap(form));
    }

    /** The field with this id, or else this label; null when there is none. */
    public Field field(String idOrLabel) {
      for (Field f : fields) if (f.id().equals(idOrLabel)) return f;
      for (Field f : fields) if (f.label().equals(idOrLabel)) return f;
      return null;
    }
  }

  /** A composed command, or why it could not be: {@code errors} by field id ({@code form} for the whole). */
  public record Composed(String command, Map<String, String> errors) {
    /** No errors: {@link #command()} is ready to run. */
    public boolean ok() {
      return errors.isEmpty();
    }
  }

  /** The forms of one command in a capabilities reply ({@code commands[].forms}); empty when none. */
  public static List<Form> forms(Map<String, Object> capabilities, String command) {
    List<Form> out = new ArrayList<>();
    for (Object entry : list(capabilities.get("commands"))) {
      Map<String, Object> c = Json.object(entry);
      if (c == null || !command.equals(c.get("name"))) continue;
      for (Object f : list(c.get("forms"))) {
        Map<String, Object> form = Json.object(f);
        if (form != null) out.add(Form.from(form));
      }
    }
    return out;
  }

  private static List<Object> list(Object value) {
    List<Object> items = Json.array(value);
    return items != null ? items : List.of();
  }

  private static String str(Object value) {
    return value instanceof String s ? s : "";
  }

  private static List<Part> parts(Object value) {
    List<Part> out = new ArrayList<>();
    for (Object p : list(value)) {
      Map<String, Object> m = Json.object(p);
      if (m == null) continue;
      out.add(
          new Part(
              Json.string(m.get("literal")),
              Json.string(m.get("field")),
              Json.string(m.get("group")),
              m.get("children") instanceof List<?> ? parts(m.get("children")) : null));
    }
    return List.copyOf(out);
  }

  private static final Pattern JOINS = Pattern.compile("[:=]$");
  private static final Pattern NEWLINE = Pattern.compile("[\\r\\n]");
  private static final Pattern SPACE = Pattern.compile("\\s", Pattern.UNICODE_CHARACTER_CLASS);
  private static final Pattern SCALAR = Pattern.compile("scalar", Pattern.CASE_INSENSITIVE);
  private static final Pattern DECIMAL = Pattern.compile("[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?");
  private static final Pattern RADIX = Pattern.compile("0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)");

  /**
   * Fill in a form: {@code values} by field id (or label), {@code enabled} by optional group id.
   * Mirrors the TypeScript SDK's {@code composeCommand}: every field is checked (required, one
   * line, no spaces unless free text, numbers in range, choices, valid JSON).
   */
  public static Composed compose(Form form, Map<String, String> values, Map<String, Boolean> enabled) {
    Map<String, String> errors = new LinkedHashMap<>();
    if ("named".equals(form.encoding())) {
      errors.put("form", "Use this form's named tool, or choose a command form");
      return new Composed("", Collections.unmodifiableMap(errors));
    }
    List<String[]> pieces = new ArrayList<>(); // {text, join ("1" or "")}
    emit(form, form.parts(), values == null ? Map.of() : values, enabled == null ? Map.of() : enabled, errors, pieces);
    StringBuilder command = new StringBuilder();
    boolean join = true;
    for (String[] piece : pieces) {
      String text = piece[0];
      if (!(join || text.equals("\n") || text.equals(":") || text.equals("="))) command.append(' ');
      command.append(text);
      join = !piece[1].isEmpty() || text.equals("\n");
    }
    return new Composed(command.toString(), Collections.unmodifiableMap(errors));
  }

  private static void emit(
      Form form,
      List<Part> parts,
      Map<String, String> values,
      Map<String, Boolean> enabled,
      Map<String, String> errors,
      List<String[]> out) {
    for (Part part : parts) {
      if (part.group() != null) {
        if (Boolean.TRUE.equals(enabled.get(part.group())) && part.children() != null)
          emit(form, part.children(), values, enabled, errors, out);
        continue;
      }
      if (part.literal() != null) {
        out.add(new String[] {part.literal(), JOINS.matcher(part.literal()).find() ? "1" : ""});
        continue;
      }
      Field f = null;
      for (Field candidate : form.fields()) if (candidate.id().equals(part.field())) f = candidate;
      if (f == null) throw new IllegalArgumentException("The form names a field it does not have: " + part.field());
      String raw = values.get(f.id());
      if (raw == null) raw = values.get(f.label());
      if (raw == null) raw = f.defaultValue();
      if (raw == null) raw = "";
      String value = f.allowNewlines() ? raw : raw.strip();
      String error = check(form, f, value);
      if (error != null) errors.put(f.id(), error);
      String text = value;
      if (f.kind().equals("json") && !value.isEmpty() && error == null) text = Json.write(Json.parse(value));
      out.add(new String[] {text, ""});
    }
  }

  private static String check(Form form, Field f, String value) {
    if (value.isEmpty()) return "Required";
    if (NEWLINE.matcher(value).find() && !f.kind().equals("json") && !f.allowNewlines()) return "Use a single line";
    if (form.syntax().contains(" | ") && value.contains("|") && !f.kind().equals("json"))
      return "This field cannot contain a pipe separator";
    if (!f.multiline() && !f.kind().equals("choice") && SPACE.matcher(value).find()) return "Use one value without spaces";
    if (f.kind().equals("number")) {
      double n = jsNumber(value);
      if (Double.isNaN(n) || Double.isInfinite(n)) return "Enter a number";
      if (Boolean.TRUE.equals(f.integer()) && !(n == Math.rint(n) && Math.abs(n) <= 9007199254740991d))
        return "Enter an integer";
      if ((f.min() != null && n < f.min()) || (f.max() != null && n > f.max()))
        return "Enter a number between " + (f.min() == null ? "−∞" : jsString(f.min())) + " and " + (f.max() == null ? "∞" : jsString(f.max()));
    }
    if (f.kind().equals("choice") && (f.choices() == null || !f.choices().contains(value)))
      return "Choose one of the available values";
    if (f.kind().equals("json")) {
      Object parsed;
      try {
        parsed = Json.parse(value);
      } catch (IllegalArgumentException e) {
        return "Enter valid JSON";
      }
      if (SCALAR.matcher(f.placeholder()).find() && (parsed instanceof Map || parsed instanceof List))
        return "Enter a JSON string, number, boolean, or null";
    }
    return null;
  }

  /** JavaScript's {@code Number(text)}: NaN when it is not a number. */
  static double jsNumber(String text) {
    String s = text.strip();
    if (s.isEmpty()) return 0;
    if (s.equals("Infinity") || s.equals("+Infinity")) return Double.POSITIVE_INFINITY;
    if (s.equals("-Infinity")) return Double.NEGATIVE_INFINITY;
    if (DECIMAL.matcher(s).matches()) return Double.parseDouble(s);
    if (RADIX.matcher(s).matches()) {
      char p = Character.toLowerCase(s.charAt(1));
      return new java.math.BigInteger(s.substring(2), p == 'x' ? 16 : p == 'o' ? 8 : 2).doubleValue();
    }
    return Double.NaN;
  }

  private static String jsString(double n) {
    return n == Math.rint(n) && Math.abs(n) < 1e21 ? String.valueOf((long) n) : String.valueOf(n);
  }
}
