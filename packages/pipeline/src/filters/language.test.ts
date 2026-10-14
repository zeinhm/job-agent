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

describe("classifyLanguage: not-required wording and markets", () => {
  it.each([
    [
      "Lead AI Engineer (m/w/d)",
      "* Deutschkenntnisse auf beliebigem Niveau. In Teilen des Unternehmens hilfreich, fuer diese Rolle aber nie Voraussetzung.",
    ],
    [
      "Backend Engineer",
      "German is not required. Fluent German is not a requirement for this role.",
    ],
    ["Backend Engineer", "Fluent German is not a prerequisite."],
    ["Backend Engineer", "No German required."],
    ["Backend Engineer", "Fluent German helps, but is not needed."],
    ["Backend Engineer", "Speaking French is not necessary. Fluent French speaker."],
    ["Backend Engineer", "Deutschkenntnisse sind keine Voraussetzung."],
    [
      "Backend Engineer",
      "Keine Deutschkenntnisse erforderlich. Deutschkenntnisse sind nicht notwendig.",
    ],
    [
      "Backend Engineer",
      "Native French speaker: pas obligatoire. Français courant pas necessaire.",
    ],
    ["Backend Engineer", "Our product is available in French speaker markets."],
    ["Backend Engineer", "We serve Spanish-speaking countries."],
    ["Backend Engineer", "Our customers are German speaker communities."],
  ])("keeps %s / %s", (title, desc) => {
    expect(cls(title, desc)).toBe("ok");
  });

  it.each([
    ["Backend Engineer", "Fluent German is required, but a car is not required."],
    ["Backend Engineer", "Fluent German is required, a driving licence is not required."],
    ["Backend Engineer", "Fluent German is required but relocation is not needed."],
    ["Backend Engineer", "Fluent German is required and travel is not needed"],
    ["Backend Engineer", "Fluent German required\nFluent French is not required"],
    ["Backend Engineer", "Fluent German and French; French is not required"],
  ])("rejects a real requirement next to an unrelated negation: %s / %s", (title, desc) => {
    expect(cls(title, desc)).toBe("reject");
  });

  it("keeps a list of languages that are all not required", () => {
    expect(cls("Backend Engineer", "German, French and Italian are not required.")).toBe("ok");
  });

  it.each([
    ["Backend Engineer", "Fluent German required."],
    ["Backend Engineer", "Sehr gute Deutschkenntnisse (C1) erforderlich."],
    ["Backend Engineer", "Native French speaker."],
    ["Backend Engineer", "You must be a fluent German speaker."],
    ["Backend Engineer", "English is not required, but fluent German is."],
    ["Backend Engineer", "German is not required.\nFluent French required."],
    ["Backend Engineer", "French is not required. Fluent German required."],
    ["German speaking Account Manager", "We sell software."],
  ])("still rejects %s / %s", (title, desc) => {
    expect(cls(title, desc)).toBe("reject");
  });
});
