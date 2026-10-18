import { describe, expect, it } from "vitest";
import { approvedLocation, autocompleteRow, matchingSuggestions } from "./autocomplete.ts";

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
