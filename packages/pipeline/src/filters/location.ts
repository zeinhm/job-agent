import {
  APAC_PHRASES,
  CASE_SENSITIVE_PHRASES,
  NO_REMOTE_PHRASES,
  ONSITE_PHRASES,
  REMOTE_PHRASES,
  RESTRICTION_PHRASES,
  WORLDWIDE_DESCRIPTION_PHRASES,
  WORLDWIDE_LOCATION_PHRASES,
} from "./keywords.ts";

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

const patternCache = new Map<string, RegExp>();

function phrasePattern(phrase: string): RegExp {
  let re = patternCache.get(phrase);
  if (!re) {
    const body = phrase
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const flags = CASE_SENSITIVE_PHRASES.includes(phrase) ? "u" : "ui";
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
    patternCache.set(phrase, re);
  }
  return re;
}

function findPhrase(fields: readonly Field[], phrases: readonly string[]): Hit | undefined {
  for (const field of fields) {
    for (const phrase of phrases) {
      if (phrasePattern(phrase).test(field.text)) return { phrase, field: field.name };
    }
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
 * 5. anything else (bare "Remote", empty) -> unclear
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

  // 5. nothing conclusive
  return {
    class: "unclear",
    reason: locationText
      ? `step 5 no eligibility signal in location "${locationText}"`
      : "step 5 no location information",
  };
}
