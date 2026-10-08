import { PartialSourceError, SourceError, log, __testInjectTimeAndSleep } from "@job-agent/core";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "../test-utils.ts";
import { buildAdapters } from "../registry.ts";

const read = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/smartrecruiters/${name}`, import.meta.url), "utf-8"),
  ) as Record<string, unknown>;

const list = read("list.json") as { totalFound: number; content: { id: string }[] };
const details = new Map(list.content.map((p) => [p.id, read(`detail-${p.id}.json`)]));
const UK_ID = "744000120624847";

const API = "https://api.smartrecruiters.com/v1/companies";
const server = setupServer();

function adapterFor(...slugs: string[]) {
  const adapter = buildAdapters(
    makeConfig(
      slugs.map((slug) => ({ name: `Co ${slug}`, ats: "smartrecruiters" as const, slug })),
    ),
  )[0];
  if (!adapter) throw new Error("no smartrecruiters adapter");
  return adapter;
}

/** Serves the fixture board (list + details) under `slug`. */
function serveBoard(slug: string) {
  server.use(
    http.get(`${API}/${slug}/postings`, () => HttpResponse.json(list)),
    http.get(`${API}/${slug}/postings/:id`, ({ params }) => {
      const body = details.get(String(params.id));
      return body ? HttpResponse.json(body) : new HttpResponse(null, { status: 404 });
    }),
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  let now = 0;
  __testInjectTimeAndSleep(
    () => new Date(now),
    async (ms) => {
      now += ms;
    },
  );
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

describe("smartrecruiters adapter", () => {
  it("returns one RawPosting per fixture posting", async () => {
    serveBoard("alpha");
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(postings).toHaveLength(list.content.length);
    expect(postings.every((p) => p.source === "smartrecruiters" && p.company === "Co alpha")).toBe(
      true,
    );
  });

  it("maps every available field", async () => {
    serveBoard("alpha");
    const postings = await adapterFor("alpha").fetch(new Date(0));
    const uk = postings.find((p) => p.externalId === UK_ID);
    const raw = details.get(UK_ID) as {
      jobAd: { sections: Record<string, { title: string; text: string }> };
    };
    const s = raw.jobAd.sections;
    expect(s.qualifications?.text).toBeFalsy();
    expect(uk).toEqual({
      source: "smartrecruiters",
      externalId: UK_ID,
      url: "https://jobs.smartrecruiters.com/McDonaldsCorporation/744000120624847-franchisee-uk-ireland",
      applyUrl:
        "https://jobs.smartrecruiters.com/McDonaldsCorporation/744000120624847-franchisee-uk-ireland?oga=true",
      title: "Franchisee UK & Ireland",
      company: "Co alpha",
      // A section with empty text (qualifications in this posting) is left out.
      descriptionHtml: [
        `<h2>${s.companyDescription?.title}</h2>${s.companyDescription?.text}`,
        `<h2>${s.jobDescription?.title}</h2>${s.jobDescription?.text}`,
        `<h2>${s.additionalInformation?.title}</h2>${s.additionalInformation?.text}`,
      ].join("\n"),
      locationText: "London, England, United Kingdom",
      postedAt: "2026-04-14T07:57:07.974Z",
      tags: ["General Business", "Full-time", "Mid-Senior Level", "Restaurants"],
    });
    expect(uk).not.toHaveProperty("remote");
  });

  it("sets remote true only when the location states it and tags hybrid", async () => {
    const remote = {
      ...details.get(UK_ID),
      location: { fullLocation: "Anywhere", remote: true, hybrid: true },
    };
    server.use(
      http.get(`${API}/alpha/postings`, () =>
        HttpResponse.json({ totalFound: 1, content: [{ id: UK_ID, releasedDate: null }] }),
      ),
      http.get(`${API}/alpha/postings/${UK_ID}`, () => HttpResponse.json(remote)),
    );
    const [posting] = await adapterFor("alpha").fetch(new Date(0));
    expect(posting?.remote).toBe(true);
    expect(posting?.tags).toContain("Hybrid");
  });

  it("excludes postings released before since without requesting their detail", async () => {
    serveBoard("alpha");
    const requested: string[] = [];
    server.use(
      http.get(`${API}/alpha/postings/:id`, ({ params }) => {
        requested.push(String(params.id));
        return HttpResponse.json(details.get(String(params.id)));
      }),
    );
    const postings = await adapterFor("alpha").fetch(new Date("2026-04-01T00:00:00Z"));
    expect(postings.map((p) => p.externalId)).toEqual([UK_ID]);
    expect(requested).toEqual([UK_ID]);
  });

  it("skips a posting that vanished before its detail request", async () => {
    server.use(
      http.get(`${API}/alpha/postings`, () => HttpResponse.json(list)),
      http.get(`${API}/alpha/postings/:id`, ({ params }) =>
        params.id === UK_ID
          ? new HttpResponse(null, { status: 404 })
          : HttpResponse.json(details.get(String(params.id))),
      ),
    );
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(postings).toHaveLength(list.content.length - 1);
    expect(postings.map((p) => p.externalId)).not.toContain(UK_ID);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slug: "alpha", externalId: UK_ID }),
    );
  });

  it("skips a 404 company with a warn naming the slug and returns the others", async () => {
    server.use(http.get(`${API}/gone/postings`, () => new HttpResponse(null, { status: 404 })));
    serveBoard("alpha");
    const postings = await adapterFor("gone", "alpha").fetch(new Date(0));
    expect(postings).toHaveLength(list.content.length);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slug: "gone" }),
    );
  });

  it("surfaces 404 slugs as a warning and errors when every slug is 404", async () => {
    server.use(http.get(`${API}/gone/postings`, () => new HttpResponse(null, { status: 404 })));
    serveBoard("alpha");
    const adapter = adapterFor("gone", "alpha");
    await adapter.fetch(new Date(0));
    expect(adapter.takeWarnings?.()).toEqual(["1 board not found: gone"]);
    expect(adapter.takeWarnings?.()).toEqual([]);

    server.use(http.get(`${API}/alpha/postings`, () => new HttpResponse(null, { status: 404 })));
    const err = await adapter.fetch(new Date(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).message).toContain("all 2 boards not found: gone, alpha");
  });

  it("tries every board and keeps the successes when one slug returns 500", async () => {
    server.use(http.get(`${API}/flaky/postings`, () => new HttpResponse(null, { status: 500 })));
    serveBoard("alpha");
    const err = await adapterFor("flaky", "alpha")
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSourceError);
    expect((err as PartialSourceError).postings).toHaveLength(list.content.length);
    expect((err as PartialSourceError).message).toContain("1 of 2 boards failed");
  });

  it("rejects with SourceError when a detail request keeps failing", async () => {
    server.use(
      http.get(`${API}/alpha/postings`, () => HttpResponse.json(list)),
      http.get(`${API}/alpha/postings/:id`, () => new HttpResponse(null, { status: 500 })),
    );
    const err = await adapterFor("alpha")
      .fetch(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toBe("smartrecruiters");
  });

  it("rejects with SourceError on an invalid envelope", async () => {
    server.use(http.get(`${API}/alpha/postings`, () => HttpResponse.json({ jobs: [] })));
    await expect(adapterFor("alpha").fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("skips one invalid posting with a warn", async () => {
    server.use(
      http.get(`${API}/alpha/postings`, () => HttpResponse.json(list)),
      http.get(`${API}/alpha/postings/:id`, ({ params }) =>
        HttpResponse.json(
          params.id === UK_ID
            ? { ...details.get(UK_ID), postingUrl: undefined }
            : details.get(String(params.id)),
        ),
      ),
    );
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(postings).toHaveLength(list.content.length - 1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slug: "alpha", externalId: UK_ID, path: "postingUrl" }),
    );
  });

  it("rejects with SourceError when more than 50% of postings are invalid", async () => {
    server.use(
      http.get(`${API}/alpha/postings`, () => HttpResponse.json(list)),
      http.get(`${API}/alpha/postings/:id`, () => HttpResponse.json({ id: "x", name: "t" })),
    );
    await expect(adapterFor("alpha").fetch(new Date(0))).rejects.toBeInstanceOf(SourceError);
  });

  it("returns [] and warns for an empty board (unknown slugs answer 200 + empty)", async () => {
    server.use(
      http.get(`${API}/alpha/postings`, () => HttpResponse.json({ totalFound: 0, content: [] })),
    );
    const adapter = adapterFor("alpha");
    await expect(adapter.fetch(new Date(0))).resolves.toEqual([]);
    expect(adapter.takeWarnings?.()).toEqual(["1 board returned no postings: alpha"]);
  });

  it("follows pagination with offset and limit", async () => {
    const stubs = Array.from({ length: 150 }, (_, i) => ({ id: `job-${i}`, releasedDate: null }));
    const offsets: string[] = [];
    server.use(
      http.get(`${API}/alpha/postings`, ({ request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        offsets.push(`${offset}/${limit}`);
        return HttpResponse.json({ totalFound: 150, content: stubs.slice(offset, offset + limit) });
      }),
      http.get(`${API}/alpha/postings/:id`, ({ params }) =>
        HttpResponse.json({
          id: params.id,
          name: `Job ${String(params.id)}`,
          postingUrl: `https://jobs.smartrecruiters.com/alpha/${String(params.id)}`,
        }),
      ),
    );
    const postings = await adapterFor("alpha").fetch(new Date(0));
    expect(postings).toHaveLength(150);
    expect(offsets).toEqual(["0/100", "100/100"]);
  });
});
