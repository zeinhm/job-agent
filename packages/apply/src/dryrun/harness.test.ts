import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dry_run_fields, dry_runs, openDb, postings, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_INSTALL_COMMAND, BrowserMissingError, launchChromium } from "./browser.ts";
import { dataDirOfDb } from "./output.ts";
import {
  HarnessRefusalError,
  openDryRunSession,
  type DryRunSession,
  type DryRunSessionOptions,
} from "./session.ts";
import {
  openPartiallyGuardedPage,
  pageOf,
  resetRunLimit,
  settle,
  startFixtureServer,
  type FixtureServer,
} from "./testing.ts";

const T0 = "2026-10-01T10:00:00.000Z";

let server: FixtureServer;
let browser: Browser;
let dir: string;
let db: Db;
let open: DryRunSession[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
  // Fails loudly with the install command when Chromium is missing: no skip.
  browser = await launchChromium({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(() => {
  resetRunLimit();
  server.requests.length = 0;
  dir = mkdtempSync(join(tmpdir(), "dryrun-"));
  db = openDb(join(dir, "test.db"));
  db.insert(postings)
    .values({
      id: "p1",
      source: "greenhouse",
      external_id: "p1",
      url: "https://fake.example.com/jobs/p1",
      title: "Senior Backend Engineer",
      company_name: "Fake Co",
      first_seen_at: T0,
      last_seen_at: T0,
    })
    .run();
});

afterEach(async () => {
  await Promise.all(open.map((s) => s.close()));
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  path: string,
  extra: Partial<DryRunSessionOptions> = {},
): Promise<DryRunSession> {
  const session = await openDryRunSession({
    db,
    dataDir: dataDirOfDb(join(dir, "test.db")),
    postingId: "p1",
    ats: "greenhouse",
    url: `${server.origin}${path}`,
    fixture: true,
    ...extra,
  });
  open.push(session);
  return session;
}

const paths = (list: { path: string }[]) => list.map((r) => r.path).sort();

describe("no request can submit", () => {
  it("a page that POSTs on load, change and submit reaches the server with zero non-GET requests", async () => {
    const session = await start("/form");
    const page = pageOf(session);
    await session.fill({ label: "Full name" }, "Fake Person");
    await page.locator("#name").press("Enter");
    await page.evaluate("window.callSubmit()");
    await settle(page);

    expect(server.nonGet()).toEqual([]);
    expect(server.requests.some((r) => r.path === "/apply")).toBe(false);

    // Every attempt that reached the network layer was recorded: method, host, path.
    expect(paths(session.aborted.filter((a) => a.kind === "request"))).toEqual(
      ["/hit/change-fetch", "/hit/load-fetch", "/hit/load-xhr"].sort(),
    );
    for (const a of session.aborted) {
      expect(Object.keys(a).sort()).toEqual(["host", "kind", "method", "path", "reason"]);
      expect(a.method).toBe("POST");
      expect(a.host).toBe(`127.0.0.1:${server.port}`);
    }
    // The in-page layer recorded what it stopped before the network: beacons, submit(), requestSubmit(), Enter.
    const kinds = session.attempts.map((a) => a.kind);
    expect(kinds.filter((k) => k === "send_beacon")).toHaveLength(2);
    expect(kinds).toContain("form_submit_call");
    expect(kinds).toContain("form_request_submit_call");
    expect(kinds).toContain("submit_event");
    console.log("aborted requests (fixture test):", JSON.stringify(session.aborted));
    console.log("page attempts (fixture test):", JSON.stringify(session.attempts));
  }, 60_000);

  it("the request guard alone still blocks fetch, XHR, beacon and a native form POST (second layer)", async () => {
    const { context, page, aborted } = await openPartiallyGuardedPage(browser, {
      requestGuard: { ats: "greenhouse", fixture: true },
    });
    try {
      await page.goto(`${server.origin}/form`);
      await page.locator("#name").fill("Fake Person");
      await page.locator("#name").blur();
      await page.locator("#name").press("Enter");
      await settle(page);

      expect(server.nonGet()).toEqual([]);
      expect(paths(aborted)).toEqual(
        [
          "/apply",
          "/hit/change-beacon",
          "/hit/change-fetch",
          "/hit/load-beacon",
          "/hit/load-fetch",
          "/hit/load-xhr",
          "/hit/submit-fetch",
        ].sort(),
      );
    } finally {
      await context.close();
    }
  }, 60_000);

  it("twin: the same page with the guard removed DOES deliver the POSTs (so the test above can fail)", async () => {
    const { context, page } = await openPartiallyGuardedPage(browser, {});
    try {
      await page.goto(`${server.origin}/form`);
      await page.locator("#name").fill("Fake Person");
      await page.locator("#name").blur();
      await page.locator("#name").press("Enter");
      await settle(page);

      const got = paths(server.nonGet());
      for (const p of [
        "/apply",
        "/hit/change-beacon",
        "/hit/change-fetch",
        "/hit/load-beacon",
        "/hit/load-fetch",
        "/hit/load-xhr",
      ]) {
        expect(got).toContain(p);
      }
      console.log("twin (guard removed) server saw:", JSON.stringify(server.nonGet()));
    } finally {
      await context.close();
    }
  }, 60_000);

  it("blocks WebSockets (in-page layer and request layer)", async () => {
    const session = await start("/ws");
    await settle(pageOf(session));
    expect(server.upgrades).toBe(0);
    expect(session.attempts.map((a) => a.kind)).toContain("websocket_construct");

    const { context, page, aborted } = await openPartiallyGuardedPage(browser, {
      requestGuard: { ats: "greenhouse", fixture: true },
    });
    try {
      await page.goto(`${server.origin}/ws`);
      await settle(page);
      expect(server.upgrades).toBe(0);
      expect(aborted.some((a) => a.kind === "websocket" && a.path === "/socket")).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("blocks service workers", async () => {
    const session = await start("/sw");
    const page = pageOf(session);
    await page.waitForFunction("document.title !== ''");
    expect(await page.title()).toBe("registrations:0");
  }, 60_000);

  it("fixture mode aborts every request to a host other than 127.0.0.1, even a GET", async () => {
    const session = await start("/outside");
    await settle(pageOf(session));
    expect(server.requests.some((r) => r.path === "/outside-hit")).toBe(false);
    expect(session.aborted).toEqual([
      {
        kind: "request",
        method: "GET",
        host: `localhost:${server.port}`,
        path: "/outside-hit",
        reason: "host",
      },
    ]);
  }, 60_000);

  it("Ashby: only allowlisted read-only GraphQL queries reach the server", async () => {
    const session = await start("/ashby", { ats: "ashby" });
    await settle(pageOf(session));
    const posts = server.nonGet();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ method: "POST", path: "/api/non-user-graphql" });
    expect(session.aborted).toHaveLength(3);
    expect(session.aborted.every((a) => a.reason === "method")).toBe(true);
  }, 60_000);
});

describe("helpers never submit", () => {
  it("fill / select / check / upload work on plain fields", async () => {
    const session = await start("/form");
    await session.fill({ css: "#name" }, "Fake Person");
    await session.select({ css: "#pick" }, { label: "Beta" });
    await session.check({ css: "#agree" });
    const page = pageOf(session);
    expect(await page.locator("#name").inputValue()).toBe("Fake Person");
    expect(await page.locator("#pick").inputValue()).toBe("b");
    expect(await page.locator("#agree").isChecked()).toBe(true);
    const file = join(dir, "resume.pdf");
    (await import("node:fs")).writeFileSync(file, "%PDF-1.4 fake");
    await session.upload({ css: "#cv" }, file);
    expect(
      await page
        .locator("#cv")
        .evaluate((el) => (el as unknown as { files: unknown[] }).files.length),
    ).toBe(1);
    expect(server.nonGet()).toEqual([]);
  }, 60_000);

  it.each(["#go", "#go2", "#btn-submit", "#in-role"])(
    "refuses %s (submit control or inside a button-like element)",
    async (css) => {
      const session = await start("/form");
      await expect(session.fill({ css }, "x")).rejects.toBeInstanceOf(HarnessRefusalError);
      await expect(session.check({ css })).rejects.toBeInstanceOf(HarnessRefusalError);
    },
    60_000,
  );

  it("refuses the wrong control type and ambiguous or missing elements", async () => {
    const session = await start("/form");
    await expect(session.fill({ css: "#agree" }, "x")).rejects.toThrow(/cannot fill/);
    await expect(session.select({ css: "#name" }, { value: "a" })).rejects.toThrow(/cannot select/);
    await expect(session.upload({ css: "#name" }, "/nope")).rejects.toThrow(/cannot upload/);
    await expect(session.fill({ css: "#missing" }, "x")).rejects.toThrow(/found 0/);
  }, 60_000);

  it("has no click, press or generic evaluate API", async () => {
    const session = await start("/form");
    for (const name of ["click", "press", "evaluate", "submit", "page", "goto"]) {
      expect(name in session).toBe(false);
    }
  }, 60_000);

  it("allows one run per process", async () => {
    await start("/plain");
    await expect(start("/plain")).rejects.toThrow(/one dry run per process/);
  }, 60_000);
});

describe("stop detectors", () => {
  it.each([
    ["/captcha-google", "captcha"],
    ["/captcha-hcaptcha", "captcha"],
    ["/captcha-turnstile", "captcha"],
    ["/login", "login_wall"],
    ["/redirect-apply", "login_wall"],
    ["/missing", "page_error"],
  ])(
    "%s stops with %s before any field is filled and still takes a screenshot",
    async (path, reason) => {
      const session = await start(path);
      expect(session.stop?.reason).toBe(reason);
      await expect(session.fill({ css: "input" }, "x")).rejects.toThrow(/run is stopped/);

      const run = await session.finish({
        status: "filled",
        fields: [
          {
            label: "A",
            field_type: "text",
            required: true,
            source: "standard",
            filled: true,
            value: "v",
          },
        ],
      });
      expect(run.stopReason).toBe(reason);
      expect(run.status).toBe(reason === "page_error" ? "error" : "stopped");
      expect(existsSync(join(dir, run.screenshotPath))).toBe(true);
      expect(
        db.select().from(dry_run_fields).where(eq(dry_run_fields.dry_run_id, run.runId)).all(),
      ).toEqual([]);
    },
    60_000,
  );

  it("a clean form is not stopped", async () => {
    const session = await start("/plain");
    expect(session.stop).toBeNull();
  }, 60_000);
});

describe("output", () => {
  it("writes the screenshot under <data dir>/dryruns/<date>/<run id>/ (0700 / 0600) and the run + fields in the DB", async () => {
    const session = await start("/form");
    await session.fill({ css: "#name" }, "Fake Person");
    const run = await session.finish({
      status: "needs_input",
      stop_reason: "uncovered_question",
      stop_detail: "1 uncovered",
      fields: [
        {
          label: "Full name",
          field_type: "text",
          required: true,
          source: "standard",
          filled: true,
          value: "Fake Person",
        },
      ],
    });

    const day = new Date().toISOString().slice(0, 10);
    expect(run.screenshotPath).toBe(`dryruns/${day}/${run.runId}/screenshot.png`);
    const file = join(dir, run.screenshotPath);
    expect(statSync(file).size).toBeGreaterThan(100);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const d of [
      join(dir, "dryruns"),
      join(dir, "dryruns", day),
      join(dir, "dryruns", day, run.runId),
    ]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    const row = db.select().from(dry_runs).where(eq(dry_runs.id, run.runId)).get();
    expect(row).toMatchObject({
      posting_id: "p1",
      ats_type: "greenhouse",
      status: "needs_input",
      stop_reason: "uncovered_question",
      screenshot_path: run.screenshotPath,
      fixture: true,
    });
    expect(
      db.select().from(dry_run_fields).where(eq(dry_run_fields.dry_run_id, run.runId)).all(),
    ).toHaveLength(1);
  }, 60_000);

  it("a filled run whose page tried to submit is recorded as stopped (blocked_request)", async () => {
    const session = await start("/form");
    await pageOf(session).evaluate("window.callSubmit()");
    const run = await session.finish({ status: "filled", fields: [] });
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("blocked_request");
  }, 60_000);

  it("finish closes the session: nothing can be filled afterwards", async () => {
    const session = await start("/form");
    await session.finish({ status: "needs_input", stop_reason: "uncovered_question" });
    await expect(session.fill({ css: "#name" }, "x")).rejects.toThrow(/finished/);
    await expect(session.finish()).rejects.toThrow(/finished/);
  }, 60_000);

  it("data dir is the DB's folder", () => {
    expect(dataDirOfDb(join(dir, "test.db"))).toBe(dir);
    expect(() => dataDirOfDb(":memory:")).toThrow();
  });
});

describe("browser install", () => {
  it("a missing Chromium fails with the one install command", () => {
    const err = new BrowserMissingError();
    expect(err.message).toContain(BROWSER_INSTALL_COMMAND);
    expect(BROWSER_INSTALL_COMMAND).toBe("pnpm playwright:install");
  });
});
