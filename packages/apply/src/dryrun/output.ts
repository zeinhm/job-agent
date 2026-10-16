import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DRYRUNS_DIR = "dryruns";
export const SCREENSHOT_NAME = "screenshot.png";

/** The data dir is the folder that holds the DB, so a smoke run writes inside its smoke dir, never the repo's `data/`. */
export function dataDirOfDb(dbPath: string): string {
  if (dbPath === ":memory:")
    throw new Error("a dry run needs a DB file: its folder is the data dir");
  return dirname(resolve(dbPath));
}

/** Creates `path` (and parents below `root`) as 0700. Only dirs under `root` are touched. */
function privateDir(root: string, path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let current = path;
  while (current.startsWith(root) && current.length >= root.length) {
    chmodSync(current, 0o700);
    if (current === root) break;
    current = dirname(current);
  }
}

export interface PendingScreenshot {
  /** Directory holding the screenshot until the run id is known. */
  dir: string;
}

/** Writes the screenshot under `dryruns/<date>/.pending-<token>/` (dirs 0700, file 0600). */
export function writePendingScreenshot(
  dataDir: string,
  date: string,
  token: string,
  png: Buffer,
): PendingScreenshot {
  const root = join(resolve(dataDir), DRYRUNS_DIR);
  const dir = join(root, date, `.pending-${token}`);
  privateDir(root, dir);
  const file = join(dir, SCREENSHOT_NAME);
  writeFileSync(file, png, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { dir };
}

/** Moves the pending dir to `dryruns/<date>/<run id>/`; returns the screenshot path relative to the data dir. */
export function finalizeScreenshot(
  dataDir: string,
  date: string,
  pending: PendingScreenshot,
  runId: string,
): string {
  const target = join(resolve(dataDir), DRYRUNS_DIR, date, runId);
  renameSync(pending.dir, target);
  chmodSync(target, 0o700);
  return `${DRYRUNS_DIR}/${date}/${runId}/${SCREENSHOT_NAME}`;
}
