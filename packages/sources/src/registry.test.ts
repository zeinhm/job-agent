import { describe, expect, it } from "vitest";
import { makeConfig } from "./test-utils.ts";
import { buildAdapters } from "./registry.ts";

describe("buildAdapters", () => {
  it("returns no lever adapter without a lever company", () => {
    expect(buildAdapters(makeConfig())).toEqual([]);
    expect(buildAdapters(makeConfig([{ name: "Acme", ats: "greenhouse", slug: "acme" }]))).toEqual(
      [],
    );
  });

  it("returns exactly one lever adapter when the config has lever companies", () => {
    const adapters = buildAdapters(
      makeConfig([
        { name: "Acme", ats: "greenhouse", slug: "acme" },
        { name: "Globex", ats: "lever", slug: "globex" },
        { name: "Initech", ats: "lever", slug: "initech" },
      ]),
    );
    expect(adapters.map((a) => a.name)).toEqual(["lever"]);
    expect(adapters[0]?.minIntervalMinutes).toBe(60);
  });
});
