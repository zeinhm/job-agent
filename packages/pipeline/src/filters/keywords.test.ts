import { describe, expect, it } from "vitest";
import * as keywords from "./keywords.ts";

const lists = Object.entries(keywords) as [string, readonly string[]][];

describe("keyword lists", () => {
  it.each(lists)("%s is non-empty", (_name, list) => {
    expect(list.length).toBeGreaterThan(0);
  });

  it.each(lists)("%s has no duplicates (case-insensitive)", (_name, list) => {
    const lowered = list.map((p) => p.toLowerCase());
    expect(lowered.filter((p, i) => lowered.indexOf(p) !== i)).toEqual([]);
  });

  it.each(lists)("%s has no blank or untrimmed phrases", (_name, list) => {
    expect(list.filter((p) => p.trim() !== p || p === "")).toEqual([]);
  });

  const has = (list: readonly string[], phrase: string) =>
    list.some((p) => p.toLowerCase() === phrase.toLowerCase());

  it("APAC list contains the card's APAC signals", () => {
    for (const p of ["APAC", "Asia", "Asia-Pacific", "Southeast Asia", "SEA", "Indonesia", "WIB"]) {
      expect(has(keywords.APAC_PHRASES, p), p).toBe(true);
    }
  });

  it("restriction list contains the card's restriction phrases", () => {
    for (const p of [
      "US only",
      "Remote (US",
      "US-based",
      "must reside in",
      "must be located in",
      "authorized to work in the US",
      "authorized to work in the UK",
      "authorized to work in the EU",
      "EU only",
      "UK only",
      "Canada only",
      "North America",
      "Americas",
      "EMEA",
      "LATAM",
    ]) {
      expect(has(keywords.RESTRICTION_PHRASES, p), p).toBe(true);
    }
  });

  it("on-site and worldwide lists contain the card's phrases", () => {
    for (const p of ["on-site", "hybrid"]) expect(has(keywords.ONSITE_PHRASES, p), p).toBe(true);
    for (const p of [
      "worldwide",
      "anywhere",
      "global",
      "work from anywhere",
      "remote - anywhere",
    ]) {
      expect(has(keywords.WORLDWIDE_LOCATION_PHRASES, p), p).toBe(true);
    }
    expect(has(keywords.WORLDWIDE_DESCRIPTION_PHRASES, "worldwide")).toBe(true);
  });

  it("Indonesia list contains the card's Indonesia mentions", () => {
    for (const p of [
      "Indonesia",
      "Indonesian",
      "Jakarta",
      "Bandung",
      "Surabaya",
      "Yogyakarta",
      "Bali",
      "Denpasar",
      "Medan",
      "Semarang",
      "WIB",
    ]) {
      expect(has(keywords.INDONESIA_PHRASES, p), p).toBe(true);
    }
  });

  it("EOR list contains the card's providers and not the bare word remote", () => {
    for (const p of [
      "employer of record",
      "EOR",
      "Deel",
      "Remote.com",
      "Oyster",
      "Papaya Global",
      "Multiplier",
      "Velocity Global",
      "Globalization Partners",
      "G-P",
      "Omnipresent",
    ]) {
      expect(has(keywords.EOR_PHRASES, p), p).toBe(true);
    }
    expect(has(keywords.EOR_PHRASES, "remote")).toBe(false);
  });

  it("case-sensitive phrases are members of a matching list", () => {
    for (const p of keywords.CASE_SENSITIVE_PHRASES) {
      expect(has(keywords.APAC_PHRASES, p), p).toBe(true);
    }
  });
});
