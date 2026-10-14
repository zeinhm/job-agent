/** Hosts are matched by suffix: regional subdomains such as `pt.linkedin.com` count. */
export function isLinkedinHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "linkedin.com" || h.endsWith(".linkedin.com") || h === "lnkd.in";
}

/** True only for a `linkedin.com/posts/...` URL (profile, company, job and feed URLs are ignored). */
export function isLinkedinPostUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || !isLinkedinHost(u.hostname) || u.hostname === "lnkd.in") {
    return false;
  }
  return /^\/posts\/[^/]+/.test(u.pathname);
}

export interface PostFacts {
  /** Our own wording built from the facts below, never a copy of Brave text. */
  description: string;
  company?: string;
  remote: boolean;
  locationText?: string;
}

const ROLES: readonly [RegExp, string][] = [
  [/\b(?:front[\s-]?end|react(?:\.?js)?|next\.?js|vue|angular)\b/i, "Frontend Engineer"],
  [/\bfull[\s-]?stack\b/i, "Full Stack Engineer"],
  [/\b(?:software|web)\s+(?:engineer|developer)\b/i, "Software Engineer"],
];
const SENIORITY: readonly [RegExp, string][] = [
  [/\bstaff\b/i, "Staff"],
  [/\b(?:lead|principal)\b/i, "Lead"],
  [/\b(?:senior|sr\.?)\b/i, "Senior"],
];
const REGIONS: readonly [RegExp, string][] = [
  [/\bindonesia\b/i, "Indonesia"],
  [/\b(?:southeast asia|sea)\b/i, "Southeast Asia"],
  [/\bapac\b/i, "APAC"],
  [/\bworldwide\b/i, "Worldwide"],
];
const NOT_HIRING =
  /\b(?:open to work|looking for (?:a |new )?(?:job|role|opportunit)|seeking (?:a |new )?(?:job|role|opportunit))/i;
const HIRING =
  /\b(?:hiring|we(?:'|’)re looking|we are looking|join (?:us|our team)|open role|job opening)\b/i;
const COMPANY_RE =
  /\b(?:[Hh]iring at|[Jj]oin(?:ing)?|[Ww]ork (?:with|at)) ([A-Z][\w&-]*(?: [A-Z][\w&-]*){0,2})/;

/**
 * Plain-code extraction of facts from one search result's text. Returns null when the text is not a
 * hiring post for a matching role. The returned strings come from fixed vocabularies, not from the text,
 * except the optional company name.
 */
export function extractFacts(text: string): PostFacts | null {
  if (NOT_HIRING.test(text) || !HIRING.test(text)) return null;
  const role = ROLES.find(([re]) => re.test(text));
  if (!role) return null;
  const level = SENIORITY.find(([re]) => re.test(text))?.[1];
  const title = [level, role[1]].filter(Boolean).join(" ");
  const remote = /\bremote\b/i.test(text);
  const region = REGIONS.find(([re]) => re.test(text))?.[1];
  const company = COMPANY_RE.exec(text)?.[1]?.trim();
  const parts = [`Hiring: ${title}.`];
  if (remote) parts.push("Remote.");
  if (region) parts.push(`Region: ${region}.`);
  return {
    description: parts.join(" "),
    remote,
    ...(region && { locationText: region }),
    ...(company && { company }),
  };
}
