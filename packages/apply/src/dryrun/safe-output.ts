/**
 * The one place that decides what an operator-facing dry-run command may print: fixed text, enum values, counts, ids,
 * labels and answer key names. Never an error message, stack text, answer value, contact datum, review note or (for the
 * operator) a screenshot path.
 */

/** Longest label or stop detail printed on one line. */
export const MAX_PRINTED = 160;

/**
 * Text that came from a page or the database (a label, a stop detail) made safe for one output line: control
 * characters, newlines and Unicode line / paragraph separators removed, at most `MAX_PRINTED` characters. A page
 * cannot forge an extra output line with it.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .trim()
    .slice(0, MAX_PRINTED);
}

/**
 * The first stack frame line. The stack starts with `Name: message`, and a message line can look like a frame, so the
 * header is skipped first: the search starts after the last occurrence of the message (what follows it is only frames).
 * A stack that does not contain its message (replaced or altered) yields no frame.
 */
function topFrame(err: Error): string | undefined {
  const stack = err.stack ?? "";
  const end =
    err.message === ""
      ? stack.indexOf("\n")
      : stack.lastIndexOf(err.message) === -1
        ? -1
        : stack.lastIndexOf(err.message) + err.message.length;
  if (end === -1) return undefined;
  return stack
    .slice(end)
    .split("\n")
    .find((l) => l.trimStart().startsWith("at "));
}

/** `<ErrorName> at <path>:<line>` of the top stack frame, path cut to start at apps/, packages/ or node_modules/. */
export function errorWhere(err: unknown): string {
  const rawName = err instanceof Error ? err.name : "NonError";
  // A name is code, but a thrown object can set any string: only identifier-like names are printed.
  const name = /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(rawName) ? rawName : "Error";
  const frame = err instanceof Error ? topFrame(err) : undefined;
  const m = frame === undefined ? null : /([^\s()]+):(\d+):\d+\)?\s*$/.exec(frame);
  if (m?.[1] === undefined) return name;
  const path = m[1].replace(/^file:\/\//, "");
  const cut = path.search(/(?:apps|packages|node_modules)\//);
  return `${name} at ${sanitizeText(cut >= 0 ? path.slice(cut) : (path.split("/").pop() ?? path))}:${m[2]}`;
}

/** `<command>: error <ErrorName> at <path>:<line>`: what an unexpected error prints. Never `message` or stack text. */
export function errorLine(command: string, err: unknown): string {
  return `${command}: error ${errorWhere(err)}\n`;
}

/** `<command>: refused: <reason>` for a refusal. `reason` must be fixed text or an id; it is sanitised as well. */
export function refusalLine(command: string, reason: string): string {
  return `${command}: refused: ${sanitizeText(reason)}\n`;
}
