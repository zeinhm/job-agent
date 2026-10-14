import { normalizeCompanyName } from "../normalize/index.ts";

export const MAX_LOCATIONS = 5;
export const MAX_LOCATION_CHARS = 120;
const MIN_ZONES_TO_COMPRESS = 3;

export interface Groupable {
  id: string;
  title: string;
  company: string;
  isAts: boolean;
  postedAt: string | null;
}

/** Lowercase, punctuation and whitespace collapsed. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best first: ATS source, then newest posted_at (null last), then id for stability. */
function byBest(a: Groupable, b: Groupable): number {
  if (a.isAts !== b.isAts) return a.isAts ? -1 : 1;
  if (a.postedAt !== b.postedAt) {
    if (a.postedAt === null) return 1;
    if (b.postedAt === null) return -1;
    return a.postedAt < b.postedAt ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Groups items by normalized company + normalized title. Each group is sorted best first,
 * so `group[0]` is the representative. Groups come out in order of their first member's id.
 */
export function groupPostings<T extends Groupable>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${normalizeCompanyName(item.company)}\u0000${normalizeTitle(item.title)}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [item]);
    else g.push(item);
  }
  return [...groups.values()].map((g) => g.sort(byBest));
}

/** Distinct locations (case-insensitive, sorted), at most `max` shown, then `+N more`. */
export function joinLocations(locations: (string | null)[], max = MAX_LOCATIONS): string {
  const seen = new Map<string, string>();
  for (const l of locations) {
    const t = (l ?? "").replace(/\s+/g, " ").trim();
    if (t !== "" && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  const all = [...seen.values()].sort((a, b) => a.localeCompare(b));
  if (all.length <= max) return all.join("; ");
  return `${all.slice(0, max).join("; ")}; +${all.length - max} more`;
}

const ZONE_NAME =
  /\b(?:Africa|America|Asia|Atlantic|Australia|Europe|Pacific)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/g;
const OFFSET = /\b(?:UTC|GMT)\s?([+\-\u2212])(\d{1,2})(?::?(\d{2}))?\b/gi;
const SEPARATOR_ONLY = /^[\s,;/|]*$/;

/** Standard-time offset of an IANA zone in minutes (January 1st, so no DST), or null when unknown. */
function zoneOffsetMinutes(name: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      timeZoneName: "longOffset",
    }).formatToParts(new Date(Date.UTC(2026, 0, 1)));
    const v = parts.find((x) => x.type === "timeZoneName")?.value ?? "";
    if (v === "GMT") return 0;
    const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(v);
    return m === null ? null : (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  } catch {
    return null;
  }
}

function utcLabel(minutes: number): string {
  const abs = Math.abs(minutes);
  const m = abs % 60;
  return `UTC${minutes < 0 ? "-" : "+"}${Math.floor(abs / 60)}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}`;
}

/**
 * Replaces 3 or more UTC offsets / IANA zone names in a location text with
 * `UTC<min> to UTC<max> (<n> zones)`, n counting distinct offsets. The separators between the
 * replaced tokens go with them. Text with fewer than 3 zones is unchanged.
 */
export function compressZones(text: string): string {
  const found: { start: number; end: number; minutes: number }[] = [];
  for (const m of text.matchAll(OFFSET)) {
    const minutes = (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
    found.push({ start: m.index, end: m.index + m[0].length, minutes });
  }
  for (const m of text.matchAll(ZONE_NAME)) {
    const minutes = zoneOffsetMinutes(m[0]);
    if (minutes !== null) found.push({ start: m.index, end: m.index + m[0].length, minutes });
  }
  if (found.length < MIN_ZONES_TO_COMPRESS) return text;
  found.sort((a, b) => a.start - b.start);
  const distinct = [...new Set(found.map((f) => f.minutes))];
  const label = `${utcLabel(Math.min(...distinct))} to ${utcLabel(Math.max(...distinct))} (${distinct.length} zones)`;
  let out = "";
  let pos = 0;
  found.forEach((f, idx) => {
    out += text.slice(pos, f.start);
    if (idx === 0) out += label;
    pos = f.end;
    const next = found[idx + 1];
    if (next !== undefined && SEPARATOR_ONLY.test(text.slice(f.end, next.start))) pos = next.start;
  });
  return out + text.slice(pos);
}

/** Caps text at `max` characters, the last one being "…" when it was cut. */
export function capText(text: string, max = MAX_LOCATION_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
