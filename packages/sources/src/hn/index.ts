import {
  SourceError,
  httpGetJson,
  log,
  type RawPosting,
  type SourceAdapter,
} from "@job-agent/core";
import { z } from "zod";
import { parseFirstLine } from "./parse.ts";

const SOURCE = "hn";
const API = "https://hn.algolia.com/api/v1";
const SEARCH_URL = `${API}/search_by_date?tags=story,author_whoishiring&hitsPerPage=5`;
const THREAD_TITLE_RE = /^Ask HN: Who is hiring\?/i;
// The thread is monthly; polling more often than every 6 hours only wastes requests.
const MIN_INTERVAL_MINUTES = 360;

const searchSchema = z.object({ hits: z.array(z.unknown()) });
const hitSchema = z.object({ objectID: z.string().min(1), title: z.string() });

const threadSchema = z.object({ children: z.array(z.unknown()) });

const commentSchema = z.object({
  id: z.number().int().positive(),
  created_at: z.string().min(1),
  author: z.string().nullish(),
  text: z.string().nullish(),
  type: z.string().nullish(),
  parent_id: z.number().int().nullish(),
});
type Comment = z.infer<typeof commentSchema>;

async function getValidated<S extends z.ZodType>(url: string, schema: S, what: string) {
  let body: unknown;
  try {
    body = await httpGetJson(url);
  } catch (err) {
    throw new SourceError(SOURCE, `${what} request failed`, { cause: err });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new SourceError(SOURCE, `invalid ${what} response envelope`, { cause: parsed.error });
  }
  return parsed.data as z.infer<S>;
}

async function findLatestThreadId(): Promise<string> {
  const { hits } = await getValidated(SEARCH_URL, searchSchema, "thread search");
  for (const raw of hits) {
    const hit = hitSchema.safeParse(raw);
    if (hit.success && THREAD_TITLE_RE.test(hit.data.title)) return hit.data.objectID;
  }
  throw new SourceError(SOURCE, 'no "Who is hiring?" thread found in search results');
}

function mapComment(comment: Comment, text: string): RawPosting {
  const parsed = parseFirstLine(text);
  const postedAt = new Date(comment.created_at);
  return {
    source: SOURCE,
    externalId: String(comment.id),
    url: `https://news.ycombinator.com/item?id=${comment.id}`,
    title: parsed.title,
    company: parsed.company,
    descriptionHtml: text,
    ...(parsed.locationText && { locationText: parsed.locationText }),
    ...(parsed.salaryText && { salaryText: parsed.salaryText }),
    postedAt: postedAt.toISOString(),
  };
}

export function createHnAdapter(): SourceAdapter {
  return {
    name: SOURCE,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    async fetch(since: Date): Promise<RawPosting[]> {
      const threadId = await findLatestThreadId();
      const thread = await getValidated(`${API}/items/${threadId}`, threadSchema, "thread items");

      const postings: RawPosting[] = [];
      let invalid = 0;
      let considered = 0;
      for (const raw of thread.children) {
        const parsed = commentSchema.safeParse(raw);
        if (!parsed.success) {
          considered++;
          invalid++;
          const externalId =
            typeof raw === "object" && raw !== null && "id" in raw ? String(raw.id) : undefined;
          log.warn("hn: skipping invalid comment", {
            source: SOURCE,
            externalId,
            path: parsed.error.issues[0]?.path.join("."),
          });
          continue;
        }
        const comment = parsed.data;
        // Only direct children of the story are job posts; replies are discussion.
        if (comment.parent_id !== Number(threadId)) continue;
        // Deleted and dead comments come back without author or text.
        if (!comment.author || !comment.text?.trim()) continue;
        if (comment.type && comment.type !== "comment") continue;
        considered++;
        if (Number.isNaN(new Date(comment.created_at).getTime())) {
          invalid++;
          log.warn("hn: skipping invalid comment", {
            source: SOURCE,
            externalId: String(comment.id),
            path: "created_at",
          });
          continue;
        }
        const posting = mapComment(comment, comment.text);
        if (posting.postedAt !== undefined && new Date(posting.postedAt) < since) continue;
        postings.push(posting);
      }
      if (invalid * 2 > considered) {
        throw new SourceError(SOURCE, `${invalid} of ${considered} comments invalid`);
      }
      return postings;
    },
  };
}
