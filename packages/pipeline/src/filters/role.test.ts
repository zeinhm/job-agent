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

describe("classifyRole non-engineering before target skill (phase-2 audit M1/M7)", () => {
  it("rejects the audit titles", () => {
    for (const t of [
      "Senior Global Content Manager",
      "Director, Global GTM Strategy & Operations",
      "Head of Operations",
      "Account Executive, Web3",
      "Technical Recruiter - React Engineers",
      "Customer Care Executive",
      "CRM Manager",
      "Web Designer",
    ])
      expect(cls(t), t).toBe("reject");
  });

  it("does not lose engineering titles", () => {
    for (const t of [
      "Senior React Engineer",
      "Backend Engineer (TypeScript)",
      "Head of Engineering",
      "Tech Lead",
    ])
      expect(cls(t), t).toBe("keep");
    expect(cls("DevOps Engineer")).toBe("reject");
    expect(cls("Design Engineer")).toBe("unclear");
  });

  it("a domain word beside an engineer noun is not a non-engineering reject (QA finding 1)", () => {
    const expected: Record<string, string> = {
      "Backend Engineer, Talent Platform": "reject",
      "Senior Content Platform Engineer": "reject",
      "Staff Engineer, GTM Systems": "unclear",
      "Senior Backend Engineer - Customer Care Platform": "reject",
      "Senior Software Engineer (Recruiting Tech)": "unclear",
    };
    for (const [t, c] of Object.entries(expected)) {
      const r = classifyRole({ title: t });
      expect(r.class, t).toBe(c);
      expect(r.reason, t).not.toContain("non-engineering");
    }
  });

  it("broad domain words beside an engineer noun and a target skill keep (audit rework)", () => {
    for (const t of [
      "Senior React Engineer, Compliance Platform",
      "Senior Frontend Engineer - Finance",
      "Senior Frontend Engineer, Partnerships",
      "Senior Frontend Developer (HR Tech)",
      "Senior React Developer - Designer Tools",
      "Senior Frontend Engineer, Customer Support Tools",
      "Senior Frontend Engineer - Social Media",
      "UI Designer / Frontend Developer",
    ])
      expect(cls(t), t).toBe("keep");
  });

  it("non-engineering role nouns reject unconditionally", () => {
    for (const t of [
      "Marketing Manager, Developer Products",
      "Sales Manager, Web3",
      "Compliance Officer",
      "Customer Success Manager",
      "Finance Manager",
      "Social Media Manager",
      "Solutions Engineer",
    ])
      expect(cls(t), t).toBe("reject");
  });

  it("still rejects domain-word titles without an engineer noun", () => {
    for (const t of [
      "Talent Partner",
      "Recruiting Coordinator",
      "Content Manager",
      "GTM Lead",
      "Finance Analyst",
      "HR Generalist",
      "Compliance Lead",
    ])
      expect(cls(t), t).toBe("reject");
  });

  it("names the non-engineering phrase in the reason", () => {
    expect(classifyRole({ title: "Account Executive, Web3" }).reason).toContain(
      "account executive",
    );
  });
});

describe("classifyRole mobile frameworks", () => {
  it("rejects React Native and Flutter titles even with Front-End", () => {
    expect(classifyRole({ title: "Sr. React Native Front-End Developer" }).class).toBe("reject");
    expect(classifyRole({ title: "Front-End Flutter Developer" }).class).toBe("reject");
  });
});
