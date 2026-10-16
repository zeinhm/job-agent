import { describe, expect, it } from "vitest";
import { validateTypedAnswer } from "./typed-answer.ts";

type T = Parameters<typeof validateTypedAnswer>[0]["type"];
const check = (answer: string, type: T, choices: string[] | null = null) =>
  validateTypedAnswer({ answer, type, choices });

describe("validateTypedAnswer", () => {
  it("yes_no accepts yes/no in any case and rejects anything else", () => {
    for (const a of ["yes", "No", " YES "]) expect(check(a, "yes_no")).toEqual({ ok: true });
    for (const a of ["banana", "yes please", "y", ""])
      expect(check(a, "yes_no")).toEqual({ ok: false, field: "answer", rule: "yes_no" });
  });

  it("number accepts plain finite decimals only", () => {
    for (const a of ["3", "-2.5", "+7", ".5", " 12 ", "1e3", "2.5E-2"])
      expect(check(a, "number")).toEqual({ ok: true });
    for (const a of ["", "  ", "abc", "0x10", "Infinity", "1,000", "1e999", "5 years", "1."])
      expect(check(a, "number")).toEqual({ ok: false, field: "answer", rule: "number" });
  });

  it("choice needs non-empty choices and a normalized member", () => {
    expect(check("  remote  OK ", "choice", ["Remote ok", "Onsite"])).toEqual({ ok: true });
    expect(check("hybrid", "choice", ["Remote ok", "Onsite"])).toEqual({
      ok: false,
      field: "answer",
      rule: "choice_member",
    });
    for (const c of [null, []])
      expect(check("a", "choice", c)).toEqual({
        ok: false,
        field: "choices",
        rule: "choices_required",
      });
  });

  it("text, long_text and no type need a non-empty answer", () => {
    for (const t of ["text", "long_text", null] as const) {
      expect(check("x", t)).toEqual({ ok: true });
      expect(check("   ", t)).toEqual({ ok: false, field: "answer", rule: "non_empty" });
    }
  });
});
