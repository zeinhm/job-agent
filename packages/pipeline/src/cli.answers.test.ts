import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { answer_bank, openDb } from "@job-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../../config");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-agent-answers-"));
  vi.stubEnv("JOB_AGENT_CONFIG_DIR", dir);
  vi.stubEnv("JOB_AGENT_DB", join(dir, "test.db"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const done = main(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return done.then((code) => ({ code, out: out.join(""), err: err.join("") }));
}

describe("answers import", () => {
  it("imports the example file, then a second run changes nothing", async () => {
    copyFileSync(join(exampleDir, "answers.example.yaml"), join(dir, "answers.yaml"));
    const first = await run(["answers", "import"]);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^answers import: (\d+) added, 0 updated, 0 unchanged, 0 kept\n$/);
    const second = await run(["answers", "import"]);
    expect(second.code).toBe(0);
    const added = /: (\d+) added/.exec(first.out)?.[1];
    expect(second.out).toBe(`answers import: 0 added, 0 updated, ${added} unchanged, 0 kept\n`);
    expect(first.out + second.out).not.toContain("Alex Example");
  });

  it("prints no answer text and exits 1 on an invalid file", async () => {
    writeFileSync(join(dir, "answers.yaml"), "g:\n  k: { answer: FAKE-SECRET, approved: maybe }\n");
    const r = await run(["answers", "import"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("g.k.approved");
    expect(r.out + r.err).not.toContain("FAKE-SECRET");
    const db = openDb(join(dir, "test.db"));
    expect(db.select().from(answer_bank).all()).toEqual([]);
    db.$client.close();
  });

  it("reports a missing file and imports nothing", async () => {
    const r = await run(["answers", "import"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      "answers.yaml not found, answer bank empty\nanswers import: 0 added, 0 updated, 0 unchanged, 0 kept\n",
    );
  });

  it("rejects a missing or unknown subcommand", async () => {
    expect((await run(["answers"])).code).toBe(1);
    expect((await run(["answers", "export"])).code).toBe(1);
  });
});
