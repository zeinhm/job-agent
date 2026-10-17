import { normalizeTitle } from "./dedupe/index.ts";

const LOCATION_WORD =
  "(?:remote|hybrid|us|usa|u\\.s\\.a?\\.?|united states|uk|eu|emea|apac|latam|americas|north america|europe|asia|canada|worldwide|global|anywhere)";
const LOCATION_RUN = `${LOCATION_WORD}(?:[\\s,/&-]+${LOCATION_WORD})*`;
const PAREN_SUFFIX = new RegExp(`\\s*[(\\[]\\s*${LOCATION_RUN}\\s*[)\\]]\\s*$`, "i");
const DASH_SUFFIX = new RegExp(`(?:\\s+[-–—|]\\s+|\\s*[,|:]\\s+)${LOCATION_RUN}\\s*$`, "i");

/**
 * The title key of the free route: `normalizeTitle` after a trailing location / remote tag is cut off ("Engineer (Remote)",
 * "Engineer - US", "Engineer, EMEA"). Only whole trailing tags from the list above go; a team or level word never does, so
 * "Senior Frontend" and "Frontend", or "Engineer - Platform" and "Engineer", stay different.
 * `dedupe_hash` keeps `normalizeTitle` on purpose (stored hashes do not change).
 */
export function jobTitleKey(title: string): string {
  let t = title.trim();
  for (;;) {
    const cut = t.replace(PAREN_SUFFIX, "").replace(DASH_SUFFIX, "").trim();
    if (cut === t || cut === "") break;
    t = cut;
  }
  return normalizeTitle(t);
}

/** The ATS source and job id a link names: `?gh_jid=` / `?ashby_jid=` on a company page, or a hosted board job link. */
export function boardJobRef(raw: string): { source: string; id: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter((x) => x !== "");
  const gh = u.searchParams.get("gh_jid") ?? "";
  if (/^\d+$/.test(gh)) return { source: "greenhouse", id: gh };
  const ab = u.searchParams.get("ashby_jid") ?? "";
  if (/^[0-9a-f-]{36}$/i.test(ab)) return { source: "ashby", id: ab };
  if (/^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/.test(host)) {
    const id = seg[2] ?? "";
    return seg[1] === "jobs" && /^\d+$/.test(id) ? { source: "greenhouse", id } : null;
  }
  if ((host === "jobs.lever.co" || host === "jobs.eu.lever.co") && seg[1] !== undefined) {
    return { source: "lever", id: seg[1] };
  }
  if (host === "jobs.ashbyhq.com" && seg[1] !== undefined && seg[1] !== "embed") {
    return { source: "ashby", id: seg[1] };
  }
  return null;
}
