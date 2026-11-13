// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.lang.reflect.WildcardType;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Just enough JSON for Marina's protocols, so the SDK has no dependencies.
 *
 * <p>Objects read as {@code Map<String, Object>} (insertion ordered), arrays as {@code
 * List<Object>}, numbers as {@code Long} when integral and {@code Double} otherwise, plus {@code
 * String}, {@code Boolean} and {@code null}. Writing accepts those, any {@code Map}, {@code
 * Iterable}, array of objects, {@code Number}, {@code CharSequence}, {@code Enum} and records.
 *
 * <p>{@link #bind(Object, Class)} reads a parsed value into a record (the generated {@link Http}
 * models), and {@link #unbind(Object)} turns one back into plain JSON values.
 */
public final class Json {
  private Json() {}

  /** The JSON name of a record component, when it differs from the component's own name. */
  @Retention(RetentionPolicy.RUNTIME)
  @Target(ElementType.RECORD_COMPONENT)
  public @interface Name {
    String value();
  }

  /** {@code List<item>}, for {@link #bind(Object, Type)}. */
  public static Type listOf(Type item) {
    return new Generic(List.class, item);
  }

  /** {@code Map<String, value>}, for {@link #bind(Object, Type)}. */
  public static Type mapOf(Type value) {
    return new Generic(Map.class, String.class, value);
  }

  private record Generic(Class<?> raw, Type... args) implements ParameterizedType {
    @Override
    public Type[] getActualTypeArguments() {
      return args.clone();
    }

    @Override
    public Type getRawType() {
      return raw;
    }

    @Override
    public Type getOwnerType() {
      return null;
    }

    @Override
    public boolean equals(Object other) {
      return other instanceof Generic g && g.raw.equals(raw) && Arrays.equals(g.args, args);
    }

    @Override
    public int hashCode() {
      return raw.hashCode() * 31 + Arrays.hashCode(args);
    }

    @Override
    public String toString() {
      return raw.getSimpleName() + Arrays.toString(args);
    }
  }

  /**
   * Read a parsed JSON value as {@code type}: a record (by component, using {@link Name}), {@code
   * String}, {@code Double}, {@code Long}, {@code Integer}, {@code Boolean}, {@code List}, {@code
   * Map} or {@code Object} (the value as it is). Fields the type does not name are ignored; a
   * missing field is null.
   *
   * @throws IllegalArgumentException when the value does not have that shape
   */
  public static <T> T bind(Object value, Class<T> type) {
    @SuppressWarnings("unchecked")
    T bound = (T) bindAt(value, type, "$");
    return bound;
  }

  /** {@link #bind(Object, Class)} for a generic type, such as {@code listOf(Foo.class)}. */
  public static Object bind(Object value, Type type) {
    return bindAt(value, type, "$");
  }

  private static Object bindAt(Object value, Type type, String path) {
    if (type instanceof WildcardType w) return bindAt(value, w.getUpperBounds()[0], path);
    if (type instanceof ParameterizedType p) {
      if (value == null) return null;
      Class<?> raw = (Class<?>) p.getRawType();
      Type[] args = p.getActualTypeArguments();
      if (List.class.isAssignableFrom(raw)) {
        List<Object> items = array(value);
        if (items == null) throw mismatch("an array", value, path);
        List<Object> out = new ArrayList<>(items.size());
        for (int i = 0; i < items.size(); i++) out.add(bindAt(items.get(i), args[0], path + "[" + i + "]"));
        return Collections.unmodifiableList(out);
      }
      if (Map.class.isAssignableFrom(raw)) {
        Map<String, Object> entries = object(value);
        if (entries == null) throw mismatch("an object", value, path);
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : entries.entrySet())
          out.put(e.getKey(), bindAt(e.getValue(), args[1], path + "." + e.getKey()));
        return Collections.unmodifiableMap(out);
      }
      return bindAt(value, raw, path);
    }
    if (!(type instanceof Class<?> c)) throw new IllegalArgumentException("Cannot bind to " + type);
    if (c == Object.class) return value;
    if (value == null) {
      if (c == boolean.class) return false;
      if (c == double.class) return 0.0;
      if (c == long.class) return 0L;
      if (c == int.class) return 0;
      return null;
    }
    if (c == String.class) {
      if (value instanceof String) return value;
      throw mismatch("a string", value, path);
    }
    if (c == Boolean.class || c == boolean.class) {
      if (value instanceof Boolean) return value;
      throw mismatch("a boolean", value, path);
    }
    if (c == Double.class || c == double.class) {
      if (value instanceof Number n) return n.doubleValue();
      throw mismatch("a number", value, path);
    }
    if (c == Long.class || c == long.class || c == Integer.class || c == int.class) {
      if (value instanceof Number n && n.doubleValue() == Math.rint(n.doubleValue()))
        return c == Long.class || c == long.class ? (Object) n.longValue() : (Object) n.intValue();
      throw mismatch("a whole number", value, path);
    }
    if (c.isRecord()) {
      Map<String, Object> fields = object(value);
      if (fields == null) throw mismatch("an object", value, path);
      RecordComponent[] components = c.getRecordComponents();
      Class<?>[] types = new Class<?>[components.length];
      Object[] args = new Object[components.length];
      for (int i = 0; i < components.length; i++) {
        String key = jsonName(components[i]);
        types[i] = components[i].getType();
        args[i] = bindAt(fields.get(key), components[i].getGenericType(), path + "." + key);
      }
      try {
        Constructor<?> constructor = c.getDeclaredConstructor(types);
        constructor.setAccessible(true);
        return constructor.newInstance(args);
      } catch (InvocationTargetException e) {
        throw new IllegalArgumentException("Cannot make " + c.getSimpleName() + " at " + path + ": " + e.getCause(), e);
      } catch (ReflectiveOperationException e) {
        throw new IllegalArgumentException("Cannot make " + c.getSimpleName() + ": " + e, e);
      }
    }
    if (c == List.class && value instanceof List) return value;
    if (c == Map.class && value instanceof Map) return value;
    if (c.isInstance(value)) return value;
    throw mismatch(c.getSimpleName(), value, path);
  }

  private static IllegalArgumentException mismatch(String expected, Object value, String path) {
    String got =
        value instanceof Map ? "an object" : value instanceof List ? "an array" : value instanceof String ? "a string" : String.valueOf(value);
    return new IllegalArgumentException("Expected " + expected + " at " + path + ", got " + got);
  }

  private static String jsonName(RecordComponent component) {
    Name name = component.getAnnotation(Name.class);
    return name != null ? name.value() : component.getName();
  }

  /**
   * A record as plain JSON values (its components by JSON name, null components left out), and
   * maps and lists with their contents the same way. Other values are returned as they are.
   */
  public static Object unbind(Object value) {
    if (value instanceof Record record) {
      Map<String, Object> out = new LinkedHashMap<>();
      for (RecordComponent component : record.getClass().getRecordComponents()) {
        Object field;
        try {
          java.lang.reflect.Method accessor = component.getAccessor();
          accessor.setAccessible(true);
          field = accessor.invoke(record);
        } catch (ReflectiveOperationException e) {
          throw new IllegalArgumentException("Cannot read " + component.getName() + ": " + e, e);
        }
        if (field != null) out.put(jsonName(component), unbind(field));
      }
      return out;
    }
    if (value instanceof Map<?, ?> map) {
      Map<String, Object> out = new LinkedHashMap<>();
      for (Map.Entry<?, ?> e : map.entrySet()) out.put(String.valueOf(e.getKey()), unbind(e.getValue()));
      return out;
    }
    if (value instanceof Iterable<?> items) {
      List<Object> out = new ArrayList<>();
      for (Object item : items) out.add(unbind(item));
      return out;
    }
    return value;
  }

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
      write(Arrays.asList((Object[]) value), out);
    } else if (value instanceof Record) {
      write(unbind(value), out);
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
