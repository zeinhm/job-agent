# JobStreet public search (logged out): endpoint, fields, rate, terms

Task t_0c868bbb. Checked 2026-10-14.

## Answer

JobStreet Indonesia cannot be read politely and legitimately by a logged-out scraper. (1) A plain request to the search page got a Cloudflare managed challenge (403, `cf-mitigated: challenge`), which we must not bypass. (2) `robots.txt` disallows `/api/jobsearch/`, `*/job/`, `/graphql` and any URL with a query string except `?keywords` / `?advertiserid`. (3) The Terms of Use (effective 20 July 2026) forbid bots, scrapers and data mining without prior written consent, and there is no official job-search API. Recommendation: do not build a JobStreet scraper adapter; cover Indonesia-based foreign-company listings through JobSpy's Indeed Indonesia search (already in PLAN) and keep JobStreet as manual / semi-automated apply only. Since this is a terms question, it is the owner's decision (see "Decision needed").

## 1. Endpoint, parameters, cookies, robots

### What we observed first-hand (2 requests, 4+ s apart, plain curl, no cookies, no login)

```
GET https://id.jobstreet.com/robots.txt  -> 200
GET https://id.jobstreet.com/remote-software-engineer-jobs?daterange=1&sortmode=ListedDate
  -> HTTP/2 403, server: cloudflare, cf-mitigated: challenge
  -> <title>Just a moment...</title>, window._cf_chl_opt = {... cType: 'managed' ...}
```
The same 403 challenge came back on the second attempt. I stopped there: passing a managed challenge needs a real browser or a bypass, and AGENTS.md forbids bypassing bot checks. The search URL path form (`/<keywords>-jobs`, `?daterange=`, `?sortmode=`) was only my guess from public knowledge of the site, not confirmed by a response.

### robots.txt (fetched 2026-10-14, https://id.jobstreet.com/robots.txt)

```
User-agent: *
Disallow: */job/
Disallow: *?
Disallow: /graphql
Disallow: /api/jobsearch/
Disallow: */profile/me/
Disallow: */profiles/search*
Allow: *?advertiserid
Allow: *?keywords
```
Named AI crawlers (anthropic-ai, GPTBot, CCBot, ...) additionally get `Disallow: /companies` and `Disallow: */job/`. Reading: individual job pages and the JSON search API path are disallowed for generic bots; any filtered search URL (e.g. `?daterange=1`) is disallowed as well, only `?keywords=` / `?advertiserid=` URLs are allowed.

### Underlying API (not first-hand)

Third-party scraper vendors say the site uses an undocumented SEEK "v5 search API" with a market key (`siteKey`, e.g. `MY-Main`; Indonesia is probably `ID-Main`, unconfirmed). I could not verify the path, parameters or whether it works without cookies/tokens: the only host-side evidence I have is that the website itself is behind a Cloudflare challenge and that `/api/jobsearch/` is disallowed in robots.txt. UNKNOWN: exact parameter names for keywords, location, work type, date range, page, page size, sort. Tried: robots.txt, search page (blocked), vendor docs (below), official docs search (none exist).

Sources:
- https://id.jobstreet.com/robots.txt (2026-10-14)
- https://apify.com/bovi/jobstreet-jobs-scraper : "public v5 search API", `siteKey` such as `MY-Main` (2026-10-14)
- https://jobspipe.dev/blog/jobstreet-api : SEEK's official API "does not offer programmatic job search"; wrappers use internal endpoints that "carry no compatibility promise" (2026-10-14)

## 2. Fields per job (second-hand, from vendor output schemas; medium-low confidence)

No raw response could be obtained, so no sample response is included (nothing to trim, and I will not invent one). Vendor output schemas suggest these fields exist:

| Need | Vendor field names |
|---|---|
| job id | `job_id` / listing id |
| title | `title` |
| advertiser / company | `company`, `advertiserId` |
| location | `location`, `area`, `country_code` |
| work arrangement | `remote_type` or `workArrangement` (On-site / Hybrid / Remote) |
| salary | `salaryText`, parsed `salaryMin`, `salaryMax`, `salaryCurrency`, `salaryType` |
| listing date | `postedDate` (ISO) plus display text such as "1d ago" |
| URL | `url` |
| flags | `isSponsored`, `isFeatured` |
| description | list gives `teaser` / `bullet_points`; full `description_html` / `description_text` needs one extra request per job to the job page |

Vendor claims: up to 100 jobs per page; the corvuslab actor says throughput is capped at roughly 400 requests/minute (vendor claim). The job page (`*/job/`) is disallowed by robots.txt.
Sources: https://apify.com/bovi/jobstreet-jobs-scraper , https://apify.com/corvuslab/jobstreet-scraper (both 2026-10-14).

## 3. Foreign-company signals

UNKNOWN as to the raw response (see 2). Candidate signals if data were available: salary currency (`salaryCurrency` not IDR; maps to `salaryCurrency` input of `classifyIndonesia`, `packages/pipeline/src/filters/indonesia.ts`), company country (no advertiser country field seen in vendor schemas; `companyHqCountry` would have to come from elsewhere), remote / "overseas company" wording in the teaser (`descriptionText` input), recruitment-agency flag (not seen in vendor schemas). Nothing here is verified.

## 4. Applying

Not verified (job pages are blocked for us). PLAN section 6 already assumes JobStreet applications need the owner's own login and are semi-automated at most; nothing found contradicts that. Out of scope here (logged-in pages).

## 5. Block signals, request budget, change rate

- Observed: HTTP 403 with `cf-mitigated: challenge`, HTML title "Just a moment..." (Cloudflare managed challenge, needs JS execution). An adapter must treat that as "blocked", stop the source for the run and never retry in a loop (matches `docs/phase-3-conventions.md` block rule).
- Safe budget: none can be justified by evidence, because we got blocked on the first page. If the owner approves anything, keep to phase-3 limits (1 request / 3 s, 1-2 pages per run) but expect blocks.
- Change rate: UNKNOWN; JobStreet is a high-volume board, so "last 24 hours" listings change continuously, hourly polling would be enough.

## 6. Terms of use, plain words

SEEK Limited's website terms cover SEEK, JobStreet by SEEK and JobsDB by SEEK; Indonesian version "Berlaku efektif 20 Juli 2026", English (sg) "Last updated on 20 July 2026". In plain words:
- The sites are "designed for individual human use". Using any automated process, script, bot or scraper to access, query, copy, collect or mine information, or to send large numbers of requests, is not allowed unless SEEK provides a specific technical interface (an API) and you follow its terms (clause 9(b)).
- Data mining, robots, screen scraping or similar automated gathering needs SEEK's prior written consent (clause 7(d)).
- Aggregating or copying content is also prohibited (clauses 5(c), 7(b), 8(d)).
- SEEK may use rate limiting, traffic shaping and device fingerprinting to detect scraping; circumventing them is prohibited and can lead to suspension (clause 9(d)).
- No public job-search API exists; SEEK's official API is for hirers (post ads, retrieve applications) and needs an integration request.

So a JobStreet scraper would breach the terms, and unlike LinkedIn/Indeed (accessed only through JobSpy) the robots.txt and Cloudflare block it as well. The guardrails say scrape only sources listed in PLAN.md, logged out, politely; JobStreet is listed but its terms and bot protection conflict with "politely".

Sources (2026-10-14): https://id.jobstreet.com/id/terms , https://sg.jobstreet.com/terms , https://jobspipe.dev/blog/jobstreet-api

## Decision needed

OWNER (terms / legal): drop the JobStreet scraper adapter and update PLAN 2 Tier 2 accordingly (rely on Indeed Indonesia via JobSpy; JobStreet only as a manual search link or a semi-automated apply target)? Or ask SEEK for written consent / an API (outside our control).

## Confidence

High: robots.txt content, Cloudflare 403 on the search page, terms clauses (read from the live pages). Low: endpoint, parameters and fields (vendor docs only). What would raise it: a real browser session by the owner capturing the network request of a normal search (human-driven, not automated), or written confirmation from SEEK.
