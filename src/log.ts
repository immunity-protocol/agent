/**
 * Minimal structured logger. One line per event, JSON-ish, so container logs
 * are greppable. No dependency — keeps the image small.
 */
type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const head = `${ts} ${level.toUpperCase()} [${scope}] ${msg}`;
  if (fields && Object.keys(fields).length > 0) {
    // eslint-disable-next-line no-console
    console.log(head, JSON.stringify(fields));
  } else {
    // eslint-disable-next-line no-console
    console.log(head);
  }
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
  };
}
