import { normalizeCompanyName } from "../normalize/index.ts";

export const MAX_LOCATIONS = 5;

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
