// ─── Structured Logger ───────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

export interface LoggerConfig {
  level?: LogLevel;
  format?: "text" | "json";
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private minLevel: number;
  private jsonFormat: boolean;

  constructor(config?: LoggerConfig) {
    const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
    const envFormat = process.env.LOG_FORMAT;
    this.minLevel = LOG_LEVELS[config?.level ?? envLevel ?? "info"];
    this.jsonFormat = (config?.format ?? envFormat) === "json";
  }

  log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const entry: LogEntry = {
      level,
      category,
      message,
      data,
      timestamp: Date.now(),
    };

    if (this.jsonFormat) {
      this.writeJson(entry);
    } else {
      this.writeText(entry);
    }
  }

  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("debug", category, message, data);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("info", category, message, data);
  }

  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("warn", category, message, data);
  }

  error(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("error", category, message, data);
  }

  private writeJson(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  private writeText(entry: LogEntry): void {
    const ts = new Date(entry.timestamp).toISOString();
    const prefix = `[${ts}] ${entry.level.toUpperCase().padEnd(5)} [${entry.category}]`;
    const msg = entry.data
      ? `${prefix} ${entry.message} ${JSON.stringify(entry.data)}`
      : `${prefix} ${entry.message}`;

    if (entry.level === "error") {
      console.error(msg);
    } else {
      console.log(msg);
    }
  }
}
