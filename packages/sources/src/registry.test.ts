import { describe, expect, it } from "vitest";
import { makeConfig } from "./test-utils.ts";
import { buildAdapters } from "./registry.ts";

describe("buildAdapters", () => {
  const names = (config: ReturnType<typeof makeConfig>) => buildAdapters(config).map((a) => a.name);

  it("returns no lever adapter without a lever company", () => {
    expect(names(makeConfig())).not.toContain("lever");
    expect(names(makeConfig([{ name: "Acme", ats: "greenhouse", slug: "acme" }]))).not.toContain(
      "lever",
    );
  });

  it("always includes exactly one remoteok adapter", () => {
    expect(names(makeConfig()).filter((n) => n === "remoteok")).toHaveLength(1);
  });

  it("returns an ashby adapter only when the config has an ashby company", () => {
    expect(names(makeConfig())).not.toContain("ashby");
    expect(names(makeConfig([{ name: "G", ats: "greenhouse", slug: "g" }]))).not.toContain("ashby");
    const list = names(makeConfig([{ name: "A", ats: "ashby", slug: "a" }]));
    expect(list.filter((n) => n === "ashby")).toHaveLength(1);
  });

  it("returns a recruitee adapter only when the config has a recruitee company", () => {
    expect(names(makeConfig())).not.toContain("recruitee");
    const adapters = buildAdapters(makeConfig([{ name: "R", ats: "recruitee", slug: "r" }]));
    const recruitee = adapters.filter((a) => a.name === "recruitee");
    expect(recruitee).toHaveLength(1);
    expect(recruitee[0]?.minIntervalMinutes).toBe(360);
  });

  it("always includes exactly one himalayas adapter with a 60 minute interval", () => {
    const himalayas = buildAdapters(makeConfig()).filter((a) => a.name === "himalayas");
    expect(himalayas).toHaveLength(1);
    expect(himalayas[0]?.minIntervalMinutes).toBe(60);
  });

  it("returns exactly one lever adapter when the config has lever companies", () => {
    const adapters = buildAdapters(
      makeConfig([
        { name: "Globex", ats: "lever", slug: "globex" },
        { name: "Initech", ats: "lever", slug: "initech" },
      ]),
    );
    const levers = adapters.filter((a) => a.name === "lever");
    expect(levers).toHaveLength(1);
    expect(levers[0]?.minIntervalMinutes).toBe(60);
  });

  it("always includes exactly one hn adapter with a monthly-thread interval", () => {
    const hn = buildAdapters(makeConfig()).filter((a) => a.name === "hn");
    expect(hn).toHaveLength(1);
    expect(hn[0]?.minIntervalMinutes).toBe(360);
  });

  it("returns one adapter per configured ATS", () => {
    const adapters = buildAdapters(
      makeConfig([
        { name: "Acme", ats: "greenhouse", slug: "acme" },
        { name: "Globex", ats: "lever", slug: "globex" },
        { name: "Initech", ats: "lever", slug: "initech" },
      ]),
    );
    expect(adapters.map((a) => a.name).filter((n) => n === "greenhouse" || n === "lever")).toEqual([
      "greenhouse",
      "lever",
    ]);
  });

  it("always returns exactly one web3career adapter", () => {
    const adapters = buildAdapters(makeConfig()).filter((a) => a.name === "web3career");
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.minIntervalMinutes).toBe(5);
  });
});

describe("buildAdapters workable", () => {
  it("returns exactly one workable adapter only when the config has workable companies", () => {
    const names = (c: ReturnType<typeof makeConfig>) => buildAdapters(c).map((a) => a.name);
    expect(names(makeConfig())).not.toContain("workable");
    const list = names(
      makeConfig([
        { name: "A", ats: "workable", slug: "a" },
        { name: "B", ats: "workable", slug: "b" },
      ]),
    );
    expect(list.filter((n) => n === "workable")).toHaveLength(1);
  });
});

describe("buildAdapters smartrecruiters", () => {
  it("returns one smartrecruiters adapter (360 minute interval) only with smartrecruiters companies", () => {
    expect(
      buildAdapters(makeConfig([{ name: "A", ats: "lever", slug: "a" }])).map((a) => a.name),
    ).not.toContain("smartrecruiters");
    const adapters = buildAdapters(
      makeConfig([
        { name: "A", ats: "smartrecruiters", slug: "a" },
        { name: "B", ats: "smartrecruiters", slug: "b" },
      ]),
    ).filter((a) => a.name === "smartrecruiters");
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.minIntervalMinutes).toBe(360);
  });
});
