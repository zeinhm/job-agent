import { describe, expect, it } from "vitest";
import type { Extraction } from "./extract.ts";
import {
  formatReason,
  pickContactDomain,
  reasonPoints,
  registrableDomain,
  SCAM_THRESHOLD,
  SCAM_WEIGHTS,
  scoreScam,
  type ScamInput,
} from "./scam.ts";

const LONG = (
  "Responsibilities: build the web app. Requirements: experience with React and TypeScript. " +
  "You will work with a small team on the product stack and ship weekly. "
).repeat(3);

function input(over: Partial<ScamInput> = {}): ScamInput {
  return {
    title: "Senior Frontend Engineer",
    companyName: "Acme Inc",
    descriptionText: LONG,
    applyUrl: null,
    extraction: null,
    verification: "unknown",
    ...over,
  };
}

const signals = (i: ScamInput) => scoreScam(i).reasons.map((r) => r.signal);

describe("scoreScam", () => {
  it("a concrete, clean posting scores 0 with no reasons", () => {
    const r = scoreScam(input());
    expect(r).toEqual({ score: 0, reasons: [], suspicious: false });
  });

  it("threshold is 60 and >= threshold is suspicious", () => {
    expect(SCAM_THRESHOLD).toBe(60);
    const fee = scoreScam(input({ descriptionText: `${LONG} A registration fee is required.` }));
    expect(fee.score).toBe(60);
    expect(fee.suspicious).toBe(true);
    const chat = scoreScam(input({ descriptionText: `${LONG} Message us on Telegram.` }));
    expect(chat.score).toBe(30);
    expect(chat.suspicious).toBe(false);
  });

  it("reasons are signed lines that sum to the score; a cap is a reason line too", () => {
    const r = scoreScam(
      input({ descriptionText: "Data entry, deposit USDT to unlock, message us on WhatsApp." }),
    );
    expect(r.score).toBe(100);
    expect(r.reasons.at(-1)?.signal).toBe("score_cap");
    const lines = r.reasons.map(formatReason);
    expect(lines.reduce((s, l) => s + reasonPoints(l), 0)).toBe(100);
    expect(lines[0]).toMatch(/^[a-z_]+ [+-]\d+: .+/);
  });

  describe("false-positive guards", () => {
    it.each([
      "Join our Discord community and follow us on Telegram for protocol news.",
      "We are a Web3 protocol with token grants and an airdrop for early users.",
      "After you accept an offer we run a background check and ask for a government ID.",
      "Apply now!",
    ])("does not fire on: %s", (extra) => {
      expect(signals(input({ descriptionText: `${LONG} ${extra}` }))).toEqual([]);
    });

    it("chat contact is ignored when the apply link is the company's ATS", () => {
      const text = `${LONG} Questions? Message us on Discord.`;
      expect(signals(input({ descriptionText: text }))).toContain("chat_contact");
      expect(
        signals(input({ descriptionText: text, applyUrl: "https://jobs.lever.co/acme/1" })),
      ).not.toContain("chat_contact");
    });
  });

  describe("extracted signals", () => {
    const base: Extraction = {
      listedSalary: null,
      listedSalaryScope: null,
      hiringScope: null,
      regions: [],
      remoteRegions: [],
      allowedCountries: [],
      indonesiaExplicit: null,
      companyHq: null,
      companyType: null,
      payPolicy: null,
      employment: null,
      eorProvider: null,
      seniority: null,
      contactChannels: [],
      personalEmailDomain: null,
      asksForPaymentOrId: null,
      repoAssessmentEarly: null,
      urgencyLanguage: null,
      vagueDescription: null,
    };

    it.each([
      ["personalEmailDomain", true, "personal_email", SCAM_WEIGHTS.personal_email],
      ["asksForPaymentOrId", true, "id_early", SCAM_WEIGHTS.id_early],
      ["repoAssessmentEarly", true, "repo_assessment", SCAM_WEIGHTS.repo_assessment],
      ["urgencyLanguage", true, "urgency", SCAM_WEIGHTS.urgency],
      ["vagueDescription", true, "vague", SCAM_WEIGHTS.vague],
    ] as const)("%s adds %s", (field, value, signal, points) => {
      const r = scoreScam(input({ extraction: { ...base, [field]: value } }));
      expect(r.reasons).toHaveLength(1);
      expect(r.reasons[0]).toMatchObject({ signal, points });
      expect(r.reasons[0]?.text).toMatch(/^extraction:/);
    });

    it("chat-only contact channels add chat_contact, but not alongside an ATS or company form", () => {
      const chat = { ...base, contactChannels: ["telegram" as const] };
      expect(signals(input({ extraction: chat }))).toEqual(["chat_contact"]);
      const both = { ...base, contactChannels: ["telegram" as const, "ats" as const] };
      expect(signals(input({ extraction: both }))).toEqual([]);
    });

    it("a signal found by both the rule and the extraction counts once", () => {
      const r = scoreScam(
        input({
          descriptionText: `${LONG} A registration fee is required, mail hr@gmail.com`,
          extraction: { ...base, personalEmailDomain: true },
        }),
      );
      expect(r.reasons.filter((x) => x.signal === "personal_email")).toHaveLength(1);
    });
  });

  describe("domain age", () => {
    const age = (days: number | null) => scoreScam(input({ domainAge: { domain: "x.com", days } }));

    it.each([
      [0, 30],
      [29, 30],
      [30, 20],
      [89, 20],
      [90, 8],
      [364, 8],
      [365, 0],
      [4000, 0],
    ])("%i days -> %i points", (days, points) => {
      expect(age(days).score).toBe(points);
    });

    it("unknown age adds the reason `domain age unknown` and 0 points", () => {
      const r = age(null);
      expect(r.score).toBe(0);
      expect(r.reasons.map(formatReason)).toEqual(["domain_age_unknown +0: domain age unknown"]);
    });

    it("unknown age leaves any other score unchanged", () => {
      const text = `${LONG} Message us on Telegram.`;
      const without = scoreScam(input({ descriptionText: text }));
      const unknown = scoreScam(
        input({ descriptionText: text, domainAge: { domain: "x.com", days: null } }),
      );
      expect(unknown.score).toBe(without.score);
    });
  });

  describe("verification", () => {
    it("verified offsets only non-decisive points, never below 0", () => {
      const text = `${LONG} Message us on Telegram. Mail hr@gmail.com`;
      expect(scoreScam(input({ descriptionText: text })).score).toBe(55);
      expect(scoreScam(input({ descriptionText: text, verification: "verified" })).score).toBe(55);
      const soft = `${LONG} Urgent hiring, apply today, immediate start. Vague role.`;
      expect(scoreScam(input({ descriptionText: soft })).score).toBeGreaterThan(0);
      expect(scoreScam(input({ descriptionText: soft, verification: "verified" })).score).toBe(0);
      expect(scoreScam(input({ verification: "verified" })).score).toBe(0);
    });

    it("verified does not offset decisive signals", () => {
      const r = scoreScam(
        input({
          descriptionText: `${LONG} A registration fee is required.`,
          verification: "verified",
        }),
      );
      expect(r.score).toBe(60);
      expect(r.suspicious).toBe(true);
    });

    it("missing adds 10", () => {
      expect(scoreScam(input({ verification: "missing" })).score).toBe(10);
    });
  });

  describe("domains", () => {
    it("lookalike company domain and mismatch fire; the company's own domain does not", () => {
      const text = `${LONG} Email recruiting@acme-careers.example`;
      const bad = signals(input({ descriptionText: text, companyDomain: "acme.com" }));
      expect(bad).toEqual(expect.arrayContaining(["lookalike", "domain_mismatch"]));
      const own = signals(
        input({ descriptionText: `${LONG} Email jobs@eu.acme.com`, companyDomain: "acme.com" }),
      );
      expect(own).toEqual([]);
    });
  });

  describe("verification does not hide contact, ID or domain red flags", () => {
    const score = (text: string, extra: Partial<ScamInput> = {}) =>
      scoreScam(input({ descriptionText: `${LONG} ${text}`, verification: "verified", ...extra }));

    it("verified + Telegram + free mail keeps both contact points", () => {
      const r = score("Message us on Telegram @acmehr and send your CV to acme.hr@gmail.com");
      expect(r.score).toBe(55);
      expect(r.reasons.map((x) => x.signal)).not.toContain("ats_verified");
    });

    it("verified + ID request + chat interview keeps ID and chat points", () => {
      const r = score(
        "Send your passport and bank details with your application. Interview via Telegram chat.",
      );
      expect(r.score).toBeGreaterThanOrEqual(55);
      expect(
        signals(
          input({
            descriptionText: `${LONG} Send your passport and bank details with your application.`,
          }),
        ),
      ).toContain("id_early");
    });

    it("verified still offsets non-contact points", () => {
      const r = score("Urgent! Apply today, immediate start.");
      expect(r.score).toBe(0);
    });
  });

  describe("repo assessment wording", () => {
    it("'comfortable with npm install' is not a candidate instruction; 'run npm install' is", () => {
      expect(
        signals(input({ descriptionText: `${LONG} Comfortable with npm install and yarn.` })),
      ).toEqual([]);
      expect(
        signals(input({ descriptionText: `${LONG} Then run npm install and start the app.` })),
      ).toContain("repo_assessment");
    });
  });

  describe("no experience + high pay", () => {
    it("30 with a high figure, 10 with no figure, 0 with a low figure", () => {
      const noExp = `${LONG} No experience required.`;
      const pts = (extra: string) =>
        scoreScam(input({ descriptionText: noExp + extra })).reasons.find(
          (r) => r.signal === "no_experience_high_pay",
        )?.points ?? 0;
      expect(pts(" Earn $300 per day.")).toBe(30);
      expect(pts("")).toBe(0);
      const noPay = scoreScam(input({ descriptionText: noExp })).reasons;
      expect(noPay.find((r) => r.signal === "no_experience_no_pay")?.points).toBe(10);
      expect(pts(" Pay is $15/hour.")).toBe(0);
    });
  });
});

describe("helpers", () => {
  it("registrableDomain keeps the registrable part", () => {
    expect(registrableDomain("jobs.acme.com")).toBe("acme.com");
    expect(registrableDomain("careers.acme.co.id")).toBe("acme.co.id");
  });

  it("pickContactDomain skips ATS, shorteners, personal mail and the company's own domain", () => {
    const pick = (applyUrl: string | null, descriptionText: string | null) =>
      pickContactDomain({ applyUrl, descriptionText, companyDomain: "acme.com" });
    expect(pick("https://boards.greenhouse.io/acme/1", null)).toBeNull();
    expect(pick("https://bit.ly/x", "Write to someone@gmail.com")).toBeNull();
    expect(pick("https://www.acme.com/jobs", null)).toBeNull();
    expect(pick("https://apply.newco-jobs.com/x", null)).toBe("newco-jobs.com");
    expect(pick(null, "mail hr@newco-jobs.com")).toBe("newco-jobs.com");
  });
});
