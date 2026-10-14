import { companyDomainFromUrl } from "../normalize/company-domain.ts";
import { hostMatchesDomain, hostOf } from "./boards.ts";
import { atsLinkOf, decodeEntities, urlsIn, type AtsLink } from "./ats-links.ts";

/**
 * Sites whose apply route needs a payment or subscription (research t_5f31fe9d section 4, evidence there; medium
 * strength, edit the list when the owner knows better). `weworkremotely.com` is deliberately absent: whether its free
 * tier can apply is UNKNOWN.
 */
export const PAID_ONLY_HOSTS: readonly string[] = [
  "flexjobs.com",
  "remote.co",
  "theladders.com",
  "remotejobs.io",
  "virtualvocations.com",
];

/** Sites that want a free sign-up before showing the apply route (owner decision 2026-10-14). We never sign up. */
export const SIGNUP_WALL_HOSTS: readonly string[] = ["himalayas.app"];

export const hostIsOn = (url: string, hosts: readonly string[]): boolean => {
  const h = hostOf(url);
  return h !== "" && hosts.some((x) => h === x || h.endsWith(`.${x}`));
};

export type TextRoute =
  | { type: "ats"; url: string; link: AtsLink; reason: string }
  | { type: "company_form"; url: string; reason: string };

/** Text with markup removed but every link target kept in the text (`<a href=U>t</a>` becomes ` U `). */
export function plainText(text: string): string {
  return decodeEntities(
    text
      .replace(/\\\//g, "/")
      .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>[\s\S]*?<\/a\s*>/gi, " $1$2 "),
  )
    .replace(/<\s*(?:br|\/p|p|\/li|li|\/div|div)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

/** Research t_5f31fe9d section 5: "apply at/here/via <url>". */
const APPLY_HINT =
  /\b(?:apply|applications?)\b[^\n.]{0,40}\b(?:at|here|via|through|on|to)\b[^\n]{0,20}?(https?:\/\/[^\s<>"']+)/gi;
/** "send/email ... resume/application ... <address>" and "email us at <address>". */
const EMAIL_ROUTE = [
  /\b(?:send|email|e-mail|mail)\b[^\n.]{0,60}\b(?:cv|resume|r[eé]sum[eé]|application)\b[^\n]{0,60}?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi,
  /\b(?:email|e-mail|contact)\b[^\n]{0,40}?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi,
];
const MAILTO = /mailto:([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi;
/** A company-domain link that is itself an apply or jobs page counts even without apply wording. */
const JOBS_PATH =
  /\/(?:careers?|jobs?|apply|join|hiring|openings|positions|work-with-us)(?:[/?#.-]|$)/i;

const strip = (u: string): string => u.replace(/[.,;:!?)\]}>]+$/, "");

export interface TextLinks {
  urls: string[];
  /** URLs that follow apply wording. */
  hinted: Set<string>;
  /** Addresses from `mailto:` links or "send your resume to ..." wording. */
  emails: string[];
}

export function textLinks(
  text: string | null | undefined,
  extraUrls: Array<string | null | undefined>,
): TextLinks {
  const body = plainText(text ?? "");
  const urls = new Set(urlsIn(body));
  for (const u of extraUrls) {
    if (u) for (const x of urlsIn(u)) urls.add(x);
  }
  const hinted = new Set<string>();
  for (const m of body.matchAll(APPLY_HINT)) {
    for (const x of urlsIn(strip(m[1] ?? ""))) hinted.add(x);
  }
  const emails = new Set<string>();
  for (const m of body.matchAll(MAILTO)) emails.add((m[1] ?? "").toLowerCase());
  for (const re of EMAIL_ROUTE) {
    for (const m of body.matchAll(re)) emails.add((m[1] ?? "").replace(/[.]+$/, "").toLowerCase());
  }
  return { urls: [...urls], hinted, emails: [...emails] };
}

/**
 * Step 3: the apply route a posting states itself. An ATS job URL wins, then an ATS board link, then a link on the
 * company's own domain that follows apply wording or is a jobs page, then an e-mail address on that domain. Links
 * to boards, shorteners and LinkedIn never count as the company's own (`companyDomainFromUrl` excludes them).
 */
export function routeFromText(links: TextLinks, ownDomain: string | null): TextRoute | null {
  const ats = links.urls.map((u) => atsLinkOf(u)).filter((l): l is AtsLink => l !== null);
  const job = ats.find((l) => l.kind === "job");
  if (job)
    return { type: "ats", url: job.url, link: job, reason: "ATS job link in the posting text" };
  const board = ats.find((l) => l.kind === "board");
  if (board) {
    return {
      type: "ats",
      url: board.url,
      link: board,
      reason: "ATS board link in the posting text",
    };
  }
  if (!ownDomain) return null;
  const own = links.urls.filter(
    (u) => companyDomainFromUrl(u) !== null && hostMatchesDomain(u, ownDomain),
  );
  const page =
    own.find((u) => links.hinted.has(u)) ?? own.find((u) => JOBS_PATH.test(new URL(u).pathname));
  if (page)
    return {
      type: "company_form",
      url: page,
      reason: "link on the company domain in the posting text",
    };
  const mail = links.emails.find((e) => {
    const host = e.split("@")[1] ?? "";
    return (
      companyDomainFromUrl(`https://${host}`) !== null &&
      hostMatchesDomain(`https://${host}`, ownDomain)
    );
  });
  if (mail)
    return {
      type: "company_form",
      url: `mailto:${mail}`,
      reason: "e-mail address on the company domain in the posting text",
    };
  return null;
}
