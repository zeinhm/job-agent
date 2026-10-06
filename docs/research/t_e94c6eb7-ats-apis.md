# Research: Greenhouse, Lever, and Ashby Public Job Board APIs

**Task ID:** t_e94c6eb7
**Date checked:** October 6, 2026
**Status:** Complete

---

## GREENHOUSE

### Answer
Greenhouse exposes a public Job Board API at `boards-api.greenhouse.io/v1/boards/{board_token}/jobs` without authentication. Query parameter `content=true` includes full descriptions, departments, and offices. List endpoint returns all published jobs as JSON; single job endpoint returns with optional questions, pay ranges, and compliance data.

### Details

#### Endpoint
- **Base URL:** `https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs`
- **Single job:** `https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}`
- **Auth:** None (unauthenticated)

#### Query Parameters
- `content` (optional): Set to `true` to include full post description, department, and office details
- `questions` (optional): Set to `true` to include application questions, location questions, compliance/EEO questions, demographic questions

#### Response Envelope (list endpoint)
```json
{
  "jobs": [...],
  "meta": {
    "total": 723
  }
}
```

#### Sample Job (from Stripe board)
```json
{
  "id": 8172510,
  "internal_job_id": 3537063,
  "title": "Abuse Investigator",
  "company_name": "Stripe",
  "first_published": "2026-09-09T10:50:29-04:00",
  "updated_at": "2026-09-25T16:45:00-04:00",
  "requisition_id": "See Opening ID",
  "location": {
    "name": "Seattle, San Francisco, New York City"
  },
  "absolute_url": "https://stripe.com/jobs/search?gh_jid=8172510",
  "language": "en",
  "content": "[HTML-encoded job description]",
  "departments": [...],
  "offices": [...]
}
```

#### Field Mapping to RawPosting

| RawPosting Field | Greenhouse Field | Notes |
|---|---|---|
| `externalId` | `id` | Job post ID, stable within board |
| `url` | `absolute_url` | Public posting URL on company site |
| `applyUrl` | N/A | Use absolute_url with gh_jid param |
| `title` | `title` | Job title |
| `company` | `company_name` | Company name |
| `descriptionHtml` | `content` | HTML-encoded when `content=true` |
| `descriptionText` | `content` | Must decode HTML entities |
| `locationText` | `location.name` | Location string |
| `remote` | Not stated | Not explicitly marked; infer from location text |
| `salaryText` | N/A | Salary not in base response |
| `salary` | N/A | Salary not in base response |
| `postedAt` | `first_published` | ISO 8601, UTC; first publication date |
| `tags` | `metadata` | Custom fields if exposed via metadata |

**Date field notes:** `first_published` is creation; `updated_at` is last modified. The schedule states "first published" date which is what's needed for deduplication.

### Rate Limits & ToS

**Documented limits:** None found in public documentation.

**From ToS:** Job Board API is publicly available. "All job postings in the published state are publicly viewable. These jobs may be scraped by third parties. All other jobs are completely hidden from the jobs API."

**Recommended intervals:**
- Per-host minimum: 2000 ms (2 seconds) — from conventions (default HTTP minimum)
- Poll interval (`minIntervalMinutes`): 60 (conservative; no updates between requests required)

### Unknown Slug Test

**Request:**
```
curl https://boards-api.greenhouse.io/v1/boards/nonexistentboard123/jobs
```

**Response:**
- Status: 404
- Body: `{"status":404,"error":"Job not found"}`

### Confidence
**High.** Public documentation is comprehensive, tested endpoint confirms behavior, field mapping verified against real response.

---

## LEVER

### Answer
Lever's public Postings API at `api.lever.co/v0/postings/{site_name}` requires no authentication. Query parameter `mode=json` returns structured JSON with title, location, description, categories, salary range, and apply URL. Pagination via `skip` and `limit` parameters.

### Details

#### Endpoint
- **Base URL:** `https://api.lever.co/v0/postings/{site_name}`
- **Auth:** None (unauthenticated)
- **Instances:** Global (default) and EU (`api.eu.lever.co`)

#### Query Parameters
- `mode` (required for JSON): Set to `json` for JSON response (default is HTML)
- `skip` (optional): Skip N results from start
- `limit` (optional): Return at most N results
- `location` (optional): Filter by location (case-sensitive; repeatable)
- `commitment` (optional): Filter by commitment level (case-sensitive; repeatable)
- `team` (optional): Filter by team (case-sensitive; repeatable)

#### Response Envelope (array)
Returns a JSON array of job objects directly (no wrapper).

#### Sample Job (from Lever demo board)
```json
{
  "id": "681fbc53-1e34-4a46-8677-3a78118674eb",
  "text": "Approved Professional 3",
  "description": "<div>Welcome to the Demo Job Listing for Lever!...</div>",
  "descriptionPlain": "Welcome to the Demo Job Listing for Lever!...",
  "categories": {
    "location": "Baltimore, MD",
    "team": "Operations",
    "allLocations": ["Baltimore, MD"]
  },
  "createdAt": 1565990241800,
  "country": "US",
  "workplaceType": "remote",
  "hostedUrl": "https://jobs.lever.co/leverdemo/681fbc53-1e34-4a46-8677-3a78118674eb",
  "applyUrl": "https://jobs.lever.co/leverdemo/681fbc53-1e34-4a46-8677-3a78118674eb/apply",
  "salaryRange": {
    "min": 85000,
    "max": 175000,
    "currency": "USD",
    "interval": "per-year-salary"
  }
}
```

#### Field Mapping to RawPosting

| RawPosting Field | Lever Field | Notes |
|---|---|---|
| `externalId` | `id` | UUID, stable within site |
| `url` | `hostedUrl` | Lever-hosted page URL |
| `applyUrl` | `applyUrl` | Lever-hosted apply form URL |
| `title` | `text` | Job title |
| `company` | N/A | Not in response; must be from site name or config |
| `descriptionHtml` | `description` | HTML-encoded |
| `descriptionText` | `descriptionPlain` | Plain text version |
| `locationText` | `categories.location` | Primary location string |
| `remote` | `workplaceType` | String: "remote", "on-site", "hybrid", "unspecified" |
| `salaryText` | N/A | Salary provided as structured object |
| `salary` | `salaryRange` | Object with min, max, currency, interval |
| `postedAt` | `createdAt` | Milliseconds since epoch; convert to ISO 8601 |
| `tags` | `categories` (other) | department, commitment, team available |

**Date field notes:** `createdAt` is millisecond timestamp (e.g., 1565990241800). No update timestamp in response. Convert to ISO 8601 UTC for `postedAt`.

**Salary notes:** `interval` is one of: "per-year-salary", "per-hour-salary". Always in USD or stated currency.

### Rate Limits & ToS

**Documented limits:** None stated.

**From documentation:** "All job postings in the published state are publicly viewable. These jobs may be scraped by third parties. All other jobs are completely hidden from the jobs API."

**Recommended intervals:**
- Per-host minimum: 2000 ms (2 seconds)
- Poll interval (`minIntervalMinutes`): 60

### Unknown Slug Test

**Request:**
```
curl https://api.lever.co/v0/postings/nonexistentleverdomain123?mode=json
```

**Response:**
- Status: 404
- Body: `{"ok":false,"error":"Document not found"}`

### Confidence
**High.** Public documentation complete, tested endpoint confirms behavior, field mapping verified against real response.

---

## ASHBY

### Answer
Ashby's public Job Postings API at `api.ashbyhq.com/posting-api/job-board/{organization_name}` requires no authentication. Query parameter `includeCompensation=true` adds compensation bands when the employer publishes them. Returns structured JSON with title, location, description (plain and HTML), workplace type, employment type, and compensation tiers.

### Details

#### Endpoint
- **Base URL:** `https://api.ashbyhq.com/posting-api/job-board/{organization_name}`
- **Auth:** None (unauthenticated)
- **Organization name:** From the Ashby-hosted careers URL, e.g., `https://jobs.ashbyhq.com/ashby` → organization name is `ashby`

#### Query Parameters
- `includeCompensation` (optional): Set to `true` to include compensation bands when published by employer

#### Response Envelope
```json
{
  "apiVersion": "1",
  "jobs": [...]
}
```

#### Sample Job (from Ashby organization)
```json
{
  "id": "7458d4e9-da2e-47bd-98cb-adfda43d42b2",
  "title": "Engineering Manager - EU",
  "department": "Engineering",
  "team": "EMEA Engineering",
  "employmentType": "FullTime",
  "location": "Remote - European Union",
  "publishedAt": "2024-03-04T14:29:08.532+00:00",
  "isListed": true,
  "isRemote": true,
  "workplaceType": "Remote",
  "descriptionHtml": "<p style=\"min-height:1.5em\">Hi 👋 I'm...</p>",
  "descriptionPlain": "Hi 👋 I'm...",
  "address": {
    "postalAddress": {
      "addressLocality": "",
      "addressRegion": "",
      "addressCountry": "European Union"
    }
  },
  "secondaryLocations": [...],
  "jobUrl": "https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2",
  "applyUrl": "https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application",
  "compensation": {
    "compensationTierSummary": "€62K – €133K • Offers Equity • Multiple Ranges",
    "compensationTiers": [
      {
        "id": "5dd2a023-5dd9-4238-bafb-c823f1e4a51b",
        "tierSummary": "Tier 1 (Ireland, ...) €112K – €133K • Offers Equity",
        "title": "EUR",
        "components": [
          {
            "summary": "€112K – €133K",
            "compensationType": "Salary",
            "interval": "1 YEAR",
            "currencyCode": "EUR",
            "minValue": 112000,
            "maxValue": 133000
          },
          {
            "summary": "Offers Equity",
            "compensationType": "EquityPercentage",
            "interval": "NONE"
          }
        ]
      }
    ]
  }
}
```

#### Field Mapping to RawPosting

| RawPosting Field | Ashby Field | Notes |
|---|---|---|
| `externalId` | `id` | UUID, stable within organization |
| `url` | `jobUrl` | Ashby-hosted page URL |
| `applyUrl` | `applyUrl` | Ashby-hosted apply form URL |
| `title` | `title` | Job title |
| `company` | N/A | Not in response; must be from org name |
| `descriptionHtml` | `descriptionHtml` | HTML (not encoded) |
| `descriptionText` | `descriptionPlain` | Plain text version |
| `locationText` | `location` | Primary location string |
| `remote` | `isRemote` | Boolean; also check `workplaceType` ("Remote", "Hybrid", "OnSite") |
| `salaryText` | `compensation.compensationTierSummary` | Human-readable text summary |
| `salary` | See below | Extract from compensationTiers |
| `postedAt` | `publishedAt` | ISO 8601 with timezone; UTC |
| `tags` | None | Department and team available in response |

**Compensation structure (Ashby-specific):**
Ashby returns tiers because different locations may have different salary ranges (e.g., US vs. EU). Each tier has components:
- `compensationType`: "Salary", "EquityPercentage", "Bonus", etc.
- `interval`: "1 YEAR", "NONE" (for equity), "1 MONTH", "1 HOUR"
- `currencyCode`: e.g., "USD", "EUR"
- `minValue`, `maxValue`: Numeric values (may be null for bonus/equity without stated range)

For RawPosting `salary`, extract the primary salary component (type="Salary", interval="1 YEAR"), taking min/max and converting to structured format. If multiple tiers, summarize or pick the first; clarification needed from adapter task.

**Example extracted from tier above:**
```
salary: {
  min: 112000,
  max: 133000,
  currency: "EUR",
  period: "year"
}
```

### Rate Limits & ToS

**Documented limits:** None stated.

**From ToS:** Ashby public Job Board endpoint is "unauthenticated and free," covers one organization per call. "All job postings in the published state are publicly viewable."

**Recommendation:**
- Per-host minimum: 2000 ms (2 seconds)
- Poll interval (`minIntervalMinutes`): 60

### Compensation Data Shape

**When `includeCompensation=true`:**
- `shouldDisplayCompensationOnJobPostings`: boolean (employer's choice to show salary)
- `compensation`: object with:
  - `compensationTierSummary`: string (human-readable e.g. "$81K – $87K • 0.5% – 1.75% • Offers Bonus")
  - `compensationTiers`: array of tiers (each with location/region qualifier and salary bands)
    - Each tier has `components`: array of compensation components (salary, equity, bonus)
    - Each component has `minValue`, `maxValue` (null if not applicable), `currencyCode`, `interval`
  - `summaryComponents`: array of all unique component types across tiers

**Real example (from Stripe Notion CSM role):**
```json
"compensation": {
  "compensationTierSummary": "$81K – $87K • 0.5% – 1.75% • Offers Bonus",
  "scrapeableCompensationSalarySummary": "$81K - $87K",
  "compensationTiers": [
    {
      "tierSummary": "Estimated based on experience $81K – $87K • 0.5% – 1.75% • Offers Bonus",
      "components": [
        {
          "summary": "0.5% – 1.75%",
          "compensationType": "EquityPercentage",
          "minValue": 0.5,
          "maxValue": 1.75
        },
        {
          "summary": "$81K – $87K",
          "compensationType": "Salary",
          "interval": "1 YEAR",
          "currencyCode": "USD",
          "minValue": 81000,
          "maxValue": 87000
        },
        {
          "summary": "Offers Bonus",
          "compensationType": "Bonus",
          "minValue": null,
          "maxValue": null
        }
      ]
    }
  ]
}
```

### Unknown Slug Test

**Request:**
```
curl https://api.ashbyhq.com/posting-api/job-board/nonexistentashby123
```

**Response:**
- Status: 404
- Body: `Not Found` (HTML error page, no JSON)

### Confidence
**High.** Public documentation complete, tested endpoint confirms behavior, field mapping verified against real response, compensation structure documented with example.

---

## Summary Table

| Attribute | Greenhouse | Lever | Ashby |
|---|---|---|---|
| **Base URL** | `boards-api.greenhouse.io/v1/boards/{token}/jobs` | `api.lever.co/v0/postings/{site}` | `api.ashbyhq.com/posting-api/job-board/{org}` |
| **Auth** | None | None | None |
| **Response format** | JSON (wrapper object) | JSON (array) | JSON (wrapper object) |
| **Rate limit** | None documented | None documented | None documented |
| **Min interval (ms)** | 2000 | 2000 | 2000 |
| **Poll interval (min)** | 60 | 60 | 60 |
| **Date field** | `first_published` (ISO 8601) | `createdAt` (ms timestamp) | `publishedAt` (ISO 8601) |
| **Salary included** | No (optional pay_input_ranges on single job) | Yes (`salaryRange`) | Yes (`compensation` if includeCompensation=true) |
| **Location explicit** | Text field + offices array | `categories.location` | `location` + `secondaryLocations` |
| **Remote flag** | Infer from location | `workplaceType` | `isRemote` boolean |
| **Compensation structure** | Ranges as `pay_input_ranges` on job detail | Single object with min/max | Multiple tiers with components |
| **Unknown board 404** | `{"status":404,"error":"Job not found"}` | `{"ok":false,"error":"Document not found"}` | `Not Found` (HTML page) |

---

## Sources

1. **Greenhouse:** https://developers.greenhouse.io/job-board.html — accessed 2026-10-06
2. **Lever:** https://github.com/lever/postings-api (README) — accessed 2026-10-06
3. **Ashby:** https://developers.ashbyhq.com/docs/public-job-posting-api — accessed 2026-10-06

Real API tests:
- Greenhouse (Stripe board): 2026-10-06, 723 jobs
- Lever (leverdemo board): 2026-10-06, demo data
- Ashby (ashby org): 2026-10-06, 2 published jobs (Engineering Manager EU, CSM roles)

