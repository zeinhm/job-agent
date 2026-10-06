import {
  SourceError,
  httpGetText,
  log,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

const SOURCE = "weworkremotely";
const MIN_INTERVAL_MINUTES = 60;
const UNKNOWN_COMPANY = "unknown";

export const FEED_URLS = [
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
] as const;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "item",
});

const text = z.string().min(1);

const envelopeSchema = z.object({
  rss: z.object({
    channel: z.object({ item: z.array(z.unknown()).optional() }),
  }),
});

const itemSchema = z.object({
  title: text,
  link: text,
  guid: text.optional(),
  pubDate: text.refine((s) => !Number.isNaN(new Date(s).getTime()), "invalid date").optional(),
  region: text.optional(),
  category: text.optional(),
  type: text.optional(),
  skills: text.optional(),
  description: text.optional(),
});
type WwrItem = z.infer<typeof itemSchema>;

/** WWR titles are "Company: Job title"; without a colon the whole string is the title. */
function splitTitle(raw: string): { company: string; title: string } {
  const idx = raw.indexOf(":");
  if (idx > 0) {
    const company = raw.slice(0, idx).trim();
    const title = raw.slice(idx + 1).trim();
    if (company && title) return { company, title };
  }
  return { company: UNKNOWN_COMPANY, title: raw };
}

function mapTags(item: WwrItem): string[] {
  const skills = (item.skills ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^and\s+/i, ""))
    .filter((s) => s.length > 0);
  return [...new Set([item.category, item.type, ...skills].filter((t): t is string => !!t))];
}

function mapItem(item: WwrItem): RawPosting {
  const { company, title } = splitTitle(item.title);
  const tags = mapTags(item);
  return {
    source: SOURCE,
    externalId: item.guid ?? item.link,
    url: item.link,
    title,
    company,
    ...(item.description && { descriptionHtml: item.description }),
    ...(item.region && { locationText: item.region }),
    ...(item.pubDate && { postedAt: new Date(item.pubDate).toISOString() }),
    ...(tags.length > 0 && { tags }),
  };
}

function parseFeed(feedUrl: string, body: string): RawPosting[] {
  const validation = XMLValidator.validate(body);
  if (validation !== true) {
    throw new SourceError(SOURCE, `malformed XML in ${feedUrl}: ${validation.err.msg}`);
  }
  const envelope = envelopeSchema.safeParse(parser.parse(body));
  if (!envelope.success) {
    throw new SourceError(SOURCE, `invalid feed envelope in ${feedUrl}`, {
      cause: envelope.error,
    });
  }
  const items = envelope.data.rss.channel.item ?? [];
  const postings: RawPosting[] = [];
  let invalid = 0;
  for (const raw of items) {
    const parsed = itemSchema.safeParse(raw);
    if (!parsed.success) {
      invalid++;
      const guid =
        typeof raw === "object" && raw !== null && "guid" in raw ? String(raw.guid) : undefined;
      log.warn("weworkremotely: skipping invalid item", {
        source: SOURCE,
        feed: feedUrl,
        externalId: guid,
        path: parsed.error.issues[0]?.path.join("."),
      });
      continue;
    }
    postings.push(mapItem(parsed.data));
  }
  if (invalid * 2 > items.length) {
    throw new SourceError(SOURCE, `${invalid} of ${items.length} items invalid in ${feedUrl}`);
  }
  return postings;
}

export function createWeWorkRemotelyAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      const seen = new Set<string>();
      const results: RawPosting[] = [];
      for (const feedUrl of FEED_URLS) {
        let body: string;
        try {
          body = await httpGetText(feedUrl);
        } catch (err) {
          throw new SourceError(SOURCE, `request failed for ${feedUrl}`, { cause: err });
        }
        for (const posting of parseFeed(feedUrl, body)) {
          if (seen.has(posting.externalId)) continue;
          seen.add(posting.externalId);
          if (posting.postedAt !== undefined && new Date(posting.postedAt) < since) continue;
          results.push(posting);
        }
      }
      return results;
    },
  };
}
