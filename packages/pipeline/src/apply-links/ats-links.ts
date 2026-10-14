import { ATS_HOSTS, type AtsType } from "./boards.ts";

/** ATS vendors we recognise in a link but do not poll (research t_5f31fe9d section 2, "link but do not poll"). */
export const LINK_ONLY_VENDORS = [
  "teamtailor",
  "personio",
  "bamboohr",
  "breezy",
  "pinpoint",
  "workday",
  "rippling",
] as const;
export type LinkOnlyVendor = (typeof LINK_ONLY_VENDORS)[number];
export type AtsVendor = AtsType | LinkOnlyVendor;

export interface AtsLink {
  vendor: AtsVendor;
  /** Board / tenant name; "" when the link does not carry one (`?gh_jid=` on a company page, workable `/j/<code>`). */
  slug: string;
  /** `job`: points at one posting; `board`: points at the list of postings. */
  kind: "job" | "board";
  /** The link as found (absolute, https). */
  url: string;
  /** The vendor's board page for this tenant; null when the slug is unknown. */
  boardUrl: string | null;
}

export const isPollable = (v: AtsVendor): v is AtsType =>
  (ATS_HOSTS as readonly string[]).includes(v);

const NOT_A_TENANT = new Set(["www", "api", "app", "careers", "support", "help", "blog", "status"]);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function link(
  vendor: AtsVendor,
  slug: string,
  kind: "job" | "board",
  url: string,
  boardUrl: string | null,
): AtsLink {
  return { vendor, slug, kind, url, boardUrl };
}

/**
 * Classifies one absolute URL by the research patterns (Greenhouse / Lever / Ashby / SmartRecruiters / Workable /
 * Recruitee hosted pages and embeds, `?gh_jid=` / `?ashby_jid=` job ids on a company page, and the link-only vendors).
 * Null when the URL is not an ATS link.
 */
export function atsLinkOf(raw: string): AtsLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter((s) => s !== "");
  const url = u.toString();

  // Greenhouse: hosted board, embed loader, job
  const gh = /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/.exec(host);
  if (gh) {
    const base = `https://${host}`;
    if (seg[0] === "embed") {
      const slug = u.searchParams.get("for") ?? "";
      return SLUG.test(slug) ? link("greenhouse", slug, "board", url, `${base}/${slug}`) : null;
    }
    const slug = seg[0] ?? "";
    if (!SLUG.test(slug)) return null;
    const isJob = seg[1] === "jobs" && seg[2] !== undefined;
    return link("greenhouse", slug, isJob ? "job" : "board", url, `${base}/${slug}`);
  }
  if (/^\d+$/.test(u.searchParams.get("gh_jid") ?? "x")) {
    return link("greenhouse", "", "job", url, null);
  }

  // Lever
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    const slug = seg[0] ?? "";
    if (!SLUG.test(slug)) return null;
    return link("lever", slug, seg[1] ? "job" : "board", url, `https://${host}/${slug}`);
  }

  // Ashby
  if (host === "jobs.ashbyhq.com") {
    const slug = seg[0] ?? "";
    if (!SLUG.test(slug) || slug === "api") return null;
    const isJob = seg[1] !== undefined && seg[1] !== "embed";
    return link("ashby", slug, isJob ? "job" : "board", url, `https://${host}/${slug}`);
  }
  if (/^[0-9a-f-]{36}$/i.test(u.searchParams.get("ashby_jid") ?? "")) {
    return link("ashby", "", "job", url, null);
  }

  // SmartRecruiters (the id is case-sensitive)
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    const slug = seg[0] ?? "";
    if (!SLUG.test(slug)) return null;
    return link(
      "smartrecruiters",
      slug,
      seg[1] ? "job" : "board",
      url,
      `https://jobs.smartrecruiters.com/${slug}`,
    );
  }

  // Workable
  if (host === "apply.workable.com") {
    if (seg[0] === "api") return null;
    if (seg[0] === "j") return seg[1] ? link("workable", "", "job", url, null) : null;
    const slug = seg[0] ?? "";
    if (!SLUG.test(slug)) return null;
    return link(
      "workable",
      slug,
      seg[1] === "j" && seg[2] ? "job" : "board",
      url,
      `https://${host}/${slug}/`,
    );
  }

  // Recruitee: {slug}.recruitee.com, jobs under /o/
  const rec = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host);
  if (rec && !NOT_A_TENANT.has(rec[1] ?? "")) {
    const slug = rec[1] ?? "";
    return link(
      "recruitee",
      slug,
      seg[0] === "o" && seg[1] ? "job" : "board",
      url,
      `https://${host}/`,
    );
  }

  // Link-only vendors
  const tt = /^([a-z0-9-]+)\.teamtailor\.com$/.exec(host);
  if (tt && !NOT_A_TENANT.has(tt[1] ?? "")) {
    const slug = tt[1] ?? "";
    return link(
      "teamtailor",
      slug,
      seg[0] === "jobs" && seg[1] ? "job" : "board",
      url,
      `https://${host}/jobs`,
    );
  }
  const pe = /^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/.exec(host);
  if (pe) {
    const slug = pe[1] ?? "";
    return link(
      "personio",
      slug,
      seg[0] === "job" && seg[1] ? "job" : "board",
      url,
      `https://${host}/`,
    );
  }
  const bb = /^([a-z0-9-]+)\.bamboohr\.com$/.exec(host);
  if (bb && !NOT_A_TENANT.has(bb[1] ?? "") && (seg[0] === "careers" || seg[0] === "jobs")) {
    const slug = bb[1] ?? "";
    return link("bamboohr", slug, seg[1] ? "job" : "board", url, `https://${host}/careers`);
  }
  const bz = /^([a-z0-9-]+)\.breezy\.hr$/.exec(host);
  if (bz && !NOT_A_TENANT.has(bz[1] ?? "")) {
    const slug = bz[1] ?? "";
    return link(
      "breezy",
      slug,
      seg[0] === "p" && seg[1] ? "job" : "board",
      url,
      `https://${host}/`,
    );
  }
  const pp = /^([a-z0-9-]+)\.pinpointhq\.com$/.exec(host);
  if (pp && !NOT_A_TENANT.has(pp[1] ?? "")) {
    const slug = pp[1] ?? "";
    return link(
      "pinpoint",
      slug,
      seg.includes("postings") && seg.length > seg.indexOf("postings") + 1 ? "job" : "board",
      url,
      `https://${host}/`,
    );
  }
  const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const slug = wd[1] ?? "";
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(seg[0] ?? "") ? seg.slice(1) : seg;
    const site = rest[0] ?? "";
    return link(
      "workday",
      slug,
      rest.includes("job") ? "job" : "board",
      url,
      site === "" ? null : `https://${host}/${site}`,
    );
  }
  if (host === "ats.rippling.com") {
    const slug = seg[0] ?? "";
    if (!SLUG.test(slug)) return null;
    return link(
      "rippling",
      slug,
      seg[1] === "jobs" && seg[2] ? "job" : "board",
      url,
      `https://${host}/${slug}/jobs`,
    );
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the entities HN and CMS output use inside links (`&#x2F;`, `&amp;`). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body: string) => {
    try {
      if (/^#x/i.test(body)) return String.fromCodePoint(parseInt(body.slice(2), 16));
      if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    } catch {
      return m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;
const URL_RE = /(?:https?:)?\/\/[^\s"'<>\\`]+/gi;

/** Absolute http(s) URLs found anywhere in a text or HTML string (hrefs, script srcs, protocol-relative, plain). */
export function urlsIn(text: string, baseUrl?: string): string[] {
  const decoded = decodeEntities(text.replace(/\\\//g, "/"));
  const found = new Set<string>();
  for (const m of decoded.matchAll(URL_RE)) {
    let candidate = m[0].replace(TRAILING_PUNCTUATION, "");
    if (candidate.startsWith("//")) candidate = `https:${candidate}`;
    // A link whose visible text HN shortened ("...") is not the full address.
    if (/(?:\.\.\.|…)$/.test(candidate)) continue;
    try {
      found.add(new URL(candidate, baseUrl).toString());
    } catch {
      // not a URL
    }
  }
  return [...found];
}

export interface Anchor {
  href: string;
  text: string;
}

/** `<a href>` elements of an HTML string, hrefs resolved against `baseUrl`, text without markup. */
export function anchorsIn(html: string, baseUrl: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const m of html.matchAll(re)) {
    const href = decodeEntities(m[1] ?? m[2] ?? "").trim();
    if (href === "") continue;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const text = decodeEntities((m[3] ?? "").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    out.push({ href: abs, text });
  }
  return out;
}

/** Distinct ATS links among the given URLs, in first-seen order. */
export function atsLinksIn(urls: readonly string[]): AtsLink[] {
  const seen = new Set<string>();
  const out: AtsLink[] = [];
  for (const u of urls) {
    const l = atsLinkOf(u);
    if (!l || seen.has(l.url)) continue;
    seen.add(l.url);
    out.push(l);
  }
  return out;
}
