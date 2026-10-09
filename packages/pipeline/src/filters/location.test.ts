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

  it("remote wording only in the description does not rescue a place-only location", () => {
    check(
      { locationText: "Berlin", descriptionText: "remote-friendly team" },
      "restricted",
      "step 5 onsite",
    );
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

describe("step 2: country-restricted remote", () => {
  it.each([
    "Remote, United States",
    "Remote - Germany",
    "Remote \u2013 France",
    "Canada (Remote)",
    "Remote (Brazil)",
    "Countries: Germany, France",
    "Countries: Switzerland; Timezones: UTC+1",
    "Remote, Poland / Ukraine",
  ])("%s -> restricted", (locationText) => {
    check({ locationText }, "restricted", "country restriction");
  });

  it.each([
    ["Remote, Indonesia", "apac_ok"],
    ["Countries: Indonesia, Vietnam", "apac_ok"],
    ["Remote, APAC", "apac_ok"],
    ["Countries: Germany, Southeast Asia", "apac_ok"],
    ["Countries: Worldwide", "worldwide"],
    ["Remote, Anywhere", "worldwide"],
    ["Remote, Berlin", "unclear"],
  ] as const)("%s -> %s", (locationText, expected) => {
    check({ locationText }, expected);
  });
});

describe("step 5 onsite: a place-only location", () => {
  it.each([
    "Berlin",
    "München",
    "Paris, France",
    "London Office",
    "Munich, Bavaria, Germany",
    "New York, NY",
  ])("%s -> restricted", (locationText) => {
    check(
      { locationText },
      "restricted",
      `step 5 onsite: location names a place without remote wording "${locationText}"`,
    );
  });

  it.each([
    ["Berlin with remote: true", { locationText: "Berlin", remote: true }],
    ["Berlin, Germany or Remote", { locationText: "Berlin, Germany or Remote" }],
    ["Berlin + tag Remote", { locationText: "Berlin", tags: ["Remote"] }],
  ] as const)("%s is not restricted by the onsite rule", (_n, input) => {
    expect(classifyLocation(input).reason).not.toContain("step 5 onsite");
    expect(classifyLocation(input).class).toBe("unclear");
  });

  it("worldwide and APAC signals still win", () => {
    check({ locationText: "San Francisco", descriptionText: "work from anywhere" }, "worldwide");
    check({ locationText: "Singapore, APAC office" }, "apac_ok");
  });

  it("empty and bare Remote stay unclear", () => {
    check({ locationText: null }, "unclear", "no location information");
    check({ locationText: "Remote" }, "unclear");
  });
});

describe("step 5 whitelist: unknown text stays unclear", () => {
  const NON_PLACES = [
    "Weltweit",
    "Fernarbeit",
    "Telearbeit",
    "Télétravail",
    "Ortsunabhängig",
    "Work-from-home",
    "Work from home",
    "Digital nomad",
    "Nationwide",
    "Deutschlandweit",
    "Germany-wide",
    "Landesweit",
    "TBD",
    "N/A",
    "n/a",
    "-",
    "--",
    "Not specified",
    "Other",
    "See description",
    "To be determined",
    "Mobile",
    "Home",
    "Anywhere in Europe",
    "Europe",
    "Asia",
    "Location flexible",
    "Multiple locations",
    "Various",
    "Several offices?",
    "Nomade digital",
    "Trabajo remoto",
    "???",
  ];
  it.each(NON_PLACES)("%j is not restricted", (locationText) => {
    expect(classifyLocation({ locationText }).class).not.toBe("restricted");
  });

  it("matches accent-insensitively and whole-word", () => {
    check({ locationText: "Koln" }, "restricted");
    check({ locationText: "Zürich" }, "restricted");
    check({ locationText: "Parisian vibes" }, "unclear");
  });

  it("a place token never overrides remote wording", () => {
    for (const locationText of [
      "Berlin or Remote",
      "Remote, Berlin",
      "Berlin / Homeoffice",
      "Munich Telearbeit",
    ]) {
      expect(classifyLocation({ locationText }).class).not.toBe("restricted");
    }
  });
});

describe("step 2: source says remote: false", () => {
  it.each(["Berlin", ""])("remote:false + %j -> restricted", (locationText) => {
    check(
      { locationText, remote: false },
      "restricted",
      "step 2 source marks the posting as not remote",
    );
  });

  it("remote:false + Remote is not rejected by that rule", () => {
    const r = classifyLocation({ locationText: "Remote", remote: false });
    expect(r.reason).not.toContain("not remote");
    expect(r.class).toBe("unclear");
  });

  it("remote:false + remote tag or worldwide location is not rejected", () => {
    expect(
      classifyLocation({ locationText: "Berlin", tags: ["Remote"], remote: false }).class,
    ).toBe("unclear");
    expect(classifyLocation({ locationText: "Worldwide", remote: false }).class).toBe("worldwide");
  });
});
