import { log, type RawPosting } from "@job-agent/core";
import {
  findAshbyJob,
  findRecruiteeOffer,
  findWorkableJob,
  parseGreenhouseJob,
  parseLeverJob,
} from "@job-agent/sources";
import { atsLinkOf, greenhouseJobIdOf } from "./apply-links/ats-links.ts";
import { greenhouseSlugCandidates, resolveGreenhouseSlug } from "./questions/greenhouse-board.ts";
import { QuestionsHttp } from "./questions/index.ts";

/** The job a link names, on one of the five ATSs with a public job API. */
export type AtsJob =
  | { vendor: "greenhouse"; jobId: string; slug: string }
  /** A `?gh_jid=` link on a company's own page: the board slug is verified through the shared resolver first. */
  | { vendor: "greenhouse"; jobId: string; slug: null; candidates: string[] }
  | { vendor: "lever"; jobId: string; slug: string; eu: boolean }
  | { vendor: "ashby"; jobId: string; slug: string }
  | { vendor: "workable"; jobId: string; slug: string }
  | { vendor: "recruitee"; jobId: string; slug: string };

export type AtsFetchResult =
  | { kind: "ok"; text: string }
  /** Counted as a failed attempt of the posting (closed, not on the board, other job, bad or empty answer, HTTP error). */
  | { kind: "failed"; reason: string }
  /** The host refused (401 / 403 / 429): no more requests to it this run, no attempt counted. */
  | { kind: "deferred"; status: number };

export interface StoredBoard {
  ats: string | null;
  slug: string | null;
}

const SAFE_SLUG = /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/;
const JOB_ID = /^[A-Za-z0-9-]+$/;

/**
 * The ATS job a resolved apply link points at; null when the link is not a job link of Greenhouse, Lever, Ashby, Workable
 * or Recruitee, or names no job id or no usable board (a link with no board name uses the board stored for the same ATS).
 */
export function atsJobOf(
  applyUrl: string,
  companyName: string | null,
  stored: readonly StoredBoard[],
): AtsJob | null {
  const link = atsLinkOf(applyUrl);
  if (link === null || link.kind !== "job") return null;
  const storedSlug = stored.find((s) => s.ats === link.vendor && s.slug)?.slug ?? "";
  const slug = link.slug !== "" ? link.slug : storedSlug;
  const url = new URL(link.url);
  const seg = url.pathname.split("/").filter((s) => s !== "");

  switch (link.vendor) {
    case "greenhouse": {
      const jobId = greenhouseJobIdOf(link.url);
      if (jobId === "") return null;
      if (SAFE_SLUG.test(slug)) return { vendor: "greenhouse", jobId, slug };
      const candidates = greenhouseSlugCandidates(companyName, link.url);
      return candidates.length > 0 ? { vendor: "greenhouse", jobId, slug: null, candidates } : null;
    }
    case "lever": {
      const jobId = seg[1] ?? "";
      if (!JOB_ID.test(jobId) || !SAFE_SLUG.test(slug)) return null;
      return {
        vendor: "lever",
        jobId,
        slug,
        eu: url.hostname.toLowerCase() === "jobs.eu.lever.co",
      };
    }
    case "ashby": {
      const fromPath = url.hostname.toLowerCase() === "jobs.ashbyhq.com" ? (seg[1] ?? "") : "";
      const jobId = fromPath !== "" ? fromPath : (url.searchParams.get("ashby_jid") ?? "");
      if (!JOB_ID.test(jobId) || !SAFE_SLUG.test(slug)) return null;
      return { vendor: "ashby", jobId, slug };
    }
    case "workable": {
      const at = seg.indexOf("j");
      const jobId = at >= 0 ? (seg[at + 1] ?? "") : "";
      if (!JOB_ID.test(jobId) || !SAFE_SLUG.test(slug)) return null;
      return { vendor: "workable", jobId, slug };
    }
    case "recruitee": {
      const at = seg.indexOf("o");
      const jobId = at >= 0 ? (seg[at + 1] ?? "") : "";
      if (!JOB_ID.test(jobId) || !SAFE_SLUG.test(slug)) return null;
      return { vendor: "recruitee", jobId, slug };
    }
    default:
      return null;
  }
}

/** What the stored text of a RawPosting is: plain text when the ATS sends it, else its HTML, as the adapters store it. */
function textOf(raw: RawPosting): string {
  return (raw.descriptionText ?? raw.descriptionHtml ?? "").trim();
}

/**
 * Fetches single jobs from the ATSs' public APIs: GET only, logged out, no redirect followed, the shared client's per-host
 * rate (2 s). A host that answers 401 / 403 / 429 gets no more requests this run. Board lists (Ashby, Workable,
 * Recruitee) are fetched once per board and run.
 */
export class AtsDescriptionFetcher {
  readonly http = new QuestionsHttp();
  private readonly lists = new Map<string, ReturnType<QuestionsHttp["getJson"]>>();

  private list(url: string): ReturnType<QuestionsHttp["getJson"]> {
    let cached = this.lists.get(url);
    if (cached === undefined) {
      cached = this.http.getJson(url);
      this.lists.set(url, cached);
    }
    return cached;
  }

  async fetch(job: AtsJob): Promise<AtsFetchResult> {
    try {
      return await this.fetchJob(job);
    } catch (err) {
      // A body the adapter's schema refuses (invalid job, wrong envelope).
      log.warn("fetch-descriptions: ATS answer not understood", {
        vendor: job.vendor,
        error: err instanceof Error ? err.name : "unknown",
      });
      return { kind: "failed", reason: "unexpected response" };
    }
  }

  private async fetchJob(job: AtsJob): Promise<AtsFetchResult> {
    switch (job.vendor) {
      case "greenhouse": {
        let slug: string;
        if ("candidates" in job) {
          const found = await resolveGreenhouseSlug(this.http, job.jobId, job.candidates);
          if (found.kind === "deferred") return found;
          if (found.kind === "not_found") return { kind: "failed", reason: "board not found" };
          slug = found.slug;
        } else {
          slug = job.slug;
        }
        const res = await this.http.getJson(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${job.jobId}`,
        );
        if (res.kind !== "ok") return this.notOk(res);
        const raw = parseGreenhouseJob(res.body);
        return this.same(raw, String(raw.externalId) === job.jobId);
      }
      case "lever": {
        const host = job.eu ? "api.eu.lever.co" : "api.lever.co";
        const res = await this.http.getJson(
          `https://${host}/v0/postings/${encodeURIComponent(job.slug)}/${encodeURIComponent(job.jobId)}`,
        );
        if (res.kind !== "ok") return this.notOk(res);
        const raw = parseLeverJob(res.body);
        return this.same(raw, raw.externalId.toLowerCase() === job.jobId.toLowerCase());
      }
      case "ashby": {
        const res = await this.list(
          `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(job.slug)}?includeCompensation=true`,
        );
        if (res.kind !== "ok") return this.notOk(res);
        const raw = findAshbyJob(res.body, job.jobId);
        return raw === null ? this.gone("job not on the board") : this.same(raw, true);
      }
      case "workable": {
        const res = await this.list(
          `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(job.slug)}?details=true`,
        );
        if (res.kind !== "ok") return this.notOk(res);
        const raw = findWorkableJob(res.body, job.jobId);
        return raw === null ? this.gone("job not on the board") : this.same(raw, true);
      }
      case "recruitee": {
        const res = await this.list(`https://${job.slug.toLowerCase()}.recruitee.com/api/offers/`);
        if (res.kind !== "ok") return this.notOk(res);
        const raw = findRecruiteeOffer(res.body, job.jobId);
        return raw === null ? this.gone("offer not on the board") : this.same(raw, true);
      }
    }
  }

  private gone(reason: string): AtsFetchResult {
    return { kind: "failed", reason };
  }

  private notOk(res: Exclude<Awaited<ReturnType<QuestionsHttp["getJson"]>>, { kind: "ok" }>) {
    if (res.kind === "deferred") return res;
    return this.gone(res.kind === "missing" ? "job not found (closed)" : res.reason);
  }

  /** The fetched job must be the link's job; its text must not be empty. */
  private same(raw: RawPosting, sameId: boolean): AtsFetchResult {
    if (!sameId) return this.gone("job id differs from the link");
    const text = textOf(raw);
    return text === "" ? this.gone("job has no text") : { kind: "ok", text };
  }
}
