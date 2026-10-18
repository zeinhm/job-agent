import { describe, expect, it } from "vitest";
import {
  approvedLocation,
  autocompleteRow,
  chooseSuggestion,
  matchingSuggestions,
} from "./autocomplete.ts";

const CITIES = [
  "Jakarta, Indonesia",
  "Springfield, Illinois, United States",
  "Springfield, Missouri, United States",
];

describe("matchingSuggestions", () => {
  it("is case-insensitive and needs every word of the answer", () => {
    expect(matchingSuggestions("JAKARTA", CITIES)).toEqual([0]);
    expect(matchingSuggestions("springfield", CITIES)).toEqual([1, 2]);
    expect(matchingSuggestions("Springfield, illinois", CITIES)).toEqual([1]);
    expect(matchingSuggestions("Jakarta Narnia", CITIES)).toEqual([]);
  });

  it("matches whole words, not fragments", () => {
    expect(matchingSuggestions("Jak", CITIES)).toEqual([]);
    expect(matchingSuggestions("states", CITIES)).toEqual([1, 2]);
  });

  it("an answer without words matches nothing", () => {
    expect(matchingSuggestions("  ,. ", CITIES)).toEqual([]);
    expect(matchingSuggestions("Jakarta", [])).toEqual([]);
  });
});

describe("chooseSuggestion", () => {
  it("picks the only match", () => {
    expect(chooseSuggestion("Jakarta", CITIES)).toEqual({ index: 0 });
  });

  it("picks the suggestion equal to the answer when several match", () => {
    const shown = ["Jakarta Selatan, Indonesia", "Jakarta, Indonesia"];
    expect(chooseSuggestion("jakarta,  INDONESIA.", shown)).toEqual({ index: 1 });
    expect(chooseSuggestion("Jakarta", ["Jakarta, Indonesia", "Jakarta"])).toEqual({ index: 1 });
  });

  it("falls back to the only suggestion whose city part equals the answer's city", () => {
    const shown = [
      "Springfield Gardens, Illinois, United States",
      "Springfield, Illinois, United States",
    ];
    expect(chooseSuggestion("Springfield, Illinois", shown)).toEqual({ index: 1 });
    expect(chooseSuggestion("Illinois", shown)).toEqual({ reason: "several" });
  });

  it("stays open when two partial matches cannot be told apart", () => {
    expect(chooseSuggestion("Springfield", CITIES)).toEqual({ reason: "several" });
    expect(chooseSuggestion("United States", CITIES)).toEqual({ reason: "several" });
  });

  it("reports none without a match", () => {
    expect(chooseSuggestion("Narnia", CITIES)).toEqual({ reason: "none" });
    expect(chooseSuggestion("Jakarta", [])).toEqual({ reason: "none" });
  });
});

describe("approvedLocation", () => {
  const answer = (over: Partial<{ key: string; answer: string; approved: boolean }>) => ({
    key: "contact.location",
    question: null,
    alternatives: null,
    answer: "Jakarta",
    type: null,
    choices: null,
    approved: true,
    ...over,
  });

  it("reads only the approved, non-empty contact.location answer", () => {
    expect(approvedLocation([answer({})])).toBe("Jakarta");
    expect(approvedLocation([answer({ approved: false })])).toBeNull();
    expect(approvedLocation([answer({ answer: "  " })])).toBeNull();
    expect(approvedLocation([answer({ key: "contact.email" })])).toBeNull();
  });
});

describe("autocompleteRow", () => {
  const field = { label: "Location", field_type: "text", required: true };

  it("a pick is a filled row from the autocomplete source", () => {
    expect(autocompleteRow(field, { picked: true, text: "Jakarta, Indonesia" })).toMatchObject({
      source: "autocomplete",
      value: "Jakarta, Indonesia",
      filled: true,
      note: null,
    });
  });

  it("no pick is an open row with a fixed note", () => {
    expect(autocompleteRow(field, { picked: false, reason: "several" })).toMatchObject({
      source: "none",
      value: null,
      filled: false,
      note: "location autocomplete: several suggestions match the answer",
    });
  });
});
