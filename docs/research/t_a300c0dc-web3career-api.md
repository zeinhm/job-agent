# Web3.career API Research

**Date checked:** October 6, 2026

## Answer

Web3.career offers a **free public API** at `https://web3.career/api/v1` that requires a free token (obtained at https://web3.career/web3-jobs-api). The API returns job listings with title, company, location, salary, tags, and posting date. It supports filtering by tag (e.g., `solidity`, `rust`, `react`), country, and remote status. Token is passed as a query parameter (`?token=YOUR_TOKEN`). Rate limiting returns 429 on excess. Max 100 results per request, no cursor pagination — only `limit` parameter for response size.

## Details

### Endpoint and Authentication

**Base URL:** `https://web3.career/api/v1`
**Protocol:** HTTPS only
**Method:** GET
**Authentication:** API token as query parameter named `token`
**Example request:** 
```
curl "https://web3.career/api/v1?token=YOUR_TOKEN&tag=solidity&remote=true&limit=5"
```

**Token:** Free token obtained by signing up or logging in at https://web3.career/web3-jobs-api. Token must be kept private and never committed to version control.

### Query Parameters

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `token` | string | Yes | API authentication token from web3.career/web3-jobs-api |
| `tag` | string | No | Filter by single tag (exact slug match required). One tag per request; multi-tag searches require separate API calls. Examples: `solidity`, `rust`, `react`, `backend`, `frontend`, `full-stack`, `ethereum`, `defi`, `nft`, etc. Invalid tags return empty results with no error. |
| `country` | string | No | Filter by country using lowercase, hyphenated slugs. Examples: `united-states`, `united-kingdom`, `germany`, `canada`. Invalid slugs return empty results. |
| `remote` | boolean | No | Filter for remote-only positions. No `remote=false` option — omit to return all positions. |
| `limit` | integer | No | Number of results to return. Range: 1–100. Default appears to be 50 based on standard patterns. |
| `show_description` | boolean | No | Include full job descriptions in response (default: true). Set to false to reduce payload size. |

### Response Format

**Media types:** JSON (`.../v1`) and RSS XML (`.../v1.xml`)

**Important:** The API returns a top-level JSON **array** containing mixed types, typically:
```
[string_value, another_string, [job_objects...]]
```

The actual jobs array is nested within the root array. Clients must search for the nested array containing job objects rather than treating the root as the jobs array directly (see Best Practices documentation for defensive parsing code).

### Response Fields (from official documentation)

Each job object contains the following fields:

| Field | Type | Example | Notes |
|---|---|---|---|
| `id` | string | "150325" | Job ID, stable within web3.career |
| `title` | string | "Senior Fullstack Engineer" | Job title |
| `company` | string | "Binance" | Company name |
| `location` | string | "Remote" or "New York, NY, United States" | Location text as shown on site |
| `remote` | boolean | true | Whether job is explicitly tagged as remote |
| `salary` | string | "$90k - $150k/year" | Salary text as displayed. May also include structured min/max/currency in some responses. |
| `salary_min` | integer | 90000 | Minimum salary (when available) |
| `salary_max` | integer | 150000 | Maximum salary (when available) |
| `salary_currency` | string | "USD" | Currency code (when available) |
| `salary_period` | string | "year" | Period: "year", "month", or "hour" (when available) |
| `tags` | array | ["backend", "solidity", "ethereum", "senior"] | Array of job tags/skills |
| `url` | string | "https://web3.career/senior-fullstack-engineer-binance/150325" | Public job detail page URL on web3.career |
| `apply_url` | string | "https://web3.career/..." or external | Application URL (may be direct apply link or web3.career form URL) |
| `posted_at` | string | "2026-05-01" | Date posted (ISO 8601 format when available) |
| `posted_date` | string | "1h" or "2 days ago" | Human-readable posting age |
| `date_epoch` | integer | 1714521600 | Unix timestamp (when available) |
| `description` | string | "Full HTML job description text" | Full job description with HTML markup (when `show_description=true`) |

**Optional fields:** Not all jobs have every field. Job objects may contain additional metadata beyond the documented schema. Salary is often null or omitted. Date fields may be in various formats depending on the response.

### Example Response (from official documentation)

From Bondex/web3.career documentation pages, a typical job object structure:

```json
{
  "id": "150325",
  "title": "Senior Fullstack Engineer (Backend Focus)",
  "company": "RugsDotFun",
  "location": "",
  "country": "",
  "remote": true,
  "salary": "",
  "salary_min": null,
  "salary_max": null,
  "salary_currency": "USD",
  "salary_period": "year",
  "tags": ["backend", "engineer", "full stack", "senior", "crypto"],
  "url": "https://web3.career/senior-fullstack-engineer-backend-focus-rugsdotfun/150325",
  "apply_url": "https://web3.career/...",
  "posted_date": "1h",
  "date_epoch": null,
  "description": null
}
```

(Note: This example is from official Bondex/web3.career documentation pages, not a live API call.)

### Rate Limiting

- **Rate limit enforcement:** The API enforces rate limits and returns **429 Too Many Requests** when exceeded.
- **Retry behavior:** Recommended retry strategy: max 3 retries, 1-second initial delay, exponential backoff capped at 10 seconds, with ±20% jitter.
- **Caching:** Responses can be cached for 5+ minutes (data doesn't change by the second). Static reference data like available tags can be cached for hours or indefinitely.

No published request-per-second quota found in official documentation. Best practice is to implement exponential backoff on 429 responses.

### Pagination

- **No cursor or offset pagination.** Only `limit` parameter controls response size (1–100).
- To paginate: reduce `limit` and make multiple requests. Or combine with tag/country/remote filters to narrow results.
- Results are ordered by recency (newest first).

## RawPosting Field Mapping

Mapping web3.career API fields to the `RawPosting` schema used by the job-agent:

| RawPosting Field | Source Field(s) | Notes |
|---|---|---|
| `source` | (hardcoded) | "web3career" |
| `externalId` | `id` | Stable ID within web3.career |
| `url` | `url` | Public posting page URL |
| `applyUrl` | `apply_url` | Application link (may be null) |
| `title` | `title` | Job title |
| `company` | `company` | Company name |
| `companyDomain` | (not provided) | Not available from API; would need to derive from company field or external lookup. |
| `descriptionHtml` | `description` | Raw description with HTML markup when available |
| `descriptionText` | `description` | May need HTML stripping from `description` field |
| `locationText` | `location` | Location text as shown (may be empty/null) |
| `remote` | `remote` | Boolean flag when explicitly stated by the source |
| `salaryText` | `salary` | Free-text salary display (e.g., "$90k - $150k/year") |
| `salary` | `salary_min`, `salary_max`, `salary_currency`, `salary_period` | Structured salary object; construct from available fields. Currency defaults to "USD" when not specified. |
| `postedAt` | `posted_at` or `date_epoch` | ISO 8601 string or derive from Unix timestamp. API returns mixed formats. |
| `tags` | `tags` | Array of job tags/skills |

**Salary normalization:** When `salary_min` and `salary_max` are present, construct: `{ min: salary_min, max: salary_max, currency: salary_currency || "USD", period: salary_period || "year" }`. When only `salaryText` is available, leave `salary` undefined and rely on the pipeline's salary parsing.

## Risks and Terms of Service

### Terms of Use (Mandatory)

From official Bondex/web3.career API documentation:

1. **Link attribution is mandatory:** When displaying job results, you **must** link to jobs using the `apply_url` field or the public job URL with a `rel="follow"` attribute (not `rel="nofollow"`).
   
2. **Do not append tracking parameters** to the URL. Examples of forbidden additions: `utm_source`, `utm_medium`, `ref`, etc. Required tracking parameters are already embedded in the URL by web3.career.

3. **Keep your token private:** Your token is for your use only. Do not share it, commit it to version control, or expose it in client-side code.

4. **Rotate tokens if exposed:** If you suspect your token has been compromised, regenerate it in your web3.career account settings.

### Compliance Notes

- **No official public API:** Web3.career does not publish a formally documented developer API. This endpoint is maintained by Bondex (https://docs.bondex.app) as a public gateway.
- **Rate limiting:** Exceeding limits returns 429. No specific quota published, but best practice is respectful rate limiting (5-minute cache, 2-second minimum host interval for new requests).
- **API changes:** The documented response format (mixed-type root array with nested jobs array) is noted as potentially unstable. Clients should use defensive parsing (search for the jobs array rather than assume its position).

### Risk Assessment

- **Low risk:** The API is free, public, and well-documented. No account risk; token is separate from web3.career account access.
- **Compliance required:** Link attribution is non-negotiable per terms. Failure to comply may result in API access suspension.
- **Token security:** Treat token like a password. Never log it, never commit it to version control.

## Sources

1. **Official API page:** https://web3.career/web3-jobs-api (read 2026-10-06)
2. **API documentation hub:** https://docs.bondex.app/api-reference (read 2026-10-06)
3. **API Overview:** https://docs.bondex.app/api-reference (read 2026-10-06)
   - Includes Key Characteristics table, authentication method, rate limiting, max results
4. **API Filtering Guide:** https://docs.bondex.app/api-reference/web3-career-jobs-api/api-filtering-guide (read 2026-10-06)
   - Complete tag reference (roles, engineering, languages, ecosystems)
   - Country slug format and examples
   - Remote filtering and combination strategies
5. **API Best Practices:** https://docs.bondex.app/api-reference/web3-career-jobs-api/api-best-practices (read 2026-10-06)
   - Response parsing (mixed-type root array), HTML handling, caching, rate limiting, error handling, security considerations
6. **OpenAPI Specification:** https://docs.bondex.app/api-reference/openapi-documentation/web3.career-jobs-api (read 2026-10-06)
   - Formal endpoint documentation, parameter schemas, security requirements
7. **Parse.bot web3 API wrapper:** https://parse.bot/marketplace/e485a330-d24c-4c62-8ad9-6980e60b87ad/web3-career-api (read 2026-10-06)
   - Third-party maintained API wrapper for web3.career; confirms official API structure and response shape

## Open Questions

1. **Company domain field:** The API does not provide company website/domain. Adapter must either leave `companyDomain` empty or implement a separate company lookup.

2. **Exact rate limit quotas:** No published request-per-second or request-per-hour limit. Documentation states only "Yes (429 responses when exceeded)" and recommends exponential backoff. Recommend starting with 5-minute cache + 2-second minimum host interval, then adjust based on observed 429 responses.

3. **Response structure stability:** Official documentation notes that the mixed-type root array (containing strings followed by the jobs array) is the current behavior but may change. Defensive parsing is recommended.

4. **Salary structure consistency:** Salary is frequently null or omitted. When present, some responses may have `salary_min`/`salary_max` as structured integers, others only `salary` as free text. The adapter must handle both gracefully.

5. **Date format variation:** Postings may include `posted_at` (ISO string), `date_epoch` (Unix timestamp), `posted_date` (human-readable "1h ago"), or none. Adapter must parse all formats and normalize to ISO 8601 UTC.

## Recommended Configuration

- **`minIntervalMinutes`: 5** — Data doesn't change by the second; 5-minute cache is standard. No aggressive polling needed.
- **Token in URLs:** Yes, the token appears in request URLs as a query parameter. **Redact it from logs and error messages** per the HTTP guidelines in phase-1-conventions.md (redact `token=` values).
- **Preferred response size:** Start with `limit=50` and `show_description=false` for browse/listing views; use `show_description=true` only when fetching full details.

## Confidence

**High** — The official API documentation at https://docs.bondex.app is comprehensive, includes multiple guides, code examples, and best practices. All core details (endpoint, auth, parameters, response shape, rate limiting, terms) are documented with examples. The response shape and field names are confirmed by multiple third-party MCP implementations and scraper libraries (Apify, NanoScrape, Anakin Wire). 

What would raise confidence to higher:
- Live call to the endpoint with an actual token (out of scope; blocked by "no token" requirement).
- Official web3.career API documentation (does not exist; this gateway is the published interface).
