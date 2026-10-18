import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The dry-run lock: never two real dry runs at once. A mkdir lock at `<data dir>/locks/dryrun` (like `bin/run-hourly`),
 * with the holder's kind and a token in `holder` inside it. The owner's own `dry-run` wins over the operator: it waits for
 * the one form the operator is on (and says so), and while it waits the operator is refused.
 */

export type LockKind = "owner" | "operator";

/** A lock older than this is a crashed run and is taken over. A form takes about a minute; a headed one can take longer. */
export const LOCK_STALE_MS = 30 * 60_000;
/** A takeover lock left by a killed run is cleared after this. */
export const TAKEOVER_STALE_MS = 10 * 60_000;
/** How often a waiting owner run looks at the lock again. */
export const WAIT_POLL_MS = 1_000;

const LOCK_NAME = "dryrun";
const WAITING_PREFIX = `${LOCK_NAME}.owner-waiting-`;

export interface LockOptions {
  /** Clock in ms; tests move it. */
  now?: () => number;
  /** Age after which a lock is stale; tests shorten it. */
  staleMs?: number;
  /** Wait between looks of a waiting owner run; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: runs between the stale check and the takeover, to stage a rival that takes the lock over first. */
  beforeTakeover?: () => void;
}

export type Acquired =
  | { ok: true; kind: LockKind; release: () => void }
  | {
      ok: false;
      /** Who holds the lock: `unknown` while it is being created (or a crash left it without a holder file). */
      holder: LockKind | "unknown";
    };

const locksDir = (dataDir: string): string => join(dataDir, "locks");
const lockPath = (dataDir: string): string => join(locksDir(dataDir), LOCK_NAME);

function ageMs(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readHolder(lock: string): { kind: LockKind; token: string } | null {
  try {
    const [kind, token] = readFileSync(join(lock, "holder"), "utf8").trim().split(" ");
    if ((kind === "owner" || kind === "operator") && token !== undefined && token !== "")
      return { kind, token };
  } catch {
    // no holder file (yet)
  }
  return null;
}

function take(lock: string, kind: LockKind): Acquired | null {
  try {
    mkdirSync(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  const token = randomUUID();
  writeFileSync(join(lock, "holder"), `${kind} ${token}\n`);
  return {
    ok: true,
    kind,
    release: () => {
      // Only the holder removes its own lock: one that was taken over meanwhile belongs to someone else.
      if (readHolder(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
    },
  };
}

/**
 * One try. Takes the lock when free; takes over a stale one (older than `staleMs`) under a short-lived `dryrun.takeover`
 * mkdir lock that checks the age again, so a lock another run just took over is never removed.
 */
export function tryAcquire(dataDir: string, kind: LockKind, opts: LockOptions = {}): Acquired {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const lock = lockPath(dataDir);
  mkdirSync(locksDir(dataDir), { recursive: true });
  const first = take(lock, kind);
  if (first !== null) return first;
  const isStale = (): boolean => {
    const age = ageMs(lock, now());
    return age !== null && age > staleMs;
  };
  if (isStale()) {
    opts.beforeTakeover?.();
    const takeover = `${lock}.takeover`;
    try {
      mkdirSync(takeover);
      try {
        // Only one run is in here at a time, and the age is checked again inside.
        if (isStale()) {
          rmSync(lock, { recursive: true, force: true });
          const got = take(lock, kind);
          if (got !== null) return got;
        }
      } finally {
        rmdirSync(takeover);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A takeover lock left by a killed run: cleared once clearly abandoned; this run is refused, the next one takes over.
      const t = ageMs(takeover, now());
      if (t !== null && t > TAKEOVER_STALE_MS) rmSync(takeover, { recursive: true, force: true });
    }
  }
  return { ok: false, holder: readHolder(lock)?.kind ?? "unknown" };
}

/**
 * True while an owner run waits for the operator's current form (a mark younger than the wait bound). A mark left by a
 * crashed owner run refuses the operator until it ages out (about 32 minutes by default): it fails safe.
 */
export function ownerWaiting(dataDir: string, opts: LockOptions = {}): boolean {
  const now = (opts.now ?? Date.now)();
  const bound = (opts.staleMs ?? LOCK_STALE_MS) + 2 * 60_000;
  let names: string[];
  try {
    names = readdirSync(locksDir(dataDir));
  } catch {
    return false;
  }
  return names.some((n) => {
    if (!n.startsWith(WAITING_PREFIX)) return false;
    const age = ageMs(join(locksDir(dataDir), n), now);
    return age !== null && age < bound;
  });
}

/**
 * The owner's `dry-run`: takes the lock. When the operator holds it, `onWait` is called once (the one printed line), the
 * run is marked as waiting and polls until that one form ends; a lock that never ends turns stale and is taken over, so the
 * wait is bounded. Another owner run holding the lock is not waited for (`ok: false`, holder `owner`).
 */
export async function acquireOwner(
  dataDir: string,
  onWait: () => void,
  opts: LockOptions = {},
): Promise<Acquired> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const started = now();
  let mark: string | null = null;
  try {
    for (;;) {
      const got = tryAcquire(dataDir, "owner", opts);
      if (got.ok || got.holder === "owner") return got;
      if (mark === null) {
        onWait();
        mark = join(locksDir(dataDir), `${WAITING_PREFIX}${randomUUID()}`);
        writeFileSync(mark, `${new Date(now()).toISOString()}\n`);
      }
      // Past the stale age plus a margin the lock would have been taken over: give up instead of waiting for ever.
      if (now() - started > staleMs + 60_000) return got;
      await sleep(WAIT_POLL_MS);
    }
  } finally {
    if (mark !== null) rmSync(mark, { force: true });
  }
}
