// Satisfies: O1 (structured JSON logs per request), RT-6.3 (log deferred after response)

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  event: string;
  [k: string]: unknown;
}

export interface StructuredLogger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

export interface LoggerOptions {
  /** When true (RT-12), timestamps become a monotonic counter and request-IDs are normalised. */
  deterministic?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}): StructuredLogger {
  const stdout = opts.stdout ?? ((line): void => {
    process.stdout.write(line + '\n');
  });
  const stderr = opts.stderr ?? ((line): void => {
    process.stderr.write(line + '\n');
  });
  let counter = 0;
  const now = opts.deterministic
    ? (): number => {
        counter += 1;
        return counter;
      }
    : (): number => Date.now();

  function emit(level: LogLevel, fields: LogFields): void {
    const payload: Record<string, unknown> = { level, ts: now(), ...fields };
    const line = JSON.stringify(payload, replacer);
    if (level === 'error') stderr(line);
    else stdout(line);
  }

  return {
    info: (fields): void => emit('info', fields),
    warn: (fields): void => emit('warn', fields),
    error: (fields): void => emit('error', fields),
  };
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
