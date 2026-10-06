export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (line: string) => void;
export type Logger = Record<LogLevel, (msg: string, fields?: Record<string, unknown>) => void>;

const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

export function createLogger(
  sink: LogSink = stderrSink,
  now: () => Date = () => new Date(),
): Logger {
  const emit =
    (level: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      sink(JSON.stringify({ ...fields, ts: now().toISOString(), level, msg }));
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const log = createLogger();
