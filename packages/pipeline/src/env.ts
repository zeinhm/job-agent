import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const KEY_LINE = /^(export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=/;

/** The repo's `.env`, found from this file's location (not the cwd); `JOB_AGENT_ENV_FILE` overrides it (tests, bin/smoke). */
export function defaultEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.JOB_AGENT_ENV_FILE || resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env")
  );
}

/**
 * Loads KEY=VALUE lines from the env file into `env`, only for keys that are not set yet (the environment wins).
 * A missing file is silent. An unreadable file, or a line that is not `KEY=...`, gives one stderr line that names the
 * file and nothing else: never a key, a value or a count of values.
 */
export function loadEnvFile(
  err: (text: string) => void,
  path: string = defaultEnvFile(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      err(`job-agent: could not read ${path}, continuing without it\n`);
    return;
  }
  const invalid = text
    .split(/\r?\n/)
    .some((l) => l.trim() !== "" && !l.trim().startsWith("#") && !KEY_LINE.test(l.trim()));
  if (invalid) err(`job-agent: ${path} has a line that is not KEY=VALUE, ignored\n`);
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(text);
  } catch {
    err(`job-agent: could not parse ${path}, continuing without it\n`);
    return;
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (v !== undefined && !(k in env)) env[k] = v;
  }
}
