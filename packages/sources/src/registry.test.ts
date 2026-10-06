import { describe, expect, it } from "vitest";
import { makeConfig } from "./test-utils.ts";
import { buildAdapters } from "./registry.ts";

describe("buildAdapters", () => {
  it("returns no lever adapter without a lever company", () => {
    const names = (config: ReturnType<typeof makeConfig>) =>
      buildAdapters(config).map((a) => a.name);
    expect(names(makeConfig())).not.toContain("lever");
    expect(names(makeConfig([{ name: "Acme", ats: "greenhouse", slug: "acme" }]))).not.toContain(
      "lever",
    );
  });

  it("always includes exactly one himalayas adapter with a 60 minute interval", () => {
    const himalayas = buildAdapters(makeConfig()).filter((a) => a.name === "himalayas");
    expect(himalayas).toHaveLength(1);
    expect(himalayas[0]?.minIntervalMinutes).toBe(60);
  });

  it("returns exactly one lever adapter when the config has lever companies", () => {
    const adapters = buildAdapters(
      makeConfig([
        { name: "Acme", ats: "greenhouse", slug: "acme" },
        { name: "Globex", ats: "lever", slug: "globex" },
        { name: "Initech", ats: "lever", slug: "initech" },
      ]),
    );
    const levers = adapters.filter((a) => a.name === "lever");
    expect(levers).toHaveLength(1);
    expect(levers[0]?.minIntervalMinutes).toBe(60);
  });
});
