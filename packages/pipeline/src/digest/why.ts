const HOURS_ZONE_NAMES: Record<string, string> = {
  europe: "Europe",
  americas: "the Americas",
  apac: "APAC",
  other: "another zone",
};

/**
 * The digest line `- Hours: overlap <n> h with Europe` from a stored extraction, as a list (empty when no hours
 * zone is set or the row cannot be read). "business hours" replaces the overlap when it is not stated.
 */
export function hoursLine(extraction: string | null): string[] {
  if (extraction == null) return [];
  try {
    const x = JSON.parse(extraction) as { hoursZone?: unknown; overlapHours?: unknown } | null;
    const zone = typeof x?.hoursZone === "string" ? HOURS_ZONE_NAMES[x.hoursZone] : undefined;
    if (zone === undefined) return [];
    const n = typeof x?.overlapHours === "number" && x.overlapHours > 0 ? x.overlapHours : null;
    return [`- Hours: ${n === null ? "business hours" : `overlap ${n} h`} with ${zone}`];
  } catch {
    return [];
  }
}
