import { describe, expect, it } from "vitest";
import { makeConfig } from "./test-utils.ts";
import { buildAdapters } from "./registry.ts";

describe("buildAdapters", () => {
  it("returns no lever adapter without a lever company", () => {
    const names = (config: Parameters<typeof buildAdapters>[0]) =>
      buildAdapters(config).map((a) => a.name);
    expect(names(makeConfig())).toEqual(["weworkremotely"]);
    expect(names(makeConfig([{ name: "Acme", ats: "greenhouse", slug: "acme" }]))).toEqual([
      "greenhouse",
      "weworkremotely",
    ]);
  });

  it("returns exactly one lever adapter when the config has lever companies", () => {
    const adapters = buildAdapters(
      makeConfig([
        { name: "Acme", ats: "greenhouse", slug: "acme" },
        { name: "Globex", ats: "lever", slug: "globex" },
        { name: "Initech", ats: "lever", slug: "initech" },
      ]),
    );
    expect(adapters.map((a) => a.name)).toEqual(["greenhouse", "lever", "weworkremotely"]);
    expect(adapters.find((a) => a.name === "lever")?.minIntervalMinutes).toBe(60);
  });
});
