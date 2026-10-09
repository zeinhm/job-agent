import { ATS_APPLY_HOSTS, SCAM_SHORTENER_HOSTS } from "../filters/keywords.ts";

/** Job boards and aggregators: their own host is never a company's domain. */
export const JOB_BOARD_HOSTS: readonly string[] = [
  "remoteok.com",
  "remotive.com",
  "himalayas.app",
  "weworkremotely.com",
  "arbeitnow.com",
  "web3.career",
  "news.ycombinator.com",
  "ycombinator.com",
  "workatastartup.com",
  "wellfound.com",
  "indeed.com",
  "glassdoor.com",
  "jobstreet.com",
  "linkedin.com",
  // code, social and doc hosts a first-line link may point at
  "github.com",
  "gitlab.com",
  "twitter.com",
  "x.com",
  "medium.com",
  "youtube.com",
  "notion.so",
  "discord.com",
  "calendly.com",
  "google.com",
  "lnkd.in",
];

/** Hosted ATS vendors beyond `ATS_APPLY_HOSTS` (whole vendor domains, so any tenant subdomain is excluded). */
const ATS_VENDOR_DOMAINS: readonly string[] = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "smartrecruiters.com",
  "workable.com",
  "recruitee.com",
  "breezy.hr",
  "teamtailor.com",
  "personio.de",
  "personio.com",
  "bamboohr.com",
  "myworkdayjobs.com",
  "icims.com",
  "jobvite.com",
  "rippling.com",
  "pinpointhq.com",
  "welcometothejungle.com",
];

/** Board brand names: excluded on every TLD (smoke: Arbeitnow links to arbeitnow.ch / .fr / .co.uk). */
const JOB_BOARD_BRANDS: readonly string[] = [
  "arbeitnow",
  "remoteok",
  "remotive",
  "himalayas",
  "weworkremotely",
];

function matches(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Company-owned host of a posting link, or null when the link points at an ATS, a job board, a shortener / form host or
 * is not a plain https(s) hostname. Returns the host without `www.`.
 */
export function companyDomainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
  const labels = host.split(".");
  if (
    labels.some((l) => JOB_BOARD_BRANDS.includes(l)) ||
    matches(host, JOB_BOARD_HOSTS) ||
    matches(host, ATS_APPLY_HOSTS) ||
    matches(host, ATS_VENDOR_DOMAINS) ||
    matches(host, SCAM_SHORTENER_HOSTS)
  ) {
    return null;
  }
  return host.replace(/^www\./, "");
}

/** First company-owned domain among the posting's apply link and public link. */
export function companyDomainFromPosting(p: {
  apply_url: string | null;
  url: string;
}): string | null {
  return companyDomainFromUrl(p.apply_url) ?? companyDomainFromUrl(p.url);
}
