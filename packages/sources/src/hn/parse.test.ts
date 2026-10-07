import { describe, expect, it } from "vitest";
import { firstLineOf, parseFirstLine } from "./parse.ts";

describe("firstLineOf", () => {
  it("cuts at <p>, strips tags and decodes entities", () => {
    expect(
      firstLineOf(
        'Acme &amp; Co | <a href="https:&#x2F;&#x2F;x.io" rel="nofollow">x.io</a> | R&#x2F;D<p>Second paragraph',
      ),
    ).toBe("Acme & Co | x.io | R/D");
  });

  it("cuts at a newline", () => {
    expect(firstLineOf("Line one\nLine two")).toBe("Line one");
  });
});

describe("parseFirstLine", () => {
  it("parses the standard convention (CodeWeavers)", () => {
    expect(
      parseFirstLine(
        "CodeWeavers | St Paul, MN, USA | Full Time | REMOTE | Wine, 3D Graphics, and General Open Source Developers | C-language systems programming\n\nmore",
      ),
    ).toEqual({
      company: "CodeWeavers",
      title: "Wine, 3D Graphics, and General Open Source Developers",
      locationText: "St Paul, MN, USA | REMOTE",
    });
  });

  it("parses a short remote role", () => {
    expect(parseFirstLine("CodeWeavers | Senior C Developer | Remote (US) | Full-time")).toEqual({
      company: "CodeWeavers",
      title: "Senior C Developer",
      locationText: "Remote (US)",
    });
  });

  it("extracts salary text", () => {
    expect(
      parseFirstLine("Acme AI | Senior Backend Engineer | San Francisco, Remote | $160k-$200k"),
    ).toEqual({
      company: "Acme AI",
      title: "Senior Backend Engineer",
      locationText: "San Francisco, Remote",
      salaryText: "$160k-$200k",
    });
  });

  it("keeps REMOTE (US only) verbatim in locationText", () => {
    expect(parseFirstLine("Acme | Staff Engineer | REMOTE (US only) | Full-time")).toEqual({
      company: "Acme",
      title: "Staff Engineer",
      locationText: "REMOTE (US only)",
    });
  });

  it("treats onsite as a location segment", () => {
    expect(parseFirstLine("TechCorp | DevOps Engineer | Portland OR | Full-time onsite")).toEqual({
      company: "TechCorp",
      title: "DevOps Engineer",
      locationText: "Portland OR | Full-time onsite",
    });
  });

  it("joins several location segments", () => {
    expect(
      parseFirstLine("StartupXYZ | Full Stack Engineer | Remote (EU timezone) | Berlin, Germany"),
    ).toEqual({
      company: "StartupXYZ",
      title: "Full Stack Engineer",
      locationText: "Remote (EU timezone) | Berlin, Germany",
    });
  });

  it("falls back to segment 2 when no segment looks like a role", () => {
    expect(parseFirstLine("Foo Inc | Growth Hacker | REMOTE")).toEqual({
      company: "Foo Inc",
      title: "Growth Hacker",
      locationText: "REMOTE",
    });
  });

  it("recognises currency codes and symbols as salary", () => {
    expect(
      parseFirstLine("DataFlow | ML Engineer | New York | REMOTE | 100k-160k GBP + equity"),
    ).toMatchObject({ salaryText: "100k-160k GBP + equity", title: "ML Engineer" });
    expect(parseFirstLine("PAGNOS | Cloud Engineer | REMOTE (Germany) | €75k–80k")).toMatchObject({
      salaryText: "€75k–80k",
    });
  });

  it("ignores empty segments", () => {
    expect(parseFirstLine("Planlab.ai | | Product Engineer | ONSITE in London, UK")).toEqual({
      company: "Planlab.ai",
      title: "Product Engineer",
      locationText: "ONSITE in London, UK",
    });
  });

  it("returns unknown company and the whole line as title when there are no pipes", () => {
    expect(parseFirstLine("Looking for backend devs to join our small team<p>details")).toEqual({
      company: "unknown",
      title: "Looking for backend devs to join our small team",
    });
  });

  it("truncates the no-pipe title to 120 characters", () => {
    const parsed = parseFirstLine("x".repeat(300));
    expect(parsed.company).toBe("unknown");
    expect(parsed.title).toHaveLength(120);
    expect(parsed).not.toHaveProperty("locationText");
  });

  it("ignores URL-only segments", () => {
    expect(
      parseFirstLine("OpenRent | Backend Engineer | https://www.openrent.co.uk | REMOTE"),
    ).toEqual({ company: "OpenRent", title: "Backend Engineer", locationText: "REMOTE" });
  });

  it("does not treat a plain 'k' word as salary", () => {
    expect(
      parseFirstLine("Kite | Backend Engineer | Remote | Work with kubernetes"),
    ).not.toHaveProperty("salaryText");
  });
});
