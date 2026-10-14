import { HttpError, log } from "@job-agent/core";
import {
  candidateUrls,
  defaultFetchPage,
  isAllowedRedirect,
  isLinkedInHost,
  RedirectRefusedError,
} from "../intel/company-research.ts";
import { normalizeCompanyName } from "../normalize/index.ts";
import { anchorsIn, atsLinksIn, isPollable, urlsIn, type AtsLink } from "./ats-links.ts";
import { hostOf } from "./boards.ts";

export type FetchPage = (url: string) => Promise<{ finalUrl: string; body: string }>;

/** What a company's careers pages show, kept in memory only (page text is never logged or stored). */
export interface CareersScan {
  /** ATS links with the visible text of their anchor, for the title match. */
  anchors: Array<{ link: AtsLink; text: string }>;
  /** Distinct boards: pollable ones first, then link-only vendors. */
  boards: AtsLink[];
  /** Pages requested. */
  requests: number;
  /** A fetch failed for a reason other than "no such page" (network, 5xx, 429, refused redirect). */
  incomplete: boolean;
  /** Short reason for the posting's `reason` when nothing was found. */
  note: string;
}

const boardKey = (l: AtsLink): string => `${l.vendor}:${l.slug.toLowerCase()}`;

function collect(html: string, pageUrl: string, scan: CareersScan): void {
  const seen = new Set(scan.boards.map(boardKey));
  const all = atsLinksIn([
    ...urlsIn(html, pageUrl),
    ...anchorsIn(html, pageUrl).map((a) => a.href),
  ]);
  for (const a of anchorsIn(html, pageUrl)) {
    const link = all.find((l) => l.url === a.href);
    if (link && a.text !== "") scan.anchors.push({ link, text: a.text });
  }
  for (const l of all) {
    if (l.slug === "" || l.boardUrl === null) continue;
    const key = boardKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    scan.boards.push(l);
  }
  scan.boards.sort((a, b) => Number(isPollable(b.vendor)) - Number(isPollable(a.vendor)));
}

/**
 * Fetches at most 2 pages (`/careers`, `/jobs`) of the company domain under the company-research rules (shared
 * fetcher: https only, redirects only within the registrable domain or to a known ATS host, no LinkedIn, 1 request
 * per 2 s per host) and stops at the first page that shows an ATS link.
 */
export async function scanCareers(
  domain: string,
  fetchPage: FetchPage = defaultFetchPage,
): Promise<CareersScan> {
  const scan: CareersScan = { anchors: [], boards: [], requests: 0, incomplete: false, note: "" };
  const notes: string[] = [];
  for (const url of candidateUrls(domain)) {
    scan.requests++;
    try {
      const page = await fetchPage(url);
      if (isLinkedInHost(page.finalUrl) || !isAllowedRedirect(url, page.finalUrl)) {
        scan.incomplete = true;
        notes.push(`${hostOf(url)}: redirected off-site`);
        continue;
      }
      collect(page.body, page.finalUrl, scan);
      if (scan.boards.length > 0 || scan.anchors.length > 0) return scan;
      notes.push("no ATS link on the page");
    } catch (e) {
      if (e instanceof RedirectRefusedError) {
        scan.incomplete = true;
        notes.push(e.message);
      } else if (e instanceof HttpError && e.status === 404) {
        notes.push("HTTP 404");
      } else {
        scan.incomplete = true;
        notes.push(e instanceof HttpError ? `HTTP ${e.status ?? "network error"}` : "fetch error");
        log.warn("apply-resolve: careers page request failed", {
          host: hostOf(url),
          error: e instanceof HttpError ? `HTTP ${e.status ?? "network error"}` : String(e),
        });
      }
    }
  }
  scan.note = notes.join(", ");
  return scan;
}

const squash = (s: string): string => normalizeCompanyName(s).replace(/[^a-z0-9]/g, "");

/** The registrable name label of a domain without separators: `jobs.acme-labs.io` -> `acmelabs`. */
function domainLabel(domain: string): string {
  const labels = domain
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const second = labels.at(-2) ?? "";
  const label =
    /^(?:co|com|org|net|ac|or|go)$/.test(second) && labels.length >= 3
      ? (labels.at(-3) ?? "")
      : second;
  return label.replace(/[^a-z0-9]/g, "");
}

/** Domain trust (batch audit t_c9a36eac M3): the normalized name is inside the domain label or the other way round. */
export function domainResemblesCompany(domain: string, companyName: string): boolean {
  const name = squash(companyName);
  const label = domainLabel(domain);
  if (name.length < 3 || label.length < 3) return false;
  return label.includes(name) || name.includes(label);
}
