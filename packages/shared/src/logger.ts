/**
 * Scoped leveled logger. Sinks are pluggable; the default writes to console.
 * The main-process file sink is added by the engine boot (M3).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const levelWeight: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
  child(scope: string): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  sink?: (level: LogLevel, scope: string, message: string, data?: unknown) => void
}

function currentLevel(): LogLevel {
  const raw = globalThis.process?.env?.ARI_LOG_LEVEL
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return 'info'
}

const defaultSink = (level: LogLevel, scope: string, message: string, data?: unknown): void => {
  const line = `[ari:${scope}] ${message}`
  if (data === undefined) {
    console[level === 'debug' ? 'log' : level](line)
  } else {
    console[level === 'debug' ? 'log' : level](line, data)
  }
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const threshold = levelWeight[options.level ?? currentLevel()]
  const sink = options.sink ?? defaultSink

  const emit = (level: LogLevel, message: string, data?: unknown): void => {
    if (levelWeight[level] < threshold) return
    sink(level, scope, message, data)
  }

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (sub) => createLogger(`${scope}:${sub}`, options),
  }
}
