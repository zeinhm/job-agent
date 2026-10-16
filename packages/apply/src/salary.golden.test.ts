import { describe, expect, it } from "vitest";
import { buildAnswerIndex, matchQuestion, normalizeQuestion } from "./match.ts";
import { isSalaryWording } from "./salary.ts";

// A false positive is safe (the question stays in review), a false negative is not: when in doubt a row is positive.
const POSITIVE = [
  "How much do you expect to be paid?",
  "What is your expected base?",
  "Desired annual pay",
  "Berapa gaji yang Anda harapkan?",
  "Salary expectations",
  "What are your salary expectations for this role?",
  "Expected salary (USD)",
  "Desired salary range",
  "Current salary",
  "What is your current base salary?",
  "Base pay expectation",
  "Expected monthly pay",
  "Target annual compensation",
  "Minimum acceptable pay",
  "Current compensation",
  "Compensation expectations",
  "Remuneration expectations",
  "Expected CTC",
  "What is your expected hourly rate?",
  "Day rate expectation",
  "What is your desired rate?",
  "Your rate",
  "What wage are you looking for?",
  "Expected wages",
  "Desired income",
  "What are your earnings expectations?",
  "How much do you expect to earn?",
  "How much do you want to make per year?",
  "Expected OTE",
  "Total cash expectation",
  "Total rewards you are targeting",
  "Expected package",
  "Stipend expectation",
  "Please state your expected amount in USD",
  "Expected amount per annum",
  "Expected amount per month",
  "Target comp",
  "What is your target base?",
  "Desired base",
  "Berapa ekspektasi gaji Anda?",
  "Gaji saat ini",
  "Harapan gaji per bulan",
  "Berapa upah yang Anda inginkan?",
  "Penghasilan yang diharapkan",
  "Pendapatan bulanan Anda saat ini",
  "Kompensasi yang diharapkan",
  "Imbalan yang Anda harapkan",
  "Berapa yang ingin Anda dibayar?",
  "Berapa Anda ingin dibayarkan setiap bulan?",
  "Expected salary in IDR",
  "Ekspektasi gaji (Rp)",
  "What are you looking to be compensated?",
  "How much would you like to receive?",
  "How much do you prefer?",
  "Ekspektasi remunerasi",
  "Berapa tarif per jam Anda?",
  "Take-home?",
  "Gross monthly",
  "Please state your fee",
  "Net pay expectation",
  "Berapa nominal yang Anda inginkan?",
  "Berapa yang Anda harapkan?",
  "Berapa yang diharapkan?",
  // Re-audit #11 M2 wordings (Phase 4 report, "Still open" item 2).
  "What is your asking number?",
  "What is your minimum acceptable offer?",
  "What are your financial requirements?",
  "What is your price?",
  "Current OTC",
  // Added in t_c5f69e5a: wordings seen on ATS forms and recruiter screeners (agency, contract and Indonesian roles).
  "Expected OTE",
  "Total compensation expectations",
  "Rate expectations",
  "Hourly rate",
  "Day rate",
  "Gaji minimal",
  "What is your asking price?",
  "Expected figure",
  "Desired amount",
  "Target number",
  "Lowest offer you would consider",
  "What is the minimum you would accept?",
  "What is the lowest figure you can accept?",
  "What are your monetary expectations?",
  "Money expectations",
  "Your financial needs",
  "Please give us your expected offer",
  "Berapa angka yang Anda inginkan?",
  "Jumlah yang diharapkan",
];

const NEGATIVE = [
  "Describe your experience with payment systems",
  "Have you used PayPal or Stripe APIs?",
  "What base image do you use for Docker?",
  "Are you comfortable with on-call rotations?",
  "Payroll software you have integrated",
  "Do you need visa sponsorship?",
  "What is your notice period?",
  "Open to remote work?",
  "Link to your GitHub profile",
  "How many years of TypeScript experience do you have?",
  "Which programming languages are you proficient in?",
  "Describe a project you are proud of",
  "Are you willing to relocate?",
  "What time zone are you in?",
  "Why do you want to work here?",
  "Apakah Anda bersedia bekerja secara remote?",
  "Berapa tahun pengalaman Anda dengan Node.js?",
  "What is your favorite editor?",
  "Do you use .NET or Node.js?",
  "How much experience do you have with React?",
  "Berapa lama Anda bekerja di perusahaan sebelumnya?",
  // Share words with the new patterns (price, offer, number, amount, financial, minimum, accept) but ask nothing about pay.
  "Tell us about a pricing model you built",
  "Do you have another offer?",
  "Phone number",
  "Target number of users you supported",
  "Desired amount of remote days",
  "Target amount of revenue you owned",
  "Current OTC drugs experience",
  "Years of experience in financial services",
  "Have you received an offer from another company?",
  "Mobile number",
  "What is the price of your favorite developer tool?",
  "Describe an offer letter process you improved",
  "How many engineers did you manage in total?",
  "What is the minimum number of hours per week you can work?",
  "Do you accept our terms and conditions?",
  "Experience with price optimization",
  "Financial reporting experience",
  "Describe the amount of traffic your system handled",
  "Nomor telepon Anda",
  "Apakah Anda memiliki tawaran lain?",
];
// Known safe false positives (the question just stays in review), kept on purpose: "Do you pay for your own tools?",
// "Any fee for background checks?", "Do you have a per year training budget?", anything with a bare currency code or "earn".

describe("salary golden wordings", () => {
  it("has the required number of rows", () => {
    expect(POSITIVE.length).toBeGreaterThanOrEqual(80);
    expect(NEGATIVE.length).toBeGreaterThanOrEqual(31);
  });

  it.each(POSITIVE)("positive: %s", (label) => {
    expect(isSalaryWording(label)).toBe(true);
    expect(isSalaryWording(normalizeQuestion(label))).toBe(true);
    expect(matchQuestion(normalizeQuestion(label), new Map())).toEqual({ kind: "salary" });
  });

  it.each(NEGATIVE)("negative: %s", (label) => {
    expect(isSalaryWording(label)).toBe(false);
    expect(matchQuestion(normalizeQuestion(label), new Map())?.kind).not.toBe("salary");
  });

  it("is case-insensitive and ignores punctuation", () => {
    expect(isSalaryWording("EXPECTED   SALARY ??")).toBe(true);
  });
});

describe("a salary wording is never covered by the bank", () => {
  const bank = (question: string, alternatives: string[] | null, approved: boolean) => [
    { key: "pay.ask", question, alternatives, approved },
  ];

  it("an approved answer for 'Desired annual pay' covers nothing; the posting question is salary", () => {
    const index = buildAnswerIndex(bank("Desired annual pay", null, true));
    expect(index.size).toBe(0);
    expect(matchQuestion(normalizeQuestion("Desired annual pay"), index)).toEqual({
      kind: "salary",
    });
  });

  it("skips a salary alternative but keeps the other wordings of the answer", () => {
    const index = buildAnswerIndex(
      bank("Do you need visa sponsorship?", ["What is your expected base?", "Work permit?"], true),
    );
    expect([...index.keys()].sort()).toEqual(["do you need visa sponsorship", "work permit"]);
  });

  it("skips salary wordings of an unapproved answer too", () => {
    expect(buildAnswerIndex(bank("Desired annual pay", null, false)).size).toBe(0);
  });
});
