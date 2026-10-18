import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCK_STALE_MS, acquireOwner, ownerWaiting, tryAcquire } from "./lock.ts";

let dir: string;
const lockDir = () => join(dir, "locks", "dryrun");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dry-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Makes the lock directory look `ms` old. */
function age(ms: number): void {
  const t = new Date(Date.now() - ms);
  utimesSync(lockDir(), t, t);
}

function must(r: ReturnType<typeof tryAcquire>) {
  if (!r.ok) throw new Error("lock not taken");
  return r;
}

describe("dry-run lock", () => {
  it("takes a free lock under <data dir>/locks/dryrun and releases it", () => {
    const a = must(tryAcquire(dir, "operator"));
    expect(existsSync(lockDir())).toBe(true);
    a.release();
    expect(existsSync(lockDir())).toBe(false);
  });

  it("refuses a second run while the first holds it and says who holds it", () => {
    const a = must(tryAcquire(dir, "operator"));
    expect(tryAcquire(dir, "owner")).toEqual({ ok: false, holder: "operator" });
    expect(tryAcquire(dir, "operator")).toEqual({ ok: false, holder: "operator" });
    a.release();
    const b = must(tryAcquire(dir, "owner"));
    expect(tryAcquire(dir, "operator")).toEqual({ ok: false, holder: "owner" });
    b.release();
  });

  it("takes over a stale lock; a fresh one is left alone", () => {
    must(tryAcquire(dir, "operator"));
    age(LOCK_STALE_MS - 60_000);
    expect(tryAcquire(dir, "owner").ok).toBe(false);
    age(LOCK_STALE_MS + 60_000);
    const b = must(tryAcquire(dir, "owner"));
    expect(b.kind).toBe("owner");
    expect(tryAcquire(dir, "operator")).toEqual({ ok: false, holder: "owner" });
    expect(existsSync(`${lockDir()}.takeover`)).toBe(false);
  });

  it("a takeover never removes a lock another run took over between the age check and the takeover", () => {
    must(tryAcquire(dir, "operator"));
    age(LOCK_STALE_MS + 60_000);
    let rival: ReturnType<typeof tryAcquire> | undefined;
    const r = tryAcquire(dir, "owner", {
      beforeTakeover: () => {
        // Another run does the whole takeover first and now holds a fresh lock.
        rmSync(lockDir(), { recursive: true });
        rival = tryAcquire(dir, "operator");
      },
    });
    expect(rival?.ok).toBe(true);
    expect(r).toEqual({ ok: false, holder: "operator" });
    expect(existsSync(lockDir())).toBe(true);
  });

  it("a run that finds a takeover in progress is refused and leaves the lock alone", () => {
    must(tryAcquire(dir, "operator"));
    age(LOCK_STALE_MS + 60_000);
    mkdirSync(`${lockDir()}.takeover`); // another run is inside its takeover right now
    expect(tryAcquire(dir, "owner")).toEqual({ ok: false, holder: "operator" });
    expect(existsSync(`${lockDir()}.takeover`)).toBe(true);
  });

  it("clears a takeover lock a killed run left behind, then the next run takes over", () => {
    must(tryAcquire(dir, "operator"));
    age(LOCK_STALE_MS + 60_000);
    mkdirSync(`${lockDir()}.takeover`);
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(`${lockDir()}.takeover`, old, old);
    expect(tryAcquire(dir, "owner").ok).toBe(false);
    expect(existsSync(`${lockDir()}.takeover`)).toBe(false);
    expect(tryAcquire(dir, "owner").ok).toBe(true);
  });

  it("a holder whose lock was taken over does not remove the new holder's lock", () => {
    const a = must(tryAcquire(dir, "operator"));
    age(LOCK_STALE_MS + 60_000);
    const b = must(tryAcquire(dir, "owner"));
    a.release();
    expect(tryAcquire(dir, "operator")).toEqual({ ok: false, holder: "owner" });
    b.release();
    expect(existsSync(lockDir())).toBe(false);
  });

  it("a lock without a holder file counts as held by an unknown holder", () => {
    mkdirSync(lockDir(), { recursive: true });
    expect(tryAcquire(dir, "owner")).toEqual({ ok: false, holder: "unknown" });
  });
});

describe("owner run waits for the operator's current form", () => {
  it("says so once, is marked as waiting while it waits, then runs when the form ends", async () => {
    const op = must(tryAcquire(dir, "operator"));
    const said: string[] = [];
    let polls = 0;
    const seenWaiting: boolean[] = [];
    const r = await acquireOwner(dir, () => said.push("waiting"), {
      sleep: async () => {
        polls++;
        seenWaiting.push(ownerWaiting(dir));
        if (polls === 3) op.release(); // the operator's form ends
      },
    });
    expect(r.ok).toBe(true);
    expect(said).toEqual(["waiting"]);
    expect(seenWaiting).toEqual([true, true, true]);
    // The mark is gone once the owner holds the lock.
    expect(ownerWaiting(dir)).toBe(false);
    expect(readdirSync(join(dir, "locks")).filter((n) => n.includes("waiting"))).toEqual([]);
    if (r.ok) expect(r.kind).toBe("owner");
  });

  it("does not wait at all for a free lock", async () => {
    let said = 0;
    const r = await acquireOwner(dir, () => said++);
    expect(r.ok).toBe(true);
    expect(said).toBe(0);
  });

  it("does not wait for another owner run", async () => {
    must(tryAcquire(dir, "owner"));
    let said = 0;
    const r = await acquireOwner(dir, () => said++);
    expect(r).toEqual({ ok: false, holder: "owner" });
    expect(said).toBe(0);
  });

  it("the wait is bounded: a form that never ends goes stale and is taken over", async () => {
    must(tryAcquire(dir, "operator"));
    let clock = Date.now();
    const r = await acquireOwner(dir, () => undefined, {
      now: () => clock,
      sleep: async () => {
        clock += 5 * 60_000; // five minutes pass per look
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("owner");
  });

  it("the mark is removed when the waiting run throws, and an abandoned mark expires", async () => {
    must(tryAcquire(dir, "operator"));
    await expect(
      acquireOwner(dir, () => undefined, {
        sleep: async () => {
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    expect(ownerWaiting(dir)).toBe(false);

    // A mark a killed run left behind stops counting after the wait bound.
    const mark = join(dir, "locks", "dryrun.owner-waiting-left-behind");
    writeFileSync(mark, "x\n");
    expect(ownerWaiting(dir)).toBe(true);
    const old = new Date(Date.now() - LOCK_STALE_MS - 10 * 60_000);
    utimesSync(mark, old, old);
    expect(ownerWaiting(dir)).toBe(false);
  });
});
