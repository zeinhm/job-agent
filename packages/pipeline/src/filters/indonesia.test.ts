import { describe, expect, it } from "vitest";
import { classifyIndonesia, type IndonesiaInput } from "./indonesia.ts";

const idLocation = { locationText: "Jakarta, Indonesia" } satisfies IndonesiaInput;

describe("classifyIndonesia", () => {
  it("rule 1: HQ in ID is domestic, even with USD salary and an EOR mention", () => {
    const r = classifyIndonesia({
      ...idLocation,
      companyHqCountry: "ID",
      salaryCurrency: "USD",
      descriptionText: "Paid via Deel",
    });
    expect(r.value).toBe("domestic");
  });

  it("rule 1: HQ code is case-insensitive", () => {
    expect(classifyIndonesia({ companyHqCountry: "id" }).value).toBe("domestic");
  });

  it("rule 2: remote worldwide with no Indonesia mention is not_applicable", () => {
    const r = classifyIndonesia({
      locationText: "Remote, worldwide",
      descriptionText: "We are a remote-first team.",
      salaryCurrency: "USD",
    });
    expect(r.value).toBe("not_applicable");
  });

  it("rule 2: not_applicable even when HQ is foreign", () => {
    expect(
      classifyIndonesia({ locationText: "Remote (US only)", companyHqCountry: "US" }).value,
    ).toBe("not_applicable");
  });

  it("rule 2: a .id domain alone defeats not_applicable", () => {
    expect(
      classifyIndonesia({ locationText: "Remote", companyDomain: "acme.co.id" }).value,
    ).not.toBe("not_applicable");
  });

  it("rule 3: known foreign HQ with an Indonesia mention is foreign_hiring_id", () => {
    const r = classifyIndonesia({ ...idLocation, companyHqCountry: "SG", salaryCurrency: "IDR" });
    expect(r.value).toBe("foreign_hiring_id");
  });

  it("rule 3 beats rule 4: foreign HQ with a .id domain", () => {
    const r = classifyIndonesia({ companyHqCountry: "SG", companyDomain: "acme.co.id" });
    expect(r.value).toBe("foreign_hiring_id");
  });

  it("rule 4: .id domain with USD salary is unclear", () => {
    expect(classifyIndonesia({ companyDomain: "acme.id", salaryCurrency: "USD" }).value).toBe(
      "unclear",
    );
  });

  it("rule 4: .co.id domain with EOR mention is unclear", () => {
    const r = classifyIndonesia({
      companyDomain: "acme.co.id",
      descriptionText: "We hire through Oyster.",
    });
    expect(r.value).toBe("unclear");
  });

  it("rule 4: .id domain with no foreign signal is domestic", () => {
    expect(classifyIndonesia({ companyDomain: "acme.co.id", salaryCurrency: "IDR" }).value).toBe(
      "domestic",
    );
    expect(classifyIndonesia({ companyDomain: "acme.id" }).value).toBe("domestic");
  });

  it("rule 5: Jakarta, USD salary, HQ unknown is foreign_hiring_id", () => {
    expect(classifyIndonesia({ ...idLocation, salaryCurrency: "USD" }).value).toBe(
      "foreign_hiring_id",
    );
  });

  it("rule 5: EOR mention in the description is foreign_hiring_id", () => {
    const r = classifyIndonesia({
      ...idLocation,
      salaryCurrency: "IDR",
      descriptionText: "We act as employer of record for our contractors.",
    });
    expect(r.value).toBe("foreign_hiring_id");
  });

  it("rule 6: Jakarta, IDR salary, HQ unknown is unclear", () => {
    expect(classifyIndonesia({ ...idLocation, salaryCurrency: "IDR" }).value).toBe("unclear");
  });

  it("rule 6: no salary at all is unclear", () => {
    expect(classifyIndonesia({ locationText: "Bali" }).value).toBe("unclear");
  });

  it("rule 1: HQ ID with USD salary is domestic", () => {
    expect(
      classifyIndonesia({ ...idLocation, companyHqCountry: "ID", salaryCurrency: "USD" }).value,
    ).toBe("domestic");
  });

  it("does not treat remote-first as an EOR signal", () => {
    const r = classifyIndonesia({
      ...idLocation,
      salaryCurrency: "IDR",
      descriptionText: "We are remote-first and fully remote. Remote work is great.",
    });
    expect(r.value).toBe("unclear");
  });

  it("treats Remote.com as an EOR signal", () => {
    const r = classifyIndonesia({
      ...idLocation,
      salaryCurrency: "IDR",
      descriptionText: "Contracts via Remote.com",
    });
    expect(r.value).toBe("foreign_hiring_id");
  });

  it("matches Indonesia mentions on word boundaries only", () => {
    expect(classifyIndonesia({ locationText: "Medanbury, UK" }).value).toBe("not_applicable");
    expect(classifyIndonesia({ descriptionText: "Join our Indonesian team" }).value).toBe(
      "unclear",
    );
  });

  it("gives every result a non-empty reason", () => {
    const inputs: IndonesiaInput[] = [
      {},
      { companyHqCountry: "ID" },
      { ...idLocation, companyHqCountry: "US" },
      { companyDomain: "a.id" },
      { companyDomain: "a.id", salaryCurrency: "USD" },
      { ...idLocation, salaryCurrency: "USD" },
      idLocation,
    ];
    for (const input of inputs) expect(classifyIndonesia(input).reason.length).toBeGreaterThan(0);
  });
});
