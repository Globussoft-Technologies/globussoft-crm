/**
 * Tiny structured logger. Swap the sink for pino/winston later without touching
 * call sites. Keeps logs greppable: every line is `LEVEL [scope] message {json}`.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, msg: string, meta?: unknown) {
  const line = `${level.toUpperCase()} [${scope}] ${msg}`;
  const payload = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line + payload);
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** Create a logger bound to a scope, e.g. `createLogger('orchestrator')`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
  };
}
