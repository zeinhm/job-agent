import { describe, expect, it } from "vitest";
import { readbackEqual } from "./readback.ts";

describe("readbackEqual: text", () => {
  it("accepts trim, case and whitespace-run changes made by the page", () => {
    expect(readbackEqual("text", "Alex Example", ["  alex   example "])).toBe(true);
    expect(readbackEqual("text", "Alex", ["ALEX"])).toBe(true);
    expect(readbackEqual("textarea", "line one\nline two", ["line one line two"])).toBe(true);
  });
  it("rejects a really different value, an empty page and several values", () => {
    expect(readbackEqual("text", "Alex", ["Alexander"])).toBe(false);
    expect(readbackEqual("text", "Alex", ["Al ex"])).toBe(false);
    expect(readbackEqual("text", "Alex", [])).toBe(false);
    expect(readbackEqual("text", "Alex", ["Alex", "Alex"])).toBe(false);
  });
});

describe("readbackEqual: file", () => {
  it("accepts the bare name or a fake path on either separator", () => {
    expect(readbackEqual("file", "/tmp/data/cv-fake.pdf", ["cv-fake.pdf"])).toBe(true);
    expect(readbackEqual("file", "/tmp/data/cv-fake.pdf", ["C:\\fakepath\\cv-fake.pdf"])).toBe(
      true,
    );
    expect(readbackEqual("file", "/tmp/data/cv-fake.pdf", ["C:/fakepath/CV-Fake.pdf"])).toBe(true);
  });
  it("rejects another file name or no file", () => {
    expect(readbackEqual("file", "/tmp/data/cv-fake.pdf", ["C:\\fakepath\\other.pdf"])).toBe(false);
    expect(readbackEqual("file", "/tmp/data/cv-fake.pdf", [])).toBe(false);
  });
});

describe("readbackEqual: choices", () => {
  it("still compares by normalized label", () => {
    expect(readbackEqual("select", "Yes, I do", ["yes i do"])).toBe(true);
    expect(readbackEqual("select", "Yes", ["No"])).toBe(false);
  });
});
