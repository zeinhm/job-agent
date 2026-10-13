import type { Extraction, RoleFamily } from "./extract.ts";

/** The families the owner applies to (PLAN 1 Target). Changing the target is an edit of this line. */
export const TARGET_ROLE_FAMILIES: readonly RoleFamily[] = ["frontend", "fullstack"];

export type ResolvableFlag = "location_unclear" | "indonesia_unclear" | "role_unclear";
const RESOLVABLE: readonly ResolvableFlag[] = [
  "location_unclear",
  "indonesia_unclear",
  "role_unclear",
];

export type ResolveInput = {
  /** The rule result from `analysis` (PLAN: nothing in Phase 2 rewrites it). */
  ruleDecision: "keep" | "reject";
  /** Flags set by the rules, e.g. `location_unclear`. */
  flags: readonly string[];
  extraction: Extraction;
};

export type ResolveResult = {
  decision: "keep" | "reject";
  /** One plain-words line per flag that was settled. */
  reasons: string[];
  /** Resolvable flags the facts could not settle; they stay in place. */
  remainingFlags: ResolvableFlag[];
};

type Outcome = { decision: "keep" | "reject"; reason: string } | null;

/** Region names that include Indonesia. */
const COVERING = new Set([
  "indonesia",
  "apac",
  "asia",
  "asia pacific",
  "asia-pacific",
  "southeast asia",
  "south east asia",
  "sea",
  "asean",
  "worldwide",
  "global",
  "anywhere",
]);
/** Region names known to exclude Indonesia. Anything else is unknown and settles nothing. */
const NOT_COVERING = new Set([
  "us",
  "usa",
  "united states",
  "canada",
  "uk",
  "united kingdom",
  "eu",
  "europe",
  "western europe",
  "emea",
  "americas",
  "amer",
  "north america",
  "south america",
  "central america",
  "latam",
  "latin america",
  "africa",
  "middle east",
]);

const norm = (s: string) => s.trim().toLowerCase();

function resolveLocation(x: Extraction): Outcome {
  const regions = x.regions.map(norm);
  if (x.indonesiaExplicit === true)
    return {
      decision: "keep",
      reason: "Location: the posting names Indonesia, so it is open to you.",
    };
  if (x.allowedCountries.includes("ID"))
    return { decision: "keep", reason: "Location: Indonesia is in the list of allowed countries." };
  if (x.hiringScope === "worldwide")
    return { decision: "keep", reason: "Location: the posting hires worldwide." };
  const covering = regions.find((r) => COVERING.has(r));
  if (covering !== undefined)
    return {
      decision: "keep",
      reason: `Location: the hiring region "${covering}" includes Indonesia.`,
    };
  if (x.hiringScope === "countries" || x.hiringScope === "region") {
    const regionsKnown = regions.every((r) => NOT_COVERING.has(r));
    const hasEvidence = x.allowedCountries.length > 0 || regions.length > 0;
    if (hasEvidence && regionsKnown) {
      const places = [...x.allowedCountries, ...x.regions].join(", ");
      return {
        decision: "reject",
        reason: `Location: hiring is limited to ${places}, which does not include Indonesia or a region covering it.`,
      };
    }
  }
  return null;
}

function resolveIndonesia(x: Extraction): Outcome {
  if (x.companyHq === null) return null;
  if (x.companyHq !== "ID")
    return {
      decision: "keep",
      reason: `Indonesia: the company is headquartered in ${x.companyHq}, so this is foreign hiring, not a domestic role.`,
    };
  const signals: string[] = [];
  const currency = x.listedSalary?.currency.toUpperCase();
  if (currency !== undefined && currency !== "IDR") signals.push(`salary listed in ${currency}`);
  if (x.employment === "eor" || x.eorProvider !== null)
    signals.push("hired through an employer of record");
  if (signals.length > 0) return null;
  return {
    decision: "reject",
    reason:
      "Indonesia: the company is headquartered in Indonesia and nothing points to foreign pay or an employer of record, so this is a domestic role.",
  };
}

/** A known family outside the target rejects every kept posting; a null family settles nothing. */
function familyReject(x: Extraction): { decision: "reject"; reason: string } | null {
  const family = x.roleFamily;
  if (family === null || TARGET_ROLE_FAMILIES.includes(family)) return null;
  return {
    decision: "reject",
    reason:
      family === "not_a_job"
        ? "Role: the text is not a job posting."
        : `Role: the posting is a ${family} role, outside the target (${TARGET_ROLE_FAMILIES.join(", ")}).`,
  };
}

function resolveRole(x: Extraction): Outcome {
  const outside = familyReject(x);
  if (outside !== null) return outside;
  if (x.roleFamily === null) return null;
  if (x.seniority === "senior" || x.seniority === "lead")
    return {
      decision: "keep",
      reason: `Role: ${x.roleFamily} role at ${x.seniority} level.`,
    };
  if (x.seniority === "mid")
    return {
      decision: "reject",
      reason: `Role: ${x.roleFamily} role at mid level, below the senior target.`,
    };
  return null;
}

const RESOLVERS: Record<ResolvableFlag, (x: Extraction) => Outcome> = {
  location_unclear: resolveLocation,
  indonesia_unclear: resolveIndonesia,
  role_unclear: resolveRole,
};

/**
 * Settles unclear flags from extracted facts. Pure; the LLM extracted the facts, this code decides.
 * Never overturns a rule reject; a known role family outside `TARGET_ROLE_FAMILIES` rejects a kept posting. A flag whose facts are unknown stays in `remainingFlags`.
 */
export function resolveFlags(input: ResolveInput): ResolveResult {
  const present = RESOLVABLE.filter((f) => input.flags.includes(f));
  if (input.ruleDecision === "reject")
    return { decision: "reject", reasons: [], remainingFlags: present };
  const reasons: string[] = [];
  const remainingFlags: ResolvableFlag[] = [];
  let decision: "keep" | "reject" = "keep";
  for (const flag of present) {
    const outcome = RESOLVERS[flag](input.extraction);
    if (outcome === null) {
      remainingFlags.push(flag);
      continue;
    }
    reasons.push(outcome.reason);
    if (outcome.decision === "reject") decision = "reject";
  }
  // A family outside the target rejects even when no flag asked for it.
  const outside = familyReject(input.extraction);
  if (outside !== null) {
    decision = "reject";
    if (!reasons.includes(outside.reason)) reasons.push(outside.reason);
  }
  return { decision, reasons, remainingFlags };
}
