import { describe, expect, it } from "vitest";
import type { FormField } from "../../fill-plan.ts";
import { compareForm, describeComparison, type DomControl } from "./form.ts";

const stored = (
  id: string,
  label: string,
  field_type: string,
  options: string[] | null = null,
): FormField => ({
  label,
  field_type,
  required: false,
  options,
  ats: { type: "greenhouse", id },
});
const dom = (
  id: string,
  kind: DomControl["kind"],
  label: string,
  options: string[] | null = null,
): DomControl => ({
  id,
  kind,
  label,
  options,
  optionIds: [],
});

describe("compareForm", () => {
  const S = [
    stored("a", "Name", "text"),
    stored("b", "Pick one", "choice", ["Red", "Green"]),
    stored("c", "Tools", "multi_choice", ["Git", "Docker"]),
  ];
  const D = [
    dom("a", "text", "Name"),
    dom("b", "select", "Pick one", ["Red", "Green"]),
    dom("c", "combobox", "Tools"),
  ];

  it("a form that matches is ok (a closed combobox lists no options)", () => {
    expect(compareForm(S, D)).toMatchObject({ ok: true, missing: [], extra: [], different: [] });
  });

  it("missing, extra and different-type controls are reported by label", () => {
    const r = compareForm(S, [
      dom("a", "textarea", "Name"),
      dom("b", "select", "Pick one", ["Red", "Green"]),
      dom("z", "text", "Surprise"),
    ]);
    expect(r).toEqual({
      ok: false,
      missing: ["Tools"],
      extra: ["Surprise"],
      different: ["Name"],
    });
    expect(describeComparison(r)).toBe(
      "form changed (missing: Tools; extra: Surprise; different: Name)",
    );
  });

  it("other options on the page are a difference; option order and case are not", () => {
    expect(
      compareForm(S, [
        D[0] as DomControl,
        dom("b", "select", "Pick one", ["green", "RED"]),
        D[2] as DomControl,
      ]).ok,
    ).toBe(true);
    expect(
      compareForm(S, [
        D[0] as DomControl,
        dom("b", "select", "Pick one", ["Red", "Blue"]),
        D[2] as DomControl,
      ]),
    ).toMatchObject({
      ok: false,
      different: ["Pick one"],
    });
  });

  it("a stored question of a type the planner does not know is left to the planner", () => {
    expect(compareForm([stored("x", "Odd", "other")], [dom("x", "unsupported", "Odd")]).ok).toBe(
      true,
    );
  });

  describe("location autocomplete", () => {
    const L = [stored("location", "Location", "text"), stored("a", "Name", "text")];
    const control = dom("candidate-location", "location", "Location (City)");

    it("the location control is the stored Location question, by label not id", () => {
      expect(compareForm(L, [dom("a", "text", "Name"), control]).ok).toBe(true);
    });

    it("a form without the stored Location question stops: the control is extra", () => {
      expect(
        compareForm([stored("a", "Name", "text")], [dom("a", "text", "Name"), control]),
      ).toMatchObject({
        ok: false,
        extra: ["Location (City)"],
      });
    });

    it("a stored Location question with no location control is missing", () => {
      expect(compareForm(L, [dom("a", "text", "Name")])).toMatchObject({
        ok: false,
        missing: ["Location"],
      });
    });

    it("an unrelated new control next to the location control still stops", () => {
      expect(
        compareForm(L, [dom("a", "text", "Name"), control, dom("z", "text", "Search")]),
      ).toMatchObject({ ok: false, extra: ["Search"] });
    });
  });

  it("the stop detail stays within 200 characters", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Extra question number ${i}`);
    const text = describeComparison({ ok: false, missing: [], extra: many, different: [] });
    expect(text.length).toBeLessThanOrEqual(200);
  });
});
