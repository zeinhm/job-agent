import { describe, expect, it } from "vitest";
import { compareQuestions, fieldsFromControls, type LeverControl } from "./form.ts";

const control = (
  over: Partial<LeverControl> & Pick<LeverControl, "name" | "kind">,
): LeverControl => ({
  label: over.name,
  required: false,
  options: null,
  optionValues: [],
  ...over,
});

describe("fieldsFromControls", () => {
  it("maps each control kind to the stored question type, with the control name as the question id", () => {
    const fields = fieldsFromControls([
      control({ name: "name", kind: "text", label: "Full name", required: true }),
      control({ name: "a", kind: "textarea" }),
      control({ name: "resume", kind: "file" }),
      control({ name: "b", kind: "select", options: ["Yes", "No"] }),
      control({ name: "c", kind: "radio_group", options: ["no", "YES"] }),
      control({ name: "d", kind: "radio_group", options: ["Yes", "No", "Maybe"] }),
      control({ name: "e", kind: "select", options: ["A", "B"] }),
      control({ name: "f", kind: "checkbox_group", options: ["A"] }),
      control({ name: "g", kind: "multiselect", options: ["A", "B"] }),
      control({ name: "h", kind: "unsupported" }),
    ]);
    expect(fields.map((f) => [f.ats.id, f.field_type])).toEqual([
      ["name", "text"],
      ["a", "long_text"],
      ["resume", "file"],
      ["b", "yes_no"],
      ["c", "yes_no"],
      ["d", "choice"],
      ["e", "choice"],
      ["f", "multi_choice"],
      ["g", "multi_choice"],
      ["h", "other"],
    ]);
    expect(fields[0]).toMatchObject({
      label: "Full name",
      required: true,
      options: null,
      ats: { type: "lever", id: "name" },
    });
  });
});

describe("compareQuestions", () => {
  const base = fieldsFromControls([
    control({ name: "name", kind: "text", label: "Full name", required: true }),
    control({ name: "pick", kind: "select", label: "Zone", options: ["A", "B"] }),
  ]);

  it("is ok for the same fields, ignoring option order and label case / punctuation", () => {
    const same = fieldsFromControls([
      control({ name: "pick", kind: "select", label: "zone?", options: ["B", "A"] }),
      control({ name: "name", kind: "text", label: "Full name", required: true }),
    ]);
    expect(compareQuestions(base, same)).toMatchObject({ ok: true });
  });

  it("reports missing, extra and different by label, and nothing else", () => {
    const now = fieldsFromControls([
      control({ name: "pick", kind: "select", label: "Zone", options: ["A", "B", "C"] }),
      control({ name: "new", kind: "text", label: "Visa?" }),
    ]);
    expect(compareQuestions(base, now)).toEqual({
      ok: false,
      missing: ["Full name"],
      extra: ["Visa?"],
      different: ["Zone"],
    });
  });

  it("a changed required flag, type or label is different", () => {
    const flipped = (over: Partial<LeverControl>) =>
      compareQuestions(
        base,
        fieldsFromControls([
          control({ name: "name", kind: "text", label: "Full name", required: true, ...over }),
          control({ name: "pick", kind: "select", label: "Zone", options: ["A", "B"] }),
        ]),
      ).different;
    expect(flipped({ required: false })).toEqual(["Full name"]);
    expect(flipped({ kind: "textarea" })).toEqual(["Full name"]);
    expect(flipped({ label: "Name" })).toEqual(["Name"]);
  });
});
