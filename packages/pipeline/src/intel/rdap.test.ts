import { __testInjectTimeAndSleep, log } from "@job-agent/core";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomainAgeLookup } from "./rdap.ts";

const NOW = new Date("2026-10-09T05:00:00Z");
const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const REGISTRY = "https://rdap.registry.test/com/v1/";

let calls: string[] = [];
let bootstrapStatus = 200;
let domainResponse: () => Response = () => HttpResponse.json({});

const server = setupServer(
  http.get(BOOTSTRAP, () => {
    calls.push("bootstrap");
    if (bootstrapStatus !== 200) return new HttpResponse(null, { status: bootstrapStatus });
    return HttpResponse.json({
      version: "1.0",
      services: [
        [["com", "net"], [REGISTRY]],
        [["ai"], ["https://rdap.ai.test/"]],
      ],
    });
  }),
  http.get(`${REGISTRY}domain/:name`, ({ params }) => {
    calls.push(String(params["name"]));
    return domainResponse();
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

beforeEach(() => {
  calls = [];
  bootstrapStatus = 200;
  let t = NOW.getTime();
  __testInjectTimeAndSleep(
    () => new Date(t),
    async (ms) => {
      t += ms;
    },
  );
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  __testInjectTimeAndSleep(
    () => new Date(),
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
});

const registered = (date: string) => () =>
  HttpResponse.json({
    events: [
      { eventAction: "last changed", eventDate: "2026-10-01T00:00:00Z" },
      { eventAction: "registration", eventDate: date },
    ],
  });

describe("domain age via RDAP", () => {
  it("returns whole days since the registration event, not other events", async () => {
    domainResponse = registered("2026-09-27T05:00:00Z");
    expect(await createDomainAgeLookup(() => NOW)("new.com")).toBe(12);
  });

  it("caches per domain and fetches the bootstrap file once per run", async () => {
    domainResponse = registered("2020-01-01T00:00:00Z");
    const lookup = createDomainAgeLookup(() => NOW);
    await lookup("one.com");
    await lookup("ONE.com");
    await lookup("two.net");
    expect(calls).toEqual(["bootstrap", "one.com", "two.net"]);
  });

  it("caches a failure too, so a broken domain is asked once", async () => {
    domainResponse = () => new HttpResponse(null, { status: 403 });
    const lookup = createDomainAgeLookup(() => NOW);
    expect(await lookup("bad.com")).toBeNull();
    expect(await lookup("bad.com")).toBeNull();
    expect(calls.filter((c) => c === "bad.com")).toHaveLength(1);
  });

  it("is null when the TLD has no RDAP entry (e.g. .io)", async () => {
    expect(await createDomainAgeLookup(() => NOW)("startup.io")).toBeNull();
    expect(calls).toEqual(["bootstrap"]);
  });

  it.each([
    ["404", () => new HttpResponse(null, { status: 404 })],
    ["500", () => new HttpResponse(null, { status: 500 })],
    ["not JSON", () => new HttpResponse("nope", { status: 200 })],
    ["no registration event", () => HttpResponse.json({ events: [] })],
    [
      "bad date",
      () => HttpResponse.json({ events: [{ eventAction: "registration", eventDate: "soon" }] }),
    ],
  ])("is null (never throws) on %s", async (_name, response) => {
    domainResponse = response;
    expect(await createDomainAgeLookup(() => NOW)("x.com")).toBeNull();
  });

  it("is null when the bootstrap file cannot be read", async () => {
    bootstrapStatus = 404;
    expect(await createDomainAgeLookup(() => NOW)("x.com")).toBeNull();
    expect(calls).toEqual(["bootstrap"]);
  });
});
