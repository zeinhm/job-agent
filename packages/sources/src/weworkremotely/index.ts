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

const FEED_URLS = [
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
];

// Every value stays a string: ids, titles and dates must not be coerced to numbers.
const parser = new XMLParser({ parseTagValue: false, parseAttributeValue: false });

const text = z.string().trim().min(1);

const itemSchema = z.object({
  title: text,
  link: text,
  guid: text.optional(),
  pubDate: text.refine((s) => !Number.isNaN(Date.parse(s)), "invalid date").optional(),
  region: z.string().trim().optional(),
  description: z.string().optional(),
  category: z.string().trim().optional(),
  skills: z.string().optional(),
});
type WwrItem = z.infer<typeof itemSchema>;

const channelSchema = z.object({
  rss: z.object({
    channel: z.object({ item: z.unknown().optional() }).or(z.literal("")),
  }),
});

/** "Company: Job title" -> both parts; anything else keeps the full string as the title. */
function splitTitle(raw: string): { company: string; title: string } {
  const idx = raw.indexOf(":");
  if (idx > 0) {
    const company = raw.slice(0, idx).trim();
    const title = raw.slice(idx + 1).trim();
    if (company && title) return { company, title };
  }
  return { company: "unknown", title: raw };
}

function parseSkills(skills: string | undefined): string[] {
  if (!skills) return [];
  return skills
    .split(",")
    .map((s) => s.trim().replace(/^and\s+/i, ""))
    .filter(Boolean);
}

function mapItem(item: WwrItem): RawPosting {
  const { company, title } = splitTitle(item.title);
  const tags = [...(item.category ? [item.category] : []), ...parseSkills(item.skills)];
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

/** Parses a feed body into its raw items; envelope problems throw SourceError. */
function parseFeed(xml: string, url: string): unknown[] {
  const validity = XMLValidator.validate(xml);
  if (validity !== true) {
    throw new SourceError(SOURCE, `malformed XML from ${url}: ${validity.err.msg}`);
  }
  const envelope = channelSchema.safeParse(parser.parse(xml));
  if (!envelope.success) {
    throw new SourceError(SOURCE, `invalid feed envelope from ${url}`, { cause: envelope.error });
  }
  const channel = envelope.data.rss.channel;
  const items = channel === "" ? undefined : channel.item;
  if (items === undefined) return [];
  return Array.isArray(items) ? items : [items];
}

async function fetchFeed(url: string): Promise<unknown[]> {
  let xml: string;
  try {
    xml = await httpGetText(url);
  } catch (err) {
    throw new SourceError(SOURCE, `request failed for ${url}`, { cause: err });
  }
  return parseFeed(xml, url);
}

function itemId(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { guid, link } = item as { guid?: unknown; link?: unknown };
  const id = typeof guid === "string" ? guid : link;
  return typeof id === "string" ? id : undefined;
}

export function createWeWorkRemotelyAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      const byId = new Map<string, RawPosting>();
      let seen = 0;
      let invalid = 0;

      for (const url of FEED_URLS) {
        for (const raw of await fetchFeed(url)) {
          seen++;
          const parsed = itemSchema.safeParse(raw);
          if (!parsed.success) {
            invalid++;
            log.warn("weworkremotely: skipping invalid item", {
              source: SOURCE,
              externalId: itemId(raw),
              path: parsed.error.issues[0]?.path.join("."),
            });
            continue;
          }
          const posting = mapItem(parsed.data);
          if (posting.postedAt !== undefined && new Date(posting.postedAt) < since) continue;
          if (!byId.has(posting.externalId)) byId.set(posting.externalId, posting);
        }
      }

      if (invalid * 2 > seen) {
        throw new SourceError(SOURCE, `${invalid} of ${seen} items invalid`);
      }
      return [...byId.values()];
    },
  };
}
