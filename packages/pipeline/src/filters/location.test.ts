import { describe, expect, it } from "vitest";
import { classifyLocation, type LocationClass, type LocationInput } from "./location.ts";

function check(input: LocationInput, expected: LocationClass, reasonPart?: string) {
  const result = classifyLocation(input);
  expect(result.class).toBe(expected);
  expect(result.reason.length).toBeGreaterThan(0);
  if (reasonPart) expect(result.reason).toContain(reasonPart);
}

describe("step 1: APAC signal in location or tags", () => {
  it.each([
    "Remote, Asia",
    "APAC",
    "Asia-Pacific",
    "Southeast Asia",
    "Remote (SEA)",
    "Jakarta, Indonesia",
    "Remote GMT+7",
    "UTC+7",
    "WIB overlap",
  ])("%s -> apac_ok", (locationText) => {
    check({ locationText }, "apac_ok", "in location");
  });

  it("Remote - US or APAC -> apac_ok", () => {
    check({ locationText: "Remote - US or APAC" }, "apac_ok", '"APAC" in location');
  });

  it("APAC beats a restriction in the description", () => {
    check({ locationText: "Remote APAC", descriptionText: "Must reside in Singapore" }, "apac_ok");
  });

  it("reads tags", () => {
    check({ locationText: "Remote", tags: ["apac", "typescript"] }, "apac_ok", "in tags");
  });

  it("timezone range that includes +7 -> apac_ok", () => {
    check({ locationText: "UTC-5 to UTC+8" }, "apac_ok", "UTC-5 to UTC+8");
    check({ locationText: "Remote (GMT-8 to GMT+9)" }, "apac_ok");
  });

  it("lowercase 'sea' is not an APAC signal", () => {
    check({ locationText: "Remote", descriptionText: "ships across the sea" }, "unclear");
  });
});

describe("step 2: restriction", () => {
  it.each([
    "Remote (US)",
    "REMOTE (US only)",
    "Remote (US, Canada)",
    "US-based",
    "US only",
    "EU only",
    "UK only",
    "Canada only",
    "North America",
    "Remote - Americas/EMEA",
    "LATAM",
    "Remote within UK/Europe",
    "Remote (must work US hours)",
  ])("%s in location -> restricted", (locationText) => {
    check({ locationText }, "restricted", "in location");
  });

  it.each([
    "Applicants must reside in the United States.",
    "You must be located in Germany.",
    "Candidates must be authorized to work in the US.",
    "Authorized to work in the UK required",
    "Authorized to work in the EU required",
  ])("%s in description -> restricted", (descriptionText) => {
    check({ locationText: "Remote", descriptionText }, "restricted", "in description");
  });

  it("restriction beats a worldwide signal", () => {
    check(
      { locationText: "Worldwide", descriptionText: "You must reside in the US." },
      "restricted",
      '"must reside in" in description',
    );
  });

  it("timezone range that excludes +7 -> restricted", () => {
    check({ locationText: "Anywhere (UTC-3 to UTC+3)" }, "restricted", "UTC-3 to UTC+3");
    check({ locationText: "UTC ± 3h" }, "restricted");
    check({ locationText: "Remote", descriptionText: "Overlap with GMT-8 to GMT+2" }, "restricted");
  });

  it("on-site or hybrid without remote -> restricted", () => {
    check({ locationText: "New York, NY (On-site)" }, "restricted", "on-site");
    check({ locationText: "Hybrid - London" }, "restricted");
    check({ locationText: "ONSITE, Hanau, Germany" }, "restricted");
    check(
      { locationText: "Paris", descriptionText: "This role is not fully remote." },
      "restricted",
    );
  });

  it("on-site wording with a remote option is not restricted by the on-site rule", () => {
    check({ locationText: "Berlin (Hybrid or Remote)" }, "unclear");
    check({ locationText: "Hybrid", remote: true }, "unclear");
  });
});

describe("step 3: worldwide", () => {
  it.each([
    "Worldwide",
    "Anywhere",
    "Global",
    "Work from anywhere",
    "Remote - Anywhere",
    "REMOTE (World)",
  ])("%s -> worldwide", (locationText) => {
    check({ locationText }, "worldwide", "in location");
  });

  it("worldwide signal in the description", () => {
    check(
      { locationText: "Remote", descriptionText: "We hire worldwide." },
      "worldwide",
      "in description",
    );
  });

  it("'global' in description marketing copy is not a worldwide signal", () => {
    check({ locationText: "Remote", descriptionText: "A global leader in widgets." }, "unclear");
  });

  it("worldwide beats an APAC mention in the description", () => {
    check({ locationText: "Worldwide", descriptionText: "Many of us are in APAC." }, "worldwide");
  });
});

describe("step 4: APAC only in the description", () => {
  it("-> apac_ok", () => {
    check(
      { locationText: "Remote", descriptionText: "We have a team in Southeast Asia." },
      "apac_ok",
      "in description",
    );
  });

  it("description timezone range that includes +7 -> apac_ok", () => {
    check(
      { locationText: "Remote", descriptionText: "Overlap with UTC-5 to UTC+8 required" },
      "apac_ok",
      "step 4",
    );
  });
});

describe("step 5: unclear", () => {
  it("bare Remote -> unclear", () => {
    check({ locationText: "Remote" }, "unclear");
  });

  it("empty and missing input -> unclear with a reason", () => {
    check({ locationText: "" }, "unclear", "no location information");
    check({}, "unclear");
    check({ locationText: null, descriptionText: null, tags: null }, "unclear");
  });

  it("an unrelated location stays unclear", () => {
    check({ locationText: "Berlin, Germany" }, "unclear");
  });
});

describe("reasons", () => {
  it("name the matched phrase and where it was found", () => {
    expect(classifyLocation({ locationText: "Remote (US only)" }).reason).toContain(
      '"US only" in location',
    );
    expect(
      classifyLocation({ locationText: "Remote", descriptionText: "must reside in the US" }).reason,
    ).toContain('"must reside in" in description');
  });
});
