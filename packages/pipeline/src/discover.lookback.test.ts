import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@job-agent/core";
import { createLinkedInAdapter } from "@job-agent/sources";
import { runDiscover } from "./discover.ts";

const T0 = new Date("2026-10-14T10:00:00.000Z");
const hours = (n: number) => n * 3_600_000;

let db: Db;
let clock: Date;
type Runner = NonNullable<Parameters<typeof createLinkedInAdapter>[0]>["runWorker"];
type Search = Parameters<NonNullable<Runner>>[0];
let seen: Search[];
let reply: { exitCode: number; stdout: string };
beforeEach(() => {
  db = openDb(":memory:");
  clock = T0;
  seen = [];
  reply = { exitCode: 0, stdout: "" };
});
afterEach(() => db.$client.close());

const adapter = () =>
  createLinkedInAdapter({
    runWorker: async (s) => {
      seen.push(s);
      return reply;
    },
    sleep: async () => undefined,
    now: () => clock,
  });
const at = async (offsetHours: number) => {
  clock = new Date(T0.getTime() + hours(offsetHours));
  await runDiscover({
    db,
    adapters: [adapter()],
    now: () => clock,
    out: () => undefined,
    err: () => undefined,
  });
};

describe("JobSpy lookback through runDiscover", () => {
  it("covers the gap after an error, a block and backoff-skipped runs", async () => {
    await at(0); // ok, no earlier ok run
    expect(seen.map((s) => s.hours_old)).toEqual([24, 24]);
    seen = [];

    reply = { exitCode: 1, stdout: JSON.stringify({ error: "boom", kind: "error" }) };
    await at(1); // error
    reply = {
      exitCode: 2,
      stdout: JSON.stringify({ error: "response status code 429", kind: "blocked" }),
    };
    await at(2); // blocked, 6 h backoff until T0 + 8 h
    await at(3); // backoff skip
    await at(5); // backoff skip
    // each failing run stops after its first search; since stays T0, so +1 h -> 2 and +2 h -> 3
    expect(seen.map((s) => s.hours_old)).toEqual([2, 3]);
    seen = [];

    reply = { exitCode: 0, stdout: "" };
    await at(9);
    expect(seen.map((s) => s.hours_old)).toEqual([10, 10]); // 9 h + 10 min, rounded up
  });

  it("uses 24 h when there has never been an ok run", async () => {
    await at(0);
    expect(seen.map((s) => s.hours_old)).toEqual([24, 24]);
  });
});
