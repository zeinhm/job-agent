# Research: Remotive, RemoteOK, Himalayas, and We Work Remotely Feeds

Date checked: 2026-10-06

## Remotive

### Answer

Remotive is a remote job board with a public REST JSON API at `https://remotive.com/api/remote-jobs`. The API is free, requires no authentication, and returns jobs sorted by publication date. API users must attribute Remotive and link back; rate limits: max 4 requests per day, blocks above 2 per minute. Jobs are delayed 24 hours for attribution protection.

### Details

**Endpoint(s):**
- Browse: `GET https://remotive.com/api/remote-jobs`
- Categories: `GET https://remotive.com/api/remote-jobs/categories`

**Query parameters:**
- `limit` (integer, optional): Number of jobs to return. Default appears to be all jobs.
- `category` (string, optional): Filter by category slug or name. Example: `category=software-dev`
- `company_name` (string, optional): Filter by company name (case-insensitive, partial match).

**Response format:** JSON object with structure:
```json
{
  "00-warning": "...",
  "0-legal-notice": "Legal warning string",
  "job-count": 18,
  "total-job-count": 18,
  "jobs": [
    {
      "id": 2091149,
      "url": "https://remotive.com/remote-jobs/software-development/software-engineer-ai-code-trainer-python-web-full-stack-2091149",
      "title": "Software Engineer / AI Code Trainer (Python, Web, Full Stack)",
      "company_name": "CodeForAI",
      "company_logo": "https://remotive.com/job/2091149/logo",
      "category": "Software Development",
      "tags": ["api", "backend", "C", "C#", "C++", "fullstack", "go", "java", "javascript", "node.js", "php", "python", "react", "ruby/rails", "security", "sql", "AI/ML", "rust", "NoSQL", "Typescript", "debugging", "scripting"],
      "job_type": "contract",
      "publication_date": "2026-10-05T05:15:43",
      "candidate_required_location": "USA, UK, India, Australia, Ireland, New Zealand, Philippines, Pakistan, Singapore, Mexico",
      "salary": "$45-$120/Hour",
      "description": "..HTML full description..."
    }
  ]
}
```

**Example trimmed item:**
```json
{
  "id": 1749306,
  "url": "https://remotive.com/remote-jobs/writing/freelance-copywriter-1749306",
  "title": "Freelance Copywriter",
  "company_name": "Coalition Technologies",
  "company_logo": "https://remotive.com/job/1749306/logo",
  "category": "Writing",
  "tags": ["accounting", "excel", "research", "data analysis", "bookkeeping", "google sheets", "quickbooks", "data entry", "insurance", "G Suite"],
  "job_type": "freelance",
  "publication_date": "2026-10-02T20:01:00",
  "candidate_required_location": "Worldwide",
  "salary": "$20k - $35k",
  "description": "<p>CT Marketing Agency is seeking skilled Freelance Copywriters...</p>"
}
```

**Field mapping to RawPosting:**

| Remotive field | RawPosting field | Notes |
|---|---|---|
| `id` | `externalId` | Stable numeric ID |
| `url` | `url` | Public job posting URL |
| (not provided) | `applyUrl` | Not in Remotive response; use `url` |
| `title` | `title` | Job title |
| `company_name` | `company` | Company hiring |
| (not provided) | `companyDomain` | Not provided |
| `description` | `descriptionHtml` | Full HTML description included in each record |
| (not provided) | `descriptionText` | Not provided; extract from HTML |
| `candidate_required_location` | `locationText` | Location restrictions as free text (e.g., "USA, UK, India...") |
| (not provided) | `remote` | Not explicitly stated; infer from category/location/description |
| `salary` | `salaryText` | Free text salary range (e.g., "$40,000 - $50,000", "$45-$120/Hour") |
| (not provided) | `salary` (structured) | Not provided; salary is text-only |
| `publication_date` | `postedAt` | ISO 8601 format, UTC |
| `tags` | `tags` | Array of technology/skill tags |
| `category` | (not in RawPosting) | Remotive category; store in tags or custom field if needed |

**Location restrictions:** The `candidate_required_location` field contains location restrictions; it may list specific countries or "Worldwide" for remote-friendly roles. This field should be parsed for location checking.

### Risks / ToS

- **Attribution required:** Must link back to Remotive URL with attribution. Failure results in API access suspension. https://remotive.com/api-documentation
- **24-hour delay:** Jobs are delayed 24 hours from posting on Remotive's board, intended to protect Remotive's first-mover advantage and drive traffic back.
- **No automated job board submission:** "Please do not submit Remotive jobs to third Party websites, including but not limited to: Jooble, Neuvoo, Google Jobs, LinkedIn Jobs." https://remotive.com/api-documentation
- **Rate limit:** Max 2 requests per minute will be blocked; recommended max 4 times per day. https://remotive.com/api-documentation
- **Paid API available:** Private API requires $5k/mo minimum. Email hello(at)remotive.com for details. https://remotive.com/api-documentation
- **Email collection prohibition:** "Displaying our jobs in order to collect signups/email addresses to show a listing constitutes a breach of our terms of services." https://remotive.com/api-documentation
- **RSS feeds available:** Alternative XML feeds at https://github.com/remotive-io/remote-jobs-feed (mentioned in docs).

**Recommended `minIntervalMinutes`:** 360 (6 hours). Conservative estimate given the advice of max 4 requests per day and data update cycle.

### Sources

- Official GitHub API documentation: https://github.com/remotive-com/remote-jobs-api (checked 2026-10-06)
- Remotive API page: https://remotive.com/remote-jobs/api (checked 2026-10-06)
- Live API response: `curl -s "https://remotive.com/api/remote-jobs?limit=2"` (checked 2026-10-06, HTTP 200)
- FreeAPIHub summary: https://freeapihub.com/apis/remotive-jobs-api (checked 2026-10-06)

**Confidence:** high. Official documentation is clear, API is stable and widely used, and live testing confirms endpoint and response format.

---

## RemoteOK

### Answer

RemoteOK publishes a free public JSON feed at `https://remoteok.com/api` with the most recent 100 jobs (approximately one week of history). No API key or authentication required. The first array element is metadata, not a job; skip it (index 0) when parsing. No pagination, search, or filtering available in the live API (though old tags filter is mentioned in docs, it is silently ignored). Jobs delayed 24 hours from posting.

### Details

**Endpoint:**
- `GET https://remoteok.com/api` – Returns a flat JSON array of the most recent jobs

**Query parameters:**
- None actively work. The `?tags=dev` filter mentioned in some old wrapper libraries returns byte-for-byte identical results (silently ignored).

**Response format:** JSON array where element [0] is metadata, elements [1:] are job objects:

```json
[
  {
    "last_updated": 1791205202,
    "legal": "API Terms of Service: Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source, so we get traffic back from your site. If you do not we'll have to suspend API access.\n\nPlease don't use the Remote OK logo without written permission as it's a registered trademark, please DO use our name Remote OK though."
  },
  {
    "slug": "remote-platform-and-integration-engineer-security-telemetry-redmimicry-1137465",
    "id": "1137465",
    "epoch": 1791205202,
    "date": "2026-10-05T13:00:02+00:00",
    "company": "RedMimicry",
    "company_logo": "",
    "position": "Platform and Integration Engineer Security Telemetry",
    "tags": ["golang", "infosec", "engineer", "part time"],
    "description": "Remote - Location: Mostly remote (within Germany)...",
    "location": "",
    "apply_url": "https://remoteOK.com/remote-jobs/remote-platform-and-integration-engineer-security-telemetry-redmimicry-1137465",
    "salary_min": 0,
    "salary_max": 0,
    "logo": "",
    "url": "https://remoteOK.com/remote-jobs/remote-platform-and-integration-engineer-security-telemetry-redmimicry-1137465"
  },
  ...100 job objects total (indices 1-100)
]
```

**Example trimmed item (index 1):**
```json
{
  "slug": "remote-head-of-operations-leverage-live-local-1137461",
  "id": "1137461",
  "epoch": 1791058832,
  "date": "2026-10-03T20:20:32+00:00",
  "company": "Leverage Live Local",
  "company_logo": "",
  "position": "Head of Operations",
  "tags": ["non tech", "ops", "exec"],
  "description": "<p>Leverage Live Local prepares and manages Florida...",
  "location": "",
  "apply_url": "https://remoteOK.com/remote-jobs/remote-head-of-operations-leverage-live-local-1137461",
  "salary_min": 170000,
  "salary_max": 350000,
  "logo": "",
  "url": "https://remoteOK.com/remote-jobs/remote-head-of-operations-leverage-live-local-1137461"
}
```

**Field mapping to RawPosting:**

| RemoteOK field | RawPosting field | Notes |
|---|---|---|
| `id` | `externalId` | Stable numeric ID (can be string) |
| `url` | `url` | Public posting URL on remoteok.com |
| `apply_url` | `applyUrl` | Often points to remoteok.com job page, not employer's form |
| `position` | `title` | Job title |
| `company` | `company` | Company name |
| (not provided) | `companyDomain` | Not provided |
| `description` | `descriptionHtml` | HTML full description in each record |
| (not provided) | `descriptionText` | Not provided; extract from HTML |
| `location` | `locationText` | Usually empty string or city name; unreliable. Check description for location info. |
| (not provided) | `remote` | Not explicitly stated; infer from description |
| (not provided) | `salaryText` | Not provided as text |
| `salary_min`, `salary_max` | `salary` (structured) | Usually 0 for most jobs. 3 of 100 jobs carried non-zero salary in sample. Use structured format with USD. No currency field; assume USD. |
| `epoch` | `postedAt` | Unix timestamp; convert to ISO 8601 |
| `date` | `postedAt` | ISO 8601 with timezone; prefer this field |
| `tags` | `tags` | Array of skill/role tags. Note: tags may be decorative/mismatched (e.g., construction role had tags: education, customer support, dev, marketing, exec, medical, recruiter, digital nomad). Unreliable for classification. |
| `slug` | (not in RawPosting) | Unique slug for the job; can store for deduplication |

**Array behavior:**
- Always exactly 100 jobs (indices 1-100 after metadata at 0).
- No pagination; represents approximately one week of history at current posting rate.
- Jobs older than ~7 days scroll out and are lost; no archive.
- No way to re-fetch old postings or know if a job is closed.

### Risks / ToS

- **Attribution mandatory:** "Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source. If you don't, we'll have to suspend API access." The legal notice is embedded in the API response as the first element's `legal` field. https://remoteok.com/api
- **24-hour delay:** "The API feed at /api is delayed by 24 hours so that Google knows it's Remote OK first posting the job to avoid duplicate content problems." Paid API available for instant access ($10k/mo minimum). https://github.com/RemoteCTO/remote-ok-ruby
- **Fixed window:** Feed holds only the 100 most recent jobs (no pagination). Older postings are gone forever once they scroll out.
- **No search/filter:** The `?tags=` filter is silently ignored; API always returns the same 100 most recent jobs regardless of query string.
- **RSS deprecated:** The RSS feed at `/remote-jobs.rss` returns HTTP 410 (Gone); no longer maintained. https://jobspipe.dev/blog/remoteok-api
- **Logo is trademarked:** "Please don't use the Remote OK logo without written permission as it's a registered trademark, please DO use our name Remote OK though." https://remoteok.com/api
- **Practical consequence:** RemoteOK cannot be queried; it must be harvested. Polling on a schedule and storing all records locally is the only way to build a time series and avoid losing jobs that scroll out. https://jobspipe.dev/blog/remoteok-api

**Recommended `minIntervalMinutes`:** 240 (4 hours). Given 24-hour delay, the feed updates slowly; a practical daily sync would miss no postings. Conservative estimate to respect the service.

### Sources

- Official RemoteOK API terms (featurebase): https://remoteok.featurebase.app/help/articles/3140840-is-there-an-api-or-rssjson-feed-of-remote-jobs (checked 2026-10-06)
- RemoteOK homepage: https://remoteok.com/ (checked 2026-10-06)
- Deep analysis (Jobspipe): https://jobspipe.dev/blog/remoteok-api (checked 2026-10-06)
- Live API response: `curl -s "https://remoteok.com/api"` (checked 2026-10-06, HTTP 200)
- Ruby wrapper notes: https://github.com/RemoteCTO/remote-ok-ruby (checked 2026-10-06)

**Confidence:** high. Behavior confirmed by live testing. The fixed 100-job window and no-pagination design is stable since 2018.

---

## Himalayas

### Answer

Himalayas provides a free public REST JSON API at `https://himalayas.app/jobs/api` (browse with pagination) and `https://himalayas.app/jobs/api/search` (filtered search). No authentication required. Maximum 20 jobs per request (reduced from higher limits on 2025-03-24). Cursor-based pagination is preferred over offset-based (offset is deprecated). API data updated every 24 hours. Attribution and link-back required; no submission to third-party boards like LinkedIn, Jooble, or Neuvoo.

### Details

**Endpoints:**
- Browse (pagination): `GET https://himalayas.app/jobs/api`
- Search (filtered): `GET https://himalayas.app/jobs/api/search`

**Browse query parameters:**
- `offset` (integer, default 0): Number of jobs to skip. Deprecated; use `cursor` instead.
- `limit` (integer, default 20, max 20): Number of jobs to return per request.
- `cursor` (string, optional): Cursor value from previous response for stable pagination.

**Search query parameters:**
- `q` (string): Free-text query (e.g., "react engineer")
- `country` (string): Country filter (ISO alpha-2, common names, slugs, or abbreviations)
- `worldwide` (boolean): Limit to worldwide-friendly jobs
- `exclude_worldwide` (boolean): Exclude worldwide matches when using country filter
- `seniority` (string): One or more of: Entry-level, Mid-level, Senior, Manager, Director, Executive
- `employment_type` (string): One or more of: Full Time, Part Time, Contractor, Temporary, Intern, Volunteer, Other
- `company` (string): One or more canonical company slugs (e.g., 'linear' or 'linear,vercel')
- `timezone` (string): Timezone filter (e.g., '-5', 'UTC-5', 'UTC+05:30')
- `sort` (string): One of: 'relevant', 'recent', 'salaryAsc', 'salaryDesc', 'nameAToZ', 'nameZToA', 'jobs'
- `page` (integer): 1-based results page (for search endpoint)

**Response format:** JSON object:

```json
{
  "comments": "21/08/2026: Cursor pagination is now available and is the preferred way to page through the feed...",
  "updatedAt": 1791302256,
  "offset": 0,
  "limit": 2,
  "totalCount": 118620,
  "nextCursor": "MjAyNi0xMC0wNlQxNTo1NzozNi4wNjkwMjVafDIzNjE2Mjc",
  "jobs": [
    {
      "title": "Systems and Network Administrator",
      "excerpt": "Looking for a role where you'll own real infrastructure, not just close tickets?",
      "companyName": "Satellite Office",
      "companySlug": "satellite-office",
      "companyLogo": "https://cdn-images.himalayas.app/oujslhfn0coab7vwj6ewuhocmqyu",
      "employmentType": "Full Time",
      "minSalary": null,
      "maxSalary": null,
      "salaryPeriod": "annual",
      "seniority": ["Mid-level"],
      "currency": null,
      "locationRestrictions": ["Philippines"],
      "timezoneRestrictions": [8],
      "categories": ["Systems-Administrator", "Network-Administrator", ...],
      "parentCategories": ["Operations"],
      "description": "<p>Looking for a role where you'll own real infrastructure...</p>",
      "pubDate": 1791302256,
      "expiryDate": 1796486254,
      "applicationLink": "https://himalayas.app/companies/satellite-office/jobs/systems-and-network-administrator",
      "guid": "https://himalayas.app/companies/satellite-office/jobs/systems-and-network-administrator"
    },
    {
      "title": "Java Developer",
      "excerpt": "Icertis Application Support Exp:7+ Years Location: Remote",
      "companyName": "Pontoonglobal",
      "companySlug": "pontoonglobal",
      "companyLogo": "https://cdn-images.himalayas.app/19vp1tj2hiu3u6c0ayy4u95l8ca4",
      "employmentType": "Full Time",
      "minSalary": 900000,
      "maxSalary": 2000000,
      "salaryPeriod": "annual",
      "seniority": ["Senior"],
      "currency": "INR",
      "locationRestrictions": ["India"],
      "timezoneRestrictions": [5.5],
      "categories": ["Application-Support-Engineer", "Technical-Support-Specialist", ...],
      "parentCategories": ["Customer Service", "Developer"],
      "description": "<p><strong>Icertis Application Support</strong>...",
      "pubDate": 1791302256,
      "expiryDate": 1796486254,
      "applicationLink": "https://himalayas.app/companies/pontoonglobal/jobs/java-developer",
      "guid": "https://himalayas.app/companies/pontoonglobal/jobs/java-developer"
    }
  ]
}
```

**Field mapping to RawPosting:**

| Himalayas field | RawPosting field | Notes |
|---|---|---|
| `guid` | `externalId` | Unique identifier; can extract job ID from URL structure if needed |
| `applicationLink` | `url` | Application link points to Himalayas job page |
| `applicationLink` | `applyUrl` | Same as `url` in this case |
| `title` | `title` | Job title |
| `companyName` | `company` | Company name |
| `companySlug` | (not in RawPosting) | Canonical slug for company; useful for filtering/lookups |
| `companyLogo` | (not in RawPosting) | Company logo URL |
| `description` | `descriptionHtml` | Full HTML description; sanitized per API docs |
| (not provided) | `descriptionText` | Extract from `description` HTML |
| `locationRestrictions` | `locationText` | Array of country codes/names where candidates must be based. Empty array means worldwide. |
| `timezoneRestrictions` | (not in RawPosting) | Array of accepted UTC offsets (e.g., [5.5] for India); store in custom field if needed |
| `minSalary`, `maxSalary`, `currency` | `salary` (structured) | Structured salary data. Currency provided (e.g., "USD", "INR"). salaryPeriod always "annual". Convert as needed. |
| (not provided) | `salaryText` | Not provided as text |
| `pubDate` | `postedAt` | Unix timestamp; convert to ISO 8601 |
| `employmentType` | (not in RawPosting) | One of: Full Time, Part Time, Contractor, Temporary, Intern, Volunteer, Other. Store in tags or custom field. |
| `seniority` | (not in RawPosting) | Array of seniority levels (e.g., ["Senior"]). Store in tags or custom field. |
| `categories`, `parentCategories` | `tags` | Array of job categories; use as tags. |
| `excerpt` | (not in RawPosting) | Short plain-text summary; useful for preview but not mapped to RawPosting |

**Location restrictions:** `locationRestrictions` is an array of country names or codes. Empty array = worldwide. Must be parsed carefully.

**Salary notes:** Min/max salary is structured as integers, currency is provided separately. `salaryPeriod` is always "annual" in the sample. Note: Example shows INR 900k–2M for India role, USD for others.

### Risks / ToS

- **Attribution required:** "Please link back to the URL found on Himalayas AND mention Himalayas as the original source. Please do not submit Himalayas jobs to third-party websites, including but not limited to Jooble, Neuvoo, Google Jobs, or LinkedIn Jobs." https://himalayas.app/api
- **Data freshness:** Data updated every 24 hours. https://github.com/Himalayas-App/remote-jobs-api
- **Rate limits:** Not explicitly stated in API docs. Respectful polling recommended (at least 1 hour between full syncs).
- **No official rate limit published**, but the API is free and public. Conservative estimate: 1 request per minute minimum (typical polite rate).
- **OpenAPI spec available:** https://himalayas.app/docs/openapi.json
- **MCP server available:** Himalayas offers an MCP server for AI agents (https://himalayas.app/mcp) with real-time job search and other tools.
- **RSS feed available:** 100 most recent jobs in XML/Atom format. Updated every 24 hours. No pagination. https://himalayas.app/docs/remote-jobs-rss

**Recommended `minIntervalMinutes`:** 60 (1 hour). Conservative; data is updated daily, so polling once per hour is respectful and captures all changes.

### Sources

- Official Himalayas API documentation: https://himalayas.app/jobs/api (checked 2026-10-06)
- API reference: https://himalayas.app/docs/remote-jobs-api (checked 2026-10-06)
- GitHub OpenAPI spec: https://github.com/Himalayas-App/remote-jobs-api (checked 2026-10-06)
- Live API response: `curl -s "https://himalayas.app/jobs/api?limit=2"` (checked 2026-10-06, HTTP 200)

**Confidence:** high. Official documentation is comprehensive, OpenAPI spec is published, and live testing confirms endpoint behavior.

---

## We Work Remotely

### Answer

We Work Remotely offers RSS feeds for remote job categories. No JSON API. Public RSS feed at `https://weworkremotely.com/remote-jobs.rss` returns all jobs; category-specific feeds are also available (e.g., front-end, full-stack, backend, etc.). RSS format is Atom/RSS 2.0 with custom extensions (media namespace for images). No pagination in RSS; feed returns most recent jobs. Attribution and link-back required.

### Details

**Endpoints (RSS feeds only):**
- All jobs: `https://weworkremotely.com/remote-jobs.rss`
- **Software/frontend-focused feeds:**
  - Front-End Programming: `https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss`
  - Back-End Programming: `https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss`
  - Full-Stack Programming: `https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss`
  - All Programming: `https://weworkremotely.com/categories/remote-programming-jobs.rss`
  - DevOps and System Admin: `https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss`
  - Design: `https://weworkremotely.com/categories/remote-design-jobs.rss`
- Other categories:
  - Customer Support: `https://weworkremotely.com/categories/remote-customer-support-jobs.rss`
  - Product Jobs: `https://weworkremotely.com/categories/remote-product-jobs.rss`
  - Sales and Marketing: `https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss`
  - Management and Finance: `https://weworkremotely.com/categories/remote-management-and-finance-jobs.rss`
  - All Other: `https://weworkremotely.com/categories/all-other-remote-jobs.rss`

**No query parameters:** RSS feeds are static feeds; no filtering, search, or pagination parameters.

**Response format:** RSS 2.0 with custom namespaces (dc, media):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss">
  <channel>
    <title>We Work Remotely: Remote jobs in design, programming, marketing and more</title>
    <link>https://weworkremotely.com/remote-jobs.rss</link>
    <description>We Work Remotely: Remote jobs in design, programming, marketing and more</description>
    <language>en-US</language>
    <ttl>60</ttl>
    <item>
      <media:content url="https://wwr-pro.s3.amazonaws.com/logos/0086/7982/logo.gif" type="image/png"/>
      <title>Lemon.io: Senior Angular Full-stack Developer</title>
      <region>Anywhere in the World</region>
      <country>🇦🇩 Andorra, 🇦🇱 Albania, ... (many country emojis)</country>
      <state>Delaware</state>
      <skills>AngularJS, AWS, Azure, Node.js, PHP, Engineer, Developer, Full Stack Dev, Full Time, English, Laravel, GCP, and TypeScript</skills>
      <category>Full-Stack Programming</category>
      <type>Full-Time</type>
      <description>&lt;img src="..."&gt; ... &lt;p&gt;...&lt;/p&gt; ...</description>
      <pubDate>Tue, 06 Oct 2026 13:25:57 +0000</pubDate>
      <expires_at>Thu, 05 Nov 2026 13:25:57 +0000</expires_at>
      <guid>https://weworkremotely.com/remote-jobs/lemon-io-senior-angular-full-stack-developer</guid>
      <link>https://weworkremotely.com/remote-jobs/lemon-io-senior-angular-full-stack-developer</link>
    </item>
    ...
  </channel>
</rss>
```

**Example trimmed item:**
```xml
<item>
  <title>Stripe: Account Executive, Existing Business (Central Eastern Europe)</title>
  <region>Anywhere in the World</region>
  <country></country>
  <state></state>
  <skills></skills>
  <category>Sales and Marketing</category>
  <type>Full-Time</type>
  <description>&lt;h2&gt;&lt;strong&gt;Who we are&lt;/strong&gt;&lt;/h2&gt; ...</description>
  <pubDate>Tue, 06 Oct 2026 07:31:26 +0000</pubDate>
  <expires_at>Thu, 05 Nov 2026 07:31:26 +0000</expires_at>
  <guid>https://weworkremotely.com/remote-jobs/stripe-account-executive-existing-business-central-eastern-europe</guid>
  <link>https://weworkremotely.com/remote-jobs/stripe-account-executive-existing-business-central-eastern-europe</link>
</item>
```

**Field mapping to RawPosting:**

| We Work Remotely (RSS) field | RawPosting field | Notes |
|---|---|---|
| `guid` | `externalId` | URL-based GUID; stable ID |
| `link` | `url` | Public job posting URL on weworkremotely.com |
| `link` | `applyUrl` | Same as `url`; redirect to weworkremotely.com job page |
| `title` | `title` | Job title (often prefixed with company name) |
| (extract from title or description) | `company` | Company name often embedded in title; may need parsing |
| (not provided) | `companyDomain` | Not provided |
| `description` | `descriptionHtml` | HTML description; often contains company logo, HQ, URL, and full job details |
| (not provided) | `descriptionText` | Extract from HTML |
| `country`, `region` | `locationText` | Country field contains emoji + country names (e.g., "🇺🇸 United States of America, 🇬🇧 United Kingdom..."). Parse to extract location restrictions. |
| `region` | (not in RawPosting) | E.g., "Anywhere in the World" or specific region. Useful indicator of remote-friendliness. |
| (not provided) | `remote` | Infer from region field or description |
| (not provided) | `salaryText` | Not in RSS; extract from description if present |
| (not provided) | `salary` (structured) | Not provided in RSS |
| `pubDate` | `postedAt` | RFC 2822 format; convert to ISO 8601 |
| `category` | `tags` | RSS category tag (e.g., "Full-Stack Programming", "Sales and Marketing"). Use as primary tag. |
| `skills` | `tags` | Comma-separated skills list; parse and add to tags |
| `type` | (not in RawPosting) | Employment type (e.g., "Full-Time", "Contract", "Part-Time"). Store in tags or custom field. |
| `state` | (not in RawPosting) | Company HQ state (often empty); store if needed |
| `media:content` | (not in RawPosting) | Company logo image URL |

**Country parsing note:** The `country` field uses emoji flags and full country names separated by commas. Example: "🇦🇩 Andorra, 🇦🇱 Albania, 🇦🇷 Argentina, ...". Parse carefully to extract country codes or names.

**Expiration:** Each item has `expires_at` field (RFC 2822 format) indicating when the job listing expires. Jobs older than expiration should be considered closed.

### Risks / ToS

- **Attribution required:** "Anyone can use the feed, all we ask is that you attribute the links back to We Work Remotely." https://weworkremotely.com/remote-job-rss-feed
- **No JSON API:** Only RSS feeds are available; no REST JSON API published. https://weworkremotely.com/remote-job-rss-feed
- **Paid API available:** "Looking to post a job via the WWR API? Please reach out to hello@weworkremotely.com if you would like to partner with WWR and post jobs via our API." https://weworkremotely.com/remote-job-rss-feed
- **RSS feed stability:** Feeds are stable and have been available for years; ttl is 60 minutes, so feeds update frequently.
- **No job archival:** Old jobs expire based on `expires_at` field; no way to re-fetch closed postings. Typical expiration is ~30 days from posting.

**Recommended `minIntervalMinutes`:** 60 (1 hour). The RSS feed ttl is 60 minutes; polling hourly aligns with feed freshness.

### Sources

- We Work Remotely RSS feed page: https://weworkremotely.com/remote-job-rss-feed (checked 2026-10-06)
- Live RSS response: `curl -s "https://weworkremotely.com/remote-jobs.rss"` (checked 2026-10-06, HTTP 200)
- Category feed example: https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss (checked 2026-10-06)
- We Work Remotely category list page: https://weworkremotely.com/remote-jobs (checked 2026-10-06)

**Confidence:** high. RSS feeds are stable, well-documented, and live testing confirms availability and format.

---

## Summary Table

| Board | Feed type | Pagination | Search | Auth | Rate limit | Delay | minIntervalMinutes |
|---|---|---|---|---|---|---|---|
| **Remotive** | JSON API | No (all jobs) | By category, company | None | Max 2/min, ≤4/day | 24h | 360 |
| **RemoteOK** | JSON API | Fixed 100 jobs only | None (ignored) | None | Not stated | 24h | 240 |
| **Himalayas** | JSON REST API | Offset/cursor, max 20/req | Yes (rich filters) | None | Not stated (friendly) | 24h | 60 |
| **We Work Remotely** | RSS 2.0 only | No pagination | By category RSS feed | None | Not stated (ttl 60min) | None | 60 |

---

## Evidence of API Calls

All API calls were made on 2026-10-06 at respectful intervals (2+ seconds between hosts) to verify endpoint and response format.

```bash
# Remotive API (HTTP 200)
curl -s "https://remotive.com/api/remote-jobs?limit=2"
# Returns: JSON with 0-legal-notice, job-count, jobs array

# RemoteOK API (HTTP 200)
sleep 2
curl -s "https://remoteok.com/api"
# Returns: JSON array, first element is metadata (last_updated, legal), then 100 job objects

# Himalayas API (HTTP 200)
sleep 2
curl -s "https://himalayas.app/jobs/api?limit=2"
# Returns: JSON object with updatedAt, offset, limit, totalCount, nextCursor, jobs array

# We Work Remotely RSS (HTTP 200)
sleep 2
curl -s "https://weworkremotely.com/remote-jobs.rss"
# Returns: XML RSS 2.0 feed with items in rss/channel/item structure
```

All endpoints are live and accessible. No authentication is required.
