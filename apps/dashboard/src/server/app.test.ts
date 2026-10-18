import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb, type Db } from "@job-agent/core";
import { createApp, errorWhere } from "./app.ts";
import { parseBody, parseQuery } from "./validate.ts";
import { startServer, type RunningServer } from "./server.ts";

const PORT = 4510;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const JSON_CT = { "Content-Type": "application/json" };

let db: Db;
let logs: string[];
let webDir: string;
beforeEach(() => {
  db = openDb(":memory:");
  logs = [];
  webDir = mkdtempSync(join(tmpdir(), "dash-web-"));
});
afterEach(() => rmSync(webDir, { recursive: true, force: true }));

function app() {
  return createApp(db, { port: PORT, webDir, logError: (l) => logs.push(l) });
}
const get = (path: string, headers: Record<string, string> = { Host: HOST }) =>
  app().request(`http://x${path}`, { headers });
const post = (headers: Record<string, string>, path = "/api/health") =>
  app().request(`http://x${path}`, { method: "POST", headers, body: "{}" });

describe("host guard", () => {
  it("answers 127.0.0.1:<port> and localhost:<port>", async () => {
    expect((await get("/api/health", { Host: HOST })).status).toBe(200);
    expect((await get("/api/health", { Host: `localhost:${PORT}` })).status).toBe(200);
  });

  it("421s a foreign Host", async () => {
    expect((await get("/api/health", { Host: "evil.example:4510" })).status).toBe(421);
  });

  it("421s a rebinding-style Host", async () => {
    expect((await get("/api/health", { Host: "127.0.0.1.evil.example" })).status).toBe(421);
    expect((await get("/api/health", { Host: `127.0.0.1.evil.example:${PORT}` })).status).toBe(421);
  });

  it("421s the right host on the wrong port, and a missing Host", async () => {
    expect((await get("/api/health", { Host: "127.0.0.1:9999" })).status).toBe(421);
    expect((await get("/api/health", { Host: "127.0.0.1" })).status).toBe(421);
  });

  it("guards static files too", async () => {
    expect((await get("/", { Host: "evil.example" })).status).toBe(421);
  });
});

describe("mutation guard", () => {
  it("403s a cross-origin POST", async () => {
    const res = await post({ Host: HOST, ...JSON_CT, Origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  it("403s a POST with text/plain", async () => {
    const res = await post({ Host: HOST, "Content-Type": "text/plain", Origin: ORIGIN });
    expect(res.status).toBe(403);
  });

  it("403s a POST without content type", async () => {
    expect((await post({ Host: HOST, Origin: ORIGIN })).status).toBe(403);
  });

  it("403s a POST with neither Origin nor Sec-Fetch-Site", async () => {
    expect((await post({ Host: HOST, ...JSON_CT })).status).toBe(403);
  });

  it("403s Sec-Fetch-Site other than same-origin when Origin is absent", async () => {
    const res = await post({ Host: HOST, ...JSON_CT, "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("403s PUT, PATCH and DELETE the same way", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app().request("http://x/api/health", {
        method,
        headers: { Host: HOST, "Content-Type": "text/plain", Origin: "http://evil.example" },
      });
      expect(res.status).toBe(403);
    }
  });

  it("lets same-origin JSON through the guard (route then 404s: no such POST route)", async () => {
    expect((await post({ Host: HOST, ...JSON_CT, Origin: ORIGIN })).status).toBe(404);
    expect(
      (
        await post({
          Host: HOST,
          "Content-Type": "application/json; charset=utf-8",
          Origin: `http://localhost:${PORT}`,
        })
      ).status,
    ).toBe(404);
    expect((await post({ Host: HOST, ...JSON_CT, "Sec-Fetch-Site": "same-origin" })).status).toBe(
      404,
    );
  });

  it("checks the host before the mutation rules", async () => {
    const res = await post({ Host: "evil.example", ...JSON_CT, Origin: "http://evil.example" });
    expect(res.status).toBe(421);
  });
});

describe("headers", () => {
  it("sets the security headers on success, 404, 403 and 421 responses", async () => {
    const responses = [
      await get("/api/health"),
      await get("/api/nope"),
      await post({ Host: HOST, "Content-Type": "text/plain" }),
      await get("/api/health", { Host: "evil.example" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 404, 403, 421]);
    for (const res of responses) {
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'self'; frame-ancestors 'none'",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("never sends CORS headers, not even for a preflight or an allowed Origin", async () => {
    const preflight = await app().request("http://x/api/health", {
      method: "OPTIONS",
      headers: {
        Host: HOST,
        Origin: "http://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    const withOrigin = await get("/api/health", { Host: HOST, Origin: ORIGIN });
    for (const res of [preflight, withOrigin, await get("/")]) {
      for (const [name] of res.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    }
  });
});

describe("GET /api/health", () => {
  it("returns ok and db ok", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "ok" });
  });

  it("returns 503 and logs a code-only line when the DB is closed", async () => {
    db.$client.close();
    const res = await get("/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "error" });
    expect(logs).toEqual(["dashboard error /api/health db"]);
  });
});

describe("static files and SPA fallback", () => {
  it("serves the placeholder page when nothing is built", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("not built yet");
  });

  it("serves built files and falls back to index.html for SPA routes", async () => {
    mkdirSync(join(webDir, "assets"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>built</title>");
    writeFileSync(join(webDir, "assets", "app.js"), "export {};");
    const js = await get("/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe("export {};");
    for (const path of ["/", "/inbox", "/answers/some-key"]) {
      expect(await (await get(path)).text()).toContain("<title>built</title>");
    }
  });

  it("404s a missing asset and unknown /api paths instead of returning index.html", async () => {
    writeFileSync(join(webDir, "index.html"), "<title>built</title>");
    expect((await get("/assets/missing.js")).status).toBe(404);
    const api = await get("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.text()).not.toContain("built");
  });

  it("does not serve files outside the web dir", async () => {
    writeFileSync(join(webDir, "index.html"), "<title>built</title>");
    writeFileSync(join(webDir, "..", "dash-secret.txt"), "secret");
    try {
      for (const path of [
        "/../dash-secret.txt",
        "/%2e%2e/dash-secret.txt",
        "/..%2fdash-secret.txt",
      ]) {
        const res = await get(path);
        expect(await res.text()).not.toContain("secret");
      }
    } finally {
      rmSync(join(webDir, "..", "dash-secret.txt"), { force: true });
    }
  });
});

describe("validation helper and error log", () => {
  const schema = z.object({
    name: z.string().min(1),
    n: z.number().int(),
    nested: z.object({ k: z.string() }),
  });

  function validated() {
    const a = createApp(db, { port: PORT, webDir, logError: (l) => logs.push(l) });
    a.get("/api/_q", (c) =>
      c.json(parseQuery(c, z.object({ limit: z.coerce.number().int().max(10) }))),
    );
    a.post("/api/_b", async (c) => c.json(await parseBody(c, schema)));
    a.get("/api/_boom", () => {
      throw new Error("row content: Alex Example");
    });
    return a;
  }
  const postHeaders = { Host: HOST, ...JSON_CT, Origin: ORIGIN };

  it("returns 400 with issue paths only and never echoes values", async () => {
    const res = await validated().request("http://x/api/_b", {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify({ name: "", n: "super-secret-value", nested: {} }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: "invalid request",
      issues: [{ path: "name" }, { path: "n" }, { path: "nested.k" }],
    });
    expect(text).not.toContain("super-secret-value");
  });

  it("validates query values and returns parsed data when valid", async () => {
    const bad = await validated().request("http://x/api/_q?limit=99", { headers: { Host: HOST } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid request", issues: [{ path: "limit" }] });
    const ok = await validated().request("http://x/api/_q?limit=3", { headers: { Host: HOST } });
    expect(await ok.json()).toEqual({ limit: 3 });
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await validated().request("http://x/api/_b", {
      method: "POST",
      headers: postHeaders,
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("logs route, code, error name and top frame (file:line) for an unexpected error, without its message", async () => {
    const res = await validated().request("http://x/api/_boom?x=secret", {
      headers: { Host: HOST },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(
      /^dashboard error \/api\/_boom 500 Error at apps\/dashboard\/src\/server\/app\.test\.ts:\d+$/,
    );
    expect(logs[0]).not.toContain("Alex Example");
    expect(logs[0]).not.toContain("secret");
    expect(logs[0]).not.toContain("/Users/");
  });

  it("errorWhere falls back to the name when there is no stack frame", () => {
    const e = new TypeError("x");
    e.stack = "TypeError: x";
    expect(errorWhere(e)).toBe("TypeError");
    expect(errorWhere("boom")).toBe("NonError");
  });

  it("does not log validation failures", async () => {
    await validated().request("http://x/api/_q?limit=99", { headers: { Host: HOST } });
    expect(logs).toEqual([]);
  });
});

describe("startServer", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("binds 127.0.0.1 only", async () => {
    server = await startServer(db, { port: 0, webDir });
    expect(server.address).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
  });

  it("serves real requests, and 421s a forged Host over a real socket", async () => {
    const running = (server = await startServer(db, { port: 0, webDir }));
    const ok = await fetch(`http://127.0.0.1:${running.port}/api/health`);
    expect(await ok.json()).toEqual({ ok: true, db: "ok" });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: running.port,
          path: "/api/health",
          headers: { Host: "127.0.0.1.evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("rejects when the port is taken", async () => {
    server = await startServer(db, { port: 0, webDir });
    await expect(startServer(db, { port: server.port, webDir })).rejects.toThrow();
  });
});
