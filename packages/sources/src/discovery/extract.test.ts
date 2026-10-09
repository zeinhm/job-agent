import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractAtsSlug } from "./extract.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/discovery/brave-search.json", import.meta.url),
    "utf-8",
  ),
) as { web: { results: { url?: string }[] } };

describe("extractAtsSlug", () => {
  it("maps every R2 host pattern in the fixture to ats + slug and ignores the rest", () => {
    const found = fixture.web.results.flatMap((r) => {
      const c = r.url ? extractAtsSlug(r.url) : null;
      return c ? [`${c.ats}:${c.slug}`] : [];
    });
    expect(found).toEqual([
      "greenhouse:gh-alpha",
      "greenhouse:gh-beta",
      "greenhouse:gh-gamma",
      "greenhouse:gh-embed",
      "greenhouse:gh-embed2",
      "lever:lv-alpha",
      "lever:lv-eu",
      "ashby:Ab.Corp",
      "smartrecruiters:sr-alpha",
      "smartrecruiters:sr-beta",
      "workable:wk-alpha",
      "recruitee:rc-alpha",
    ]);
  });

  it("rejects non-https and look-alike hosts", () => {
    expect(extractAtsSlug("http://jobs.lever.co/x")).toBeNull();
    expect(extractAtsSlug("https://jobs.lever.co.evil.example/x")).toBeNull();
    expect(extractAtsSlug("https://boards.greenhouse.io/embed")).toBeNull();
  });
});
