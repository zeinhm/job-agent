import { describe, expect, it } from "vitest";
import { classifyRole } from "./role.ts";

const cls = (title: string, descriptionText?: string) =>
  classifyRole({ title, descriptionText: descriptionText ?? null }).class;

describe("classifyRole", () => {
  it("rejects non-engineering roles", () => {
    for (const t of ["Attorney", "Medical Director", "Sales Manager", "Marketing Lead"])
      expect(cls(t), t).toBe("reject");
  });

  it("keeps target roles", () => {
    for (const t of [
      "Senior Frontend Engineer",
      "Full-Stack Engineer (React/Node)",
      "Staff Frontend Engineer",
      "Frontend Lead",
      "Engineering Manager",
      "Head of Frontend",
    ])
      expect(cls(t), t).toBe("keep");
  });

  it("rejects engineering roles outside the target unless a target skill is in the title", () => {
    expect(cls("Backend Engineer, Go")).toBe("reject");
    expect(cls("React Native Developer")).toBe("reject");
    expect(cls("Backend Engineer (React/Node)")).toBe("keep");
    expect(cls("Engineering Manager, Data Platform")).toBe("reject");
  });

  it("rejects junior, intern and graduate roles even with a target skill", () => {
    for (const t of ["Junior Frontend Engineer", "Frontend Intern", "Graduate Engineer"])
      expect(cls(t), t).toBe("reject");
    expect(cls("Internal Tools Frontend Engineer")).toBe("keep");
  });

  it("flags generic engineering titles instead of rejecting them", () => {
    for (const t of [
      "Engineer",
      "Software Engineer",
      "Staff Engineer",
      "Member of Technical Staff",
    ])
      expect(cls(t), t).toBe("unclear");
    expect(cls("Founding Team Member")).toBe("unclear");
  });

  it("uses the description only as a hint in the reason", () => {
    const r = classifyRole({ title: "Software Engineer", descriptionText: "We use React daily." });
    expect(r.class).toBe("unclear");
    expect(r.reason).toContain('description mentions "react"');
  });

  it("always gives a reason", () => {
    expect(classifyRole({ title: "Attorney" }).reason).toContain("attorney");
  });
});

describe("classifyRole mobile frameworks", () => {
  it("rejects React Native and Flutter titles even with Front-End", () => {
    expect(classifyRole({ title: "Sr. React Native Front-End Developer" }).class).toBe("reject");
    expect(classifyRole({ title: "Front-End Flutter Developer" }).class).toBe("reject");
  });
});
