import { describe, expect, it } from "vitest";
import { classifyLanguage } from "./language.ts";

const cls = (title: string, descriptionText: string | null = null) =>
  classifyLanguage({ title, descriptionText }).class;

describe("classifyLanguage: German / French titles", () => {
  it.each([
    "Senior Softwareentwickler (m/w/d)",
    "Backend Entwickler (m/w/d)",
    "Entwicklerin Frontend",
    "Fachinformatiker Anwendungsentwicklung",
    "Développeur Full Stack Senior (H/F)",
    "Développeuse Backend",
    "Ingénieur DevOps",
    "Ingenieur Cloud (w/m/d)",
    "Chef de projet digital",
    "Responsable technique",
    "Concepteur logiciel",
    "Teamleiter IT",
    "Mitarbeiter Support",
  ])("rejects %s", (title) => {
    expect(cls(title, "We build things.")).toBe("reject");
  });

  it("a gender marker alone is not a signal", () => {
    expect(cls("Senior Backend Engineer (m/w/d)", "We build APIs in English.")).toBe("ok");
    expect(cls("Senior Frontend Engineer (all genders)", "We build UIs.")).toBe("ok");
    expect(cls("Platform Engineer (H/F)")).toBe("ok");
    expect(cls("DevOps Engineer (w/m/d)")).toBe("ok");
  });
});

describe("classifyLanguage: language requirement", () => {
  it.each([
    ["Senior Frontend Engineer (German speaking)", ""],
    ["Full Stack Developer - French-speaking", ""],
    ["Backend Engineer", "Fluent German (C1) required"],
    ["Backend Engineer", "Sehr gute Deutschkenntnisse in Wort und Schrift"],
    ["Backend Engineer", "You speak fluent French and English"],
    ["Backend Engineer", "Native Dutch speaker"],
    ["Backend Engineer", "Fluency in Spanish is needed for daily calls"],
    ["Backend Engineer", "Fluent English and German are required"],
    ["Backend Engineer", "Business fluent Italian"],
    ["Backend Engineer", "Excellent Portuguese skills"],
    ["Backend Engineer", "Japanese (native)"],
    ["Backend Engineer", "Mandarin C1"],
    ["Backend Engineer", "Sie sprechen fließend Deutsch"],
    ["Backend Engineer", "Verhandlungssicheres Deutsch"],
    ["Backend Engineer", "Deutsch (C1)"],
    ["Backend Engineer", "Vous parlez français courant"],
    ["Backend Engineer", "Maîtrise du français exigée"],
    ["Backend Engineer", "Intro. Fluent German required, English is a plus"],
  ])("rejects %s / %s", (title, desc) => {
    expect(cls(title, desc)).toBe("reject");
  });

  it.each([
    "German is a plus",
    "French is nice to have",
    "Spanish preferred",
    "You will support our German-speaking customers",
    "We sell into the German-speaking market",
    "Fluent English required",
    "Bahasa Indonesia is a plus",
    "fluent in Indonesian",
    "Fluent in English and Indonesian",
    "Fluent German is a plus",
    "German (C1) nice to have",
    "Native Spanish speaker is an advantage",
    "Deutschkenntnisse von Vorteil",
    "Français courant, un plus",
    "Fluent in English or German",
    "Fluent English, French or German welcome",
    "Must be able to speak French or English",
    "Must speak English or German",
    "Fluent in German/English",
    "Fluent in Bahasa Indonesia or Mandarin",
  ])("keeps %s", (desc) => {
    expect(cls("Senior Backend Engineer", desc)).toBe("ok");
  });

  it("an alternative to English does not shield another clause", () => {
    expect(cls("Engineer", "Fluent in English or German. Fluent French required.")).toBe("reject");
  });

  it("the optional wording only protects its own sentence", () => {
    expect(cls("Engineer", "German is a plus. Fluent French required.")).toBe("reject");
  });
});
