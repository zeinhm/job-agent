import { describe, expect, expectTypeOf, it } from "vitest";
import { SourceError } from "./errors.ts";
import type { RawPosting, RawSalary, SourceAdapter } from "./types.ts";

describe("core types", () => {
  it("pins RawSalary", () => {
    expectTypeOf<RawSalary>().toEqualTypeOf<{
      min?: number;
      max?: number;
      currency: string;
      period: "year" | "month" | "hour";
    }>();
  });

  it("pins RawPosting", () => {
    expectTypeOf<RawPosting>().toEqualTypeOf<{
      source: string;
      externalId: string;
      url: string;
      applyUrl?: string;
      title: string;
      company: string;
      companyDomain?: string;
      descriptionHtml?: string;
      descriptionText?: string;
      locationText?: string;
      remote?: boolean;
      salaryText?: string;
      salary?: RawSalary;
      postedAt?: string;
      tags?: string[];
    }>();
  });

  it("pins SourceAdapter", () => {
    expectTypeOf<SourceAdapter>().toEqualTypeOf<{
      name: string;
      minIntervalMinutes: number;
      fetch(since: Date): Promise<RawPosting[]>;
    }>();
  });
});

describe("SourceError", () => {
  it("carries source name, message and cause", () => {
    const cause = new Error("boom");
    const err = new SourceError("lever", "bad envelope", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SourceError");
    expect(err.source).toBe("lever");
    expect(err.message).toContain("bad envelope");
    expect(err.cause).toBe(cause);
  });
});
