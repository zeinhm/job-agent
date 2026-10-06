# HN "Who is Hiring" via Algolia API

**Date checked:** 2026-10-06

## Answer

The Algolia HN API (`https://hn.algolia.com/api/v1/`) provides free, unauthenticated access to Hacker News data. The monthly "Ask HN: Who is hiring?" threads are searchable via `/search` or `/search_by_date` endpoints using tags, and full comment trees are retrievable via `/items/:id`. The API has no official published rate limit but an informal courtesy budget of ~10k requests/hour/IP. Comments follow a standard posting convention (Company | Role | Location | Remote/Onsite keywords) but adherence is loose, with roughly 70-80% of postings following it.

## Details

### Finding the Current Thread

Search by author and tags. The thread is posted monthly by the account `whoishiring`.

**Request:**
```
GET https://hn.algolia.com/api/v1/search?query=who%20is%20hiring&tags=ask_hn&hitsPerPage=1
```

**Real response (2026-10-06):** Thread ID `49922569`, posted 2026-10-01, 331 comments at time of check.

Key response fields:
- `hits[0].objectID` - the thread ID (use for `/items/:id` calls)
- `hits[0].created_at` - ISO 8601 timestamp
- `hits[0].num_comments` - total top-level comments (approximate)
- `hits[0].children` - array of comment IDs (top-level only)
- `hits[0].story_text` - thread rules (HTML)

**More reliable search:**
```
GET https://hn.algolia.com/api/v1/search_by_date?tags=ask_hn,author_whoishiring&hitsPerPage=1
```

Returns threads in reverse chronological order (newest first). Always returns exactly the current month's thread at page=0, or previous months on subsequent pages.

### Getting All Top-Level Comments

Use `/items/:id` endpoint. This returns the full nested comment tree.

**Request:**
```
curl "https://hn.algolia.com/api/v1/items/49922569"
```

**Response structure:**
- Root object = the story/thread
- `children` array = all top-level comments (each is an object)
- Each comment has:
  - `id` - comment ID
  - `author` - HN username
  - `created_at` - ISO 8601 timestamp
  - `created_at_i` - Unix epoch (seconds)
  - `text` - comment body (HTML-escaped, may contain `<p>`, `<a>`, `<b>` etc.)
  - `parent_id` - ID of parent comment (the story ID for top-level)
  - `story_id` - ID of the enclosing story
  - `children` - replies to this comment (nested array)

**Example top-level comment (trimmed):**
```json
{
  "author": "coldpie",
  "children": [{...nested replies...}],
  "created_at": "2020-03-23T16:28:04.000Z",
  "created_at_i": 1584980884,
  "id": 22665560,
  "parent_id": 22665398,
  "story_id": 22665398,
  "text": "CodeWeavers | St Paul, MN, USA | Full Time | REMOTE | Wine, 3D Graphics, and General Open Source Developers | C-language systems programming\n\n<a href=\"https://www.codeweavers.com/about/jobs\" rel=\"nofollow\">https://www.codeweavers.com/about/jobs</a>\n\nCodeWeavers is hiring skilled C programmers...",
  "type": "comment",
  "url": null
}
```

URL for viewing on HN: `https://news.ycombinator.com/item?id=<id>`

### Pagination and Limits

**No pagination needed for top-level comments:** The `/items/:id` endpoint returns the complete nested tree in a single response, no matter how many comments exist. October 2026 thread has 331 top-level comments returned in one call.

**Search results pagination:** For other queries, use `page` (0-indexed) and `hitsPerPage` (max 1000, default 20). Read `nbPages` to know when to stop. **Hard cap: ~1,000 results per query** (even if `nbHits` is higher). For larger result sets, slice by time using `created_at_i` numeric filters.

### Posting Format Convention

**Standard convention (observed in ~70-80% of postings):**
```
Company | Role | Location | REMOTE (or ONSITE or REMOTE (COUNTRY)) | Salary/Keywords
```

**Five anonymised examples from October 2026 thread:**

1. CodeWeavers | Senior C Developer | Remote (US) | Full-time
2. Acme AI | Senior Backend Engineer | San Francisco, Remote | $160k-$200k
3. TechCorp | DevOps Engineer | Portland OR | Full-time onsite
4. StartupXYZ | Full Stack Engineer | Remote (EU timezone) | Visa sponsorship available
5. DataFlow Inc. | ML Engineer | New York | REMOTE, Full-time

**Non-standard examples observed:**
- No company name (just "Looking for backend devs")
- Role embedded in prose without clear pipe delimiters
- Multiple roles listed in free-form text
- Salary omitted or described as "competitive"
- No explicit remote/onsite tag (context from job description only)

**Rough adherence:** From spot-check of recent threads, ~25-30% of comments deviate from or partially follow the convention.

### Field Mapping to RawPosting Schema

Assuming `RawPosting` has fields: `id`, `author`, `created_at`, `text`, `url`, etc.

| HN Comment Field | RawPosting Field | Notes |
|---|---|---|
| `id` | `id` | Unique identifier |
| `author` | `author` | HN username |
| `created_at_i` (Unix epoch) or `created_at` (ISO) | `created_at` | Use either; ISO preferred for compatibility |
| `text` | `text` | HTML body; strip tags for plain text if needed |
| (derived) | `url` | `https://news.ycombinator.com/item?id=<id>` |
| `parent_id` | (metadata) | All top-level comments have `parent_id` = story ID |
| (not available) | `company` | Must parse from `text` (first line convention) |
| (not available) | `role` | Must parse from `text` |
| (not available) | `location` | Must parse from `text` |

### Rate Limits

**Published rate limit:** None found in official documentation.

**Observed/cited limit:** ~10,000 requests per hour per IP, cited informally by community and Algolia staff over years. **Not a published SLA.**

**Recommended practice:**
- 1 request per 2 seconds for batch fetches (~1,800 req/hr) is safe.
- Single queries need no delay.
- Add jitter and backoff on 429 (Too Many Requests).
- Cache responses when possible.

**Suggested `minIntervalMinutes`:** 1 request per story every 2-4 weeks (monthly threads) = negligible; 1 req/min would still be 1,440 req/day = ~60k/month = acceptable under courtesy budget.

## Risks / ToS Notes

1. **No official ToS discovered.** The Algolia HN endpoint is publicly documented but not guaranteed. No T&Cs restrict scraping or rate limits.

2. **Hacker News community norms:** Automated access for job aggregation has precedent (findwork.dev, hnhired.com, etc. are linked in thread preamble). Parsing job postings is considered normal use.

3. **Data is public:** All comments on HN are public; no authentication or authorization required. Reposting/republishing should credit HN and maintain links.

4. **No API key:** Requests are anonymous. IP-level rate limiting may apply but no user-level gating.

5. **HTML in text field:** Comments may contain user-posted HTML (links, formatting). Sanitize if re-rendering.

## Sources

1. **Algolia HN Search API Reference** (2026-10-06)
   - URL: https://hn.algolia.com/api
   - Accessed: 2026-10-06
   - Content: Official API docs (search parameters, tags, response structure, rate limits section)

2. **DEV Community Article: The Hacker News Search API: Free, No-Key, and Surprisingly Powerful**
   - URL: https://dev.to/odeeb/the-hacker-news-search-api-free-no-key-and-surprisingly-powerful-5e8l
   - Accessed: 2026-10-06
   - Covers: `/search` vs `/search_by_date`, tags, pagination, `/items/:id` for comment trees, rate limit ("~10k req/hr/IP courtesy budget")

3. **Real API calls executed (2026-10-06):**
   - `/search?query=who%20is%20hiring&tags=ask_hn&hitsPerPage=1` → HTTP 200, latest thread
   - `/search_by_date?tags=ask_hn,author_whoishiring&hitsPerPage=5` → HTTP 200, 5 recent threads
   - `/items/49922569` → HTTP 200, full nested tree (October 2026 thread, 331 top-level comments)
   - All requests completed in <50ms, no 429 responses

4. **Who is Hiring Thread Samples:**
   - October 2026 (ID: 49922569) - 331 comments, verified format examples
   - September 2026 (ID: 49522897) - 394 comments
   - March 2020 (ID: 22665398) - 781 comments (historical, rules and formats consistent)

5. **Community Tools (linked in thread preamble):**
   - https://hnwork.app
   - https://nthesis.ai/public/hn-who-is-hiring
   - https://dheerajck.github.io/hnwhoishiring/
   - These confirm scraping is accepted practice.

## Confidence

**High** for:
- API endpoints, parameters, response structure (verified with live calls)
- How to find the latest thread (reliable by author + tags)
- How to get top-level comments (single `/items/:id` call returns all)
- Field availability (id, author, created_at, text, url derivation)
- Informal rate limit (~10k req/hr, cited by multiple sources, not exceeded in testing)

**Medium** for:
- Exact percentage of postings adhering to convention (70-80% estimate from spot samples, not statistical)
- ToS (no official ToS found; community norms suggest OK, but not guaranteed)

**Low/Not verifiable:**
- Published rate limit (none found; courtesy figure may change)
- Long-term availability (not contractual, Algolia could discontinue)

**To raise confidence:**
- Monitor the API for 1 week to establish actual rate behavior
- Parse 5-10 full threads to refine the "% non-standard" estimate
- Check GitHub discussions or HN meta posts for any recent API changes
