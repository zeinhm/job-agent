import { describe, expect, it } from "vitest";
import { findAshbyJob } from "./ashby/index.ts";
import { parseGreenhouseJob } from "./greenhouse/index.ts";
import { parseLeverJob } from "./lever/index.ts";
import { findRecruiteeOffer } from "./recruitee/index.ts";
import { findWorkableJob } from "./workable/index.ts";

describe("single-job parsers used by fetch-descriptions", () => {
  it("greenhouse: same mapping as a board job; an invalid body throws", () => {
    const raw = parseGreenhouseJob({
      id: 7,
      title: "Engineer",
      absolute_url: "https://boards.greenhouse.io/fakeco/jobs/7",
      content: "&lt;p&gt;Text&lt;/p&gt;",
    });
    expect(raw.externalId).toBe("7");
    expect(raw.descriptionHtml).toBe("&lt;p&gt;Text&lt;/p&gt;");
    expect(() => parseGreenhouseJob({ id: "7" })).toThrow();
    expect(() => parseGreenhouseJob(null)).toThrow();
  });

  it("lever: plain text and HTML both mapped", () => {
    const raw = parseLeverJob({
      id: "abc-1",
      text: "Engineer",
      hostedUrl: "https://jobs.lever.co/fakeco/abc-1",
      description: "<p>Html</p>",
      descriptionPlain: "Plain",
    });
    expect(raw.externalId).toBe("abc-1");
    expect(raw.descriptionText).toBe("Plain");
    expect(raw.descriptionHtml).toBe("<p>Html</p>");
    expect(() => parseLeverJob([])).toThrow();
  });

  it("ashby: matches the id case-insensitively, skips an unlisted job, null when absent, throws on a wrong envelope", () => {
    const job = (id: string, isListed: boolean) => ({
      id,
      title: "Engineer",
      jobUrl: "https://jobs.ashbyhq.com/fakeco/x",
      isListed,
      descriptionPlain: "Text",
    });
    const body = { jobs: [job("AAA-1", true), job("bbb-2", false)] };
    expect(findAshbyJob(body, "aaa-1")?.descriptionText).toBe("Text");
    expect(findAshbyJob(body, "bbb-2")).toBeNull();
    expect(findAshbyJob(body, "ccc-3")).toBeNull();
    expect(() => findAshbyJob({ jobs: "no" }, "aaa-1")).toThrow();
  });

  it("workable: matches the shortcode case-insensitively", () => {
    const body = {
      jobs: [{ shortcode: "ABC123", title: "Engineer", description: "<p>Text</p>" }],
    };
    expect(findWorkableJob(body, "abc123")?.descriptionHtml).toBe("<p>Text</p>");
    expect(findWorkableJob(body, "zzz999")).toBeNull();
  });

  it("recruitee: matches the offer slug or numeric id, only a published offer, description + requirements joined", () => {
    const offer = (id: number, slug: string, status: string) => ({
      id,
      slug,
      status,
      title: "Engineer",
      careers_url: `https://fakeco.recruitee.com/o/${slug}`,
      description: "<p>A</p>",
      requirements: "<p>B</p>",
    });
    const body = { offers: [offer(1, "engineer", "published"), offer(2, "old", "archived")] };
    expect(findRecruiteeOffer(body, "Engineer")?.descriptionHtml).toBe("<p>A</p>\n<p>B</p>");
    expect(findRecruiteeOffer(body, "1")?.externalId).toBe("1");
    expect(findRecruiteeOffer(body, "old")).toBeNull();
    expect(findRecruiteeOffer(body, "missing")).toBeNull();
  });
});
