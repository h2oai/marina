// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Just enough JSON for Marina's protocols, so the SDK has no dependencies.
 *
 * <p>Objects read as {@code Map<String, Object>} (insertion ordered), arrays as {@code
 * List<Object>}, numbers as {@code Long} when integral and {@code Double} otherwise, plus {@code
 * String}, {@code Boolean} and {@code null}. Writing accepts those, any {@code Map}, {@code
 * Iterable}, array of objects, {@code Number}, {@code CharSequence} and {@code Enum}.
 */
public final class Json {
  private Json() {}

  /** Parse one JSON value. Throws IllegalArgumentException on malformed input. */
  public static Object parse(String text) {
    Reader reader = new Reader(text);
    reader.space();
    Object value = reader.value();
    reader.space();
    if (reader.pos != text.length()) throw reader.error("unexpected trailing text");
    return value;
  }

  /** Serialize a value. */
  public static String write(Object value) {
    StringBuilder out = new StringBuilder();
    write(value, out);
    return out.toString();
  }

  /** The value as a JSON object, or null when it is not one. */
  @SuppressWarnings("unchecked")
  public static Map<String, Object> object(Object value) {
    return value instanceof Map ? (Map<String, Object>) value : null;
  }

  /** The value as a JSON array, or null when it is not one. */
  @SuppressWarnings("unchecked")
  public static List<Object> array(Object value) {
    return value instanceof List ? (List<Object>) value : null;
  }

  /** The value as a string, or null when it is not one. */
  public static String string(Object value) {
    return value instanceof String ? (String) value : null;
  }

  private static void write(Object value, StringBuilder out) {
    if (value == null) {
      out.append("null");
    } else if (value instanceof CharSequence || value instanceof Enum || value instanceof Character) {
      quote(value.toString(), out);
    } else if (value instanceof Boolean) {
      out.append(value);
    } else if (value instanceof Double || value instanceof Float) {
      double d = ((Number) value).doubleValue();
      if (Double.isNaN(d) || Double.isInfinite(d)) out.append("null");
      else if (d == Math.rint(d) && Math.abs(d) < 1e15) out.append((long) d);
      else out.append(d);
    } else if (value instanceof Number) {
      out.append(value);
    } else if (value instanceof Map) {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
        if (!first) out.append(',');
        first = false;
        quote(String.valueOf(e.getKey()), out);
        out.append(':');
        write(e.getValue(), out);
      }
      out.append('}');
    } else if (value instanceof Iterable) {
      out.append('[');
      boolean first = true;
      for (Object item : (Iterable<?>) value) {
        if (!first) out.append(',');
        first = false;
        write(item, out);
      }
      out.append(']');
    } else if (value instanceof Object[]) {
      write(List.of((Object[]) value), out);
    } else {
      throw new IllegalArgumentException("Cannot write " + value.getClass().getName() + " as JSON");
    }
  }

  private static void quote(String s, StringBuilder out) {
    out.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        default -> {
          if (c < 0x20 || c == ' ' || c == ' ') out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    out.append('"');
  }

  private static final class Reader {
    final String s;
    int pos;

    Reader(String s) {
      this.s = s;
    }

    IllegalArgumentException error(String message) {
      return new IllegalArgumentException("Bad JSON at " + pos + ": " + message);
    }

    void space() {
      while (pos < s.length()) {
        char c = s.charAt(pos);
        if (c == ' ' || c == '\n' || c == '\r' || c == '\t') pos++;
        else break;
      }
    }

    char peek() {
      if (pos >= s.length()) throw error("unexpected end");
      return s.charAt(pos);
    }

    void expect(String word) {
      if (!s.startsWith(word, pos)) throw error("expected " + word);
      pos += word.length();
    }

    Object value() {
      char c = peek();
      switch (c) {
        case '{':
          return obj();
        case '[':
          return arr();
        case '"':
          return str();
        case 't':
          expect("true");
          return Boolean.TRUE;
        case 'f':
          expect("false");
          return Boolean.FALSE;
        case 'n':
          expect("null");
          return null;
        default:
          if (c == '-' || (c >= '0' && c <= '9')) return num();
          throw error("unexpected '" + c + "'");
      }
    }

    Map<String, Object> obj() {
      Map<String, Object> map = new LinkedHashMap<>();
      pos++;
      space();
      if (peek() == '}') {
        pos++;
        return map;
      }
      while (true) {
        space();
        if (peek() != '"') throw error("expected a key");
        String key = str();
        space();
        if (peek() != ':') throw error("expected ':'");
        pos++;
        space();
        map.put(key, value());
        space();
        char c = peek();
        pos++;
        if (c == '}') return map;
        if (c != ',') throw error("expected ',' or '}'");
      }
    }

    List<Object> arr() {
      List<Object> list = new ArrayList<>();
      pos++;
      space();
      if (peek() == ']') {
        pos++;
        return list;
      }
      while (true) {
        space();
        list.add(value());
        space();
        char c = peek();
        pos++;
        if (c == ']') return list;
        if (c != ',') throw error("expected ',' or ']'");
      }
    }

    String str() {
      pos++;
      StringBuilder out = new StringBuilder();
      while (true) {
        if (pos >= s.length()) throw error("unterminated string");
        char c = s.charAt(pos++);
        if (c == '"') return out.toString();
        if (c != '\\') {
          out.append(c);
          continue;
        }
        if (pos >= s.length()) throw error("unterminated escape");
        char e = s.charAt(pos++);
        switch (e) {
          case '"', '\\', '/' -> out.append(e);
          case 'n' -> out.append('\n');
          case 'r' -> out.append('\r');
          case 't' -> out.append('\t');
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'u' -> {
            if (pos + 4 > s.length()) throw error("short \\u escape");
            out.append((char) Integer.parseInt(s.substring(pos, pos + 4), 16));
            pos += 4;
          }
          default -> throw error("bad escape \\" + e);
        }
      }
    }

    Object num() {
      int start = pos;
      if (peek() == '-') pos++;
      boolean fraction = false;
      while (pos < s.length()) {
        char c = s.charAt(pos);
        if (c >= '0' && c <= '9') pos++;
        else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
          fraction = true;
          pos++;
        } else break;
      }
      String text = s.substring(start, pos);
      try {
        if (!fraction) {
          try {
            return Long.parseLong(text);
          } catch (NumberFormatException tooBig) {
            return Double.parseDouble(text);
          }
        }
        return Double.parseDouble(text);
      } catch (NumberFormatException bad) {
        throw error("bad number " + text);
      }
    }
  }
}
