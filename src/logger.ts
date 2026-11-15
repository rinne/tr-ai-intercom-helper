const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type Level = (typeof LEVELS)[number];

export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

function plain(value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return code === undefined ? value.message : `${value.message} (${String(code)})`;
  }
  return value;
}

/**
 * A logger that writes JSON lines to standard error, so that standard output
 * stays free. The agent's token never reaches it: nothing here logs headers.
 */
export function createLogger(
  level: string,
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const threshold = Math.max(0, LEVELS.indexOf(level as Level));
  const at =
    (name: Exclude<Level, 'silent'>) =>
    (message: string, details: Record<string, unknown> = {}): void => {
      if (LEVELS.indexOf(name) < threshold) return;
      const extra = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, plain(v)]));
      write(
        `${JSON.stringify({ time: new Date().toISOString(), level: name, msg: message, ...extra })}\n`,
      );
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = createLogger('silent');
