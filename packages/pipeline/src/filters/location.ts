import {
  APAC_PHRASES,
  KNOWN_PLACES,
  MULTI_PLACE_PHRASES,
  NO_REMOTE_PHRASES,
  ONSITE_PHRASES,
  REMOTE_PHRASES,
  RESTRICTED_COUNTRY_NAMES,
  RESTRICTION_PHRASES,
  WORLDWIDE_DESCRIPTION_PHRASES,
  WORLDWIDE_LOCATION_PHRASES,
} from "./keywords.ts";
import { phrasePattern } from "./phrases.ts";

export type LocationClass = "worldwide" | "apac_ok" | "restricted" | "unclear";

export type LocationInput = {
  locationText?: string | null;
  descriptionText?: string | null;
  remote?: boolean | null;
  tags?: readonly string[] | null;
};

export type LocationResult = { class: LocationClass; reason: string };

const TARGET_OFFSET = 7;

type FieldName = "location" | "tags" | "description";
type Field = { name: FieldName; text: string };
type Hit = { phrase: string; field: FieldName };

function findPhrase(fields: readonly Field[], phrases: readonly string[]): Hit | undefined {
  for (const field of fields) {
    for (const phrase of phrases) {
      if (phrasePattern(phrase).test(field.text)) return { phrase, field: field.name };
    }
  }
  return undefined;
}

const COUNTRY_LIST_RE = /\bcountries\s*:\s*(.+)$/i;
const REMOTE_PREFIX_RE = /^remote\s*(?:,|:|[-\u2013\u2014])\s*(.+)$/i;
const REMOTE_PAREN_RE = /^remote\s*\((.+)\)$/i;
const REMOTE_SUFFIX_RE = /^(.+?)\s*\(\s*remote\s*\)$/i;
const COUNTRY_SPLIT_RE = /\s*(?:,|\/|&|\band\b|\bor\b)\s*/i;
const COUNTRY_NAMES = new Set(RESTRICTED_COUNTRY_NAMES.map((c) => c.toLowerCase()));

/**
 * A country named by "Countries: <list>", "Remote, <country>", "Remote - <country>" or "<country> (Remote)".
 * Runs after the APAC check, so lists containing Indonesia or an APAC region never get here.
 */
function findCountryRestriction(locationText: string): Hit | undefined {
  for (const part of locationText.split(/[;|\n]/)) {
    const text = part.trim();
    const listed =
      COUNTRY_LIST_RE.exec(text)?.[1] ??
      REMOTE_PREFIX_RE.exec(text)?.[1] ??
      REMOTE_PAREN_RE.exec(text)?.[1] ??
      REMOTE_SUFFIX_RE.exec(text)?.[1];
    if (!listed) continue;
    const country = listed
      .split(COUNTRY_SPLIT_RE)
      .map((item) => item.trim())
      .find((item) => COUNTRY_NAMES.has(item.toLowerCase()));
    if (country) return { phrase: country, field: "location" };
  }
  return undefined;
}

type TimezoneHit = { phrase: string; field: FieldName; includesTarget: boolean };

const SIGN = "[+\\-\\u2212]";
const RANGE_RE = new RegExp(
  `(?:utc|gmt)\\s*(${SIGN})\\s*(\\d{1,2})\\s*(?:to|through|and|-|\\u2013|\\u2014)\\s*(?:(?:utc|gmt)\\s*)?(${SIGN})\\s*(\\d{1,2})(?!\\d)`,
  "gi",
);
const PLUS_MINUS_RE = /(?:utc|gmt)\s*(?:±|\+\/-)\s*(\d{1,2})(?!\d)/gi;
const SINGLE_RE = new RegExp(`(?:utc|gmt)\\s*(${SIGN})\\s*(\\d{1,2})(?!\\d)`, "gi");

function signed(sign: string, digits: string): number {
  return (sign === "+" ? 1 : -1) * Number(digits);
}

/** Timezone ranges ("UTC-5 to UTC+8", "UTC ± 3h") and a bare +7 offset ("GMT+7"). Other single offsets carry no signal. */
function timezoneHits(field: Field): TimezoneHit[] {
  const hits: TimezoneHit[] = [];
  const addRange = (phrase: string, a: number, b: number) =>
    hits.push({
      phrase,
      field: field.name,
      includesTarget: Math.min(a, b) <= TARGET_OFFSET && TARGET_OFFSET <= Math.max(a, b),
    });
  let rest = field.text.replace(
    RANGE_RE,
    (text, s1: string, d1: string, s2: string, d2: string) => {
      addRange(text, signed(s1, d1), signed(s2, d2));
      return " ";
    },
  );
  rest = rest.replace(PLUS_MINUS_RE, (text, d: string) => {
    addRange(text, -Number(d), Number(d));
    return " ";
  });
  for (const m of rest.matchAll(SINGLE_RE)) {
    if (signed(m[1] ?? "+", m[2] ?? "0") === TARGET_OFFSET) {
      hits.push({ phrase: m[0], field: field.name, includesTarget: true });
    }
  }
  return hits;
}

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const PLACE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...KNOWN_PLACES]
    .map((p) =>
      stripAccents(p)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, "\\s+"),
    )
    .sort((a, b) => b.length - a.length)
    .join("|")})(?![\\p{L}\\p{N}])(?!\\s*-?\\s*(?:wide|weit)(?![\\p{L}\\p{N}]))`,
  "u",
);

/** A place from KNOWN_PLACES (whole word, accent-insensitive; "Germany-wide" is not a place) or an on-site word. */
function findPlace(locationText: string): Hit | undefined {
  const match = PLACE_RE.exec(stripAccents(locationText));
  if (match) return { phrase: match[0], field: "location" };
  return findPhrase([{ name: "location", text: locationText }], [...ONSITE_PHRASES, "office"]);
}

function trimmed(text: string | null | undefined): string {
  return text?.trim() ?? "";
}

function cite(hit: Hit): string {
  return `"${hit.phrase}" in ${hit.field}`;
}

/**
 * Classify a posting's location for an Indonesia-based (GMT+7) candidate. First matching rule wins:
 * 1. APAC signal in location or tags -> apac_ok
 * 2. restriction in location, tags or description -> restricted
 * 3. worldwide signal -> worldwide
 * 4. APAC signal in the description only -> apac_ok
 * 5. a location that positively names a place (KNOWN_PLACES whitelist or an on-site word), no remote
 *    wording in location or tags -> restricted (onsite)
 * 5 (fallback). anything else (unknown text, placeholders, bare "Remote", empty) -> unclear
 * Step 2 also rejects a source that says `remote: false` (unless the location or tags say otherwise).
 */
export function classifyLocation(input: LocationInput): LocationResult {
  const locationText = trimmed(input.locationText);
  const locationField: Field = { name: "location", text: locationText };
  const tagsField: Field = {
    name: "tags",
    text: (input.tags ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .join("\n"),
  };
  const descriptionField: Field = { name: "description", text: trimmed(input.descriptionText) };
  const locationFields = [locationField, tagsField];
  const allFields = [locationField, tagsField, descriptionField];

  const locationTimezones = locationFields.flatMap(timezoneHits);
  const descriptionTimezones = timezoneHits(descriptionField);

  // 1. APAC in location or tags
  const apacZone = locationTimezones.find((t) => t.includesTarget);
  const apacInLocation = apacZone ?? findPhrase(locationFields, APAC_PHRASES);
  if (apacInLocation) {
    return { class: "apac_ok", reason: `step 1 APAC signal ${cite(apacInLocation)}` };
  }

  // 2. restriction in location, tags or description
  const restriction = findPhrase(allFields, RESTRICTION_PHRASES);
  if (restriction) {
    return { class: "restricted", reason: `step 2 restriction ${cite(restriction)}` };
  }
  const countryRestriction = findPhrase(locationFields, WORLDWIDE_LOCATION_PHRASES)
    ? undefined
    : findCountryRestriction(locationText);
  if (countryRestriction) {
    return {
      class: "restricted",
      reason: `step 2 country restriction ${cite(countryRestriction)}`,
    };
  }
  const excludingRange = [...locationTimezones, ...descriptionTimezones].find(
    (t) => !t.includesTarget,
  );
  if (excludingRange) {
    return {
      class: "restricted",
      reason: `step 2 timezone range excludes UTC+7 ${cite(excludingRange)}`,
    };
  }
  const noRemote = findPhrase(allFields, NO_REMOTE_PHRASES);
  if (noRemote) {
    return { class: "restricted", reason: `step 2 no remote option ${cite(noRemote)}` };
  }
  const onsite = findPhrase([locationField], ONSITE_PHRASES);
  if (onsite) {
    const remoteOffered = input.remote === true || findPhrase(locationFields, REMOTE_PHRASES);
    if (!remoteOffered) {
      return {
        class: "restricted",
        reason: `step 2 on-site/hybrid without remote option ${cite(onsite)}`,
      };
    }
  }

  const remoteWording = findPhrase(locationFields, REMOTE_PHRASES);
  if (
    input.remote === false &&
    !remoteWording &&
    !findPhrase(locationFields, WORLDWIDE_LOCATION_PHRASES)
  ) {
    return { class: "restricted", reason: "step 2 source marks the posting as not remote" };
  }

  // 3. worldwide signal
  const worldwide =
    findPhrase(locationFields, WORLDWIDE_LOCATION_PHRASES) ??
    findPhrase([descriptionField], WORLDWIDE_DESCRIPTION_PHRASES);
  if (worldwide) {
    return { class: "worldwide", reason: `step 3 worldwide signal ${cite(worldwide)}` };
  }

  // 4. APAC in the description only
  const apacInDescription =
    descriptionTimezones.find((t) => t.includesTarget) ??
    findPhrase([descriptionField], APAC_PHRASES);
  if (apacInDescription) {
    return { class: "apac_ok", reason: `step 4 APAC signal ${cite(apacInDescription)}` };
  }

  // 5. a place with no remote wording is onsite. Description wording does not count (hybrid, "remote-friendly").
  if (
    locationText &&
    input.remote !== true &&
    !remoteWording &&
    !findPhrase([locationField], MULTI_PLACE_PHRASES) &&
    findPlace(locationText)
  ) {
    return {
      class: "restricted",
      reason: `step 5 onsite: location names a place without remote wording "${locationText}"`,
    };
  }

  // 5 (fallback). nothing conclusive
  return {
    class: "unclear",
    reason: locationText
      ? `step 5 no eligibility signal in location "${locationText}"`
      : "step 5 no location information",
  };
}
