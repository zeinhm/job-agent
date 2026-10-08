# SmartRecruiters, Workable, Recruitee and Arbeitnow public job APIs (t_bb8a60de)

Checked 2026-10-09 with a handful of manual `curl` requests (>= 2 s apart, UA `job-agent-research/0.1`, no login, no key).
Public company examples only: SmartRecruiters `BoschGroup`, Workable `huggingface`, Recruitee `bunq`, Arbeitnow board.

## Answer
- **SmartRecruiters**: keyless `GET https://api.smartrecruiters.com/v1/companies/{id}/postings` (list, no description) + `.../postings/{postingId}` (detail, HTML description). Works without a key in practice, but the official docs only describe API-key/OAuth auth: **not officially documented as public**.
- **Workable**: keyless careers-widget JSON `GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true` returns all published jobs with descriptions in one call. **Undocumented** (official API is token-only).
- **Recruitee**: keyless `GET https://{slug}.recruitee.com/api/offers/` returns all offers with descriptions in one call. Vendor docs list `/offers/` under the "Careers Site API"; auth statement not verified from the official page (see Recruitee section).
- **Arbeitnow**: documented free board API `GET https://www.arbeitnow.com/api/job-board-api?page=N`, 100 jobs/page, newest first.
- Unknown slug: SmartRecruiters returns **200 with empty list** (cannot tell "no jobs" from "no such company"); Workable 404 text `Not Found`; Recruitee 404 JSON `{"error":"Not Found"}`.

## 1. SmartRecruiters

**Endpoints** (all GET, no auth sent)
- List: `https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings?limit=100&offset=0`
  - `limit`: default 100; `limit=500` was silently capped to `"limit":100` in the response (observed). `offset` for paging; stop when `offset + len(content) >= totalFound`.
  - Observed working filter: `country=id` (BoschGroup: totalFound 4884 -> 13). Documented filter `updatedAfter` (ISO 8601) exists on the older feed endpoint (https://developers.smartrecruiters.com/docs/get-job-postings); `q`, `region`, `city`, `department` NOT verified.
- Detail: `https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}` (needed for description, `postingUrl`/`applyUrl`).
- `companyIdentifier` is the path segment in `https://jobs.smartrecruiters.com/{identifier}/...` (case as shown, e.g. `BoschGroup`). `smartrecruiters` and `Visa` returned `totalFound: 0` (no public postings), so they make bad test slugs.

**Official status**: https://developers.smartrecruiters.com/docs/posting-api (checked 2026-10-09) says the Posting API supports API Key and OAuth 2.0 client credentials. The keyless behaviour was observed live but is not documented: treat as tolerated, may be restricted without notice.

**Fields**
| Need | List item | Detail |
|---|---|---|
| id | `id` (string, numeric), `uuid` | same |
| title | `name` | `name` |
| company | `company.name`, `company.identifier` | same |
| location | `location.city/region/country` (lowercase ISO country), `location.fullLocation` | same, plus `address`, `postalCode`, lat/long |
| remote | `location.remote` (bool), `location.hybrid` (bool) | same |
| description | **absent** | `jobAd.sections.{companyDescription,jobDescription,qualifications,additionalInformation}.text` (HTML) |
| salary | not seen in list or in the BoschGroup detail. Docs name a `compensation` object on the feed endpoint; shape on `/v1` UNKNOWN | UNKNOWN (pay text, if any, is inside description HTML) |
| posted date | `releasedDate` (ISO UTC) | same |
| apply URL | absent | `applyUrl`, `postingUrl` (`https://jobs.smartrecruiters.com/{id}/{postingId}-{slug}`) |
Other: `typeOfEmployment.label`, `experienceLevel.label`, `function.label`, `customField[]`, `language.code`. Detail also has `creator.name` (a recruiter's personal name): **do not store it**.

**Rate limits**: none documented on the pages read; no `x-ratelimit` headers returned (Cloudflare front). UNKNOWN. Recommend `minIntervalMinutes: 360` and max 1 request / 2 s; list then fetch detail only for postings that survive the rules filters (detail = 1 request per posting).

**Unknown company**: `GET /v1/companies/nonexistent-zzz-slug/postings?limit=2` -> `200 {"offset":0,"limit":2,"totalFound":0,"content":[]}`. Unknown posting id: `404 {"id":"...","httpCode":404,"code":"RESOURCE_NOT_FOUND","message":"... Resource not found"}`.

**Trimmed real list response** (BoschGroup, `limit=1`, customField trimmed; no personal data):
```json
{"offset":0,"limit":1,"totalFound":4884,"content":[{"id":"744000154502129","name":"Operator 2  - 2nd shift ","uuid":"67a005be-4a51-4136-9400-fd5aeea34a3a","jobAdId":"0fba5c8b-94e2-4985-8627-38cbc55fb54d","defaultJobAd":true,"refNumber":"REF298063T","company":{"identifier":"BoschGroup","name":"Bosch Group"},"releasedDate":"2026-10-08T17:50:26.027Z","location":{"city":"St. Joseph","region":"MI","country":"us","address":"3737 Red Arrow Highway","postalCode":"49085","remote":false,"hybrid":false,"latitude":"42.0493658","longitude":"-86.51233599999999","fullLocation":"St. Joseph, MI, United States"},"industry":{"id":"automotive","label":"Automotive"},"department":{},"function":{"id":"manufacturing","label":"Manufacturing"},"typeOfEmployment":{"id":"permanent","label":"Full-time"},"experienceLevel":{"id":"entry_level","label":"Entry Level"},"customField":[{"fieldId":"COUNTRY","fieldLabel":"Country/Region","valueId":"us","valueLabel":"United States"}]}]}
```
**Trimmed detail** (same posting; `jobAd` HTML cut, `creator` removed):
```json
{"id":"744000154502129","name":"Operator 2  - 2nd shift ","company":{"name":"Bosch Group","identifier":"BoschGroup"},"location":{"city":"St. Joseph","region":"MI","country":"us","remote":false,"hybrid":false,"fullLocation":"St. Joseph, MI, United States"},"releasedDate":"2026-10-08T17:50:26.027Z","postingUrl":"https://jobs.smartrecruiters.com/BoschGroup/744000154502129-operator-2-2nd-shift-","applyUrl":"https://jobs.smartrecruiters.com/BoschGroup/744000154502129-operator-2-2nd-shift-?oga=true","jobAd":{"sections":{"jobDescription":{"title":"Job Description","text":"<p>…</p>"},"qualifications":{"title":"Qualifications","text":"<p>…</p>"},"additionalInformation":{"title":"Additional Information","text":"<p>…</p>"}}},"active":true,"visibility":"PUBLIC","typeOfEmployment":{"id":"permanent","label":"Full-time"},"language":{"code":"en","label":"English"}}
```

## 2. Workable

**Endpoint**: `GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true`
- `{slug}` = path segment of `https://apply.workable.com/{slug}/`. Legacy `https://www.workable.com/api/accounts/{slug}?details=true` 302-redirects here (observed), which confirms the widget path is Workable's own.
- Without `details=true`: same job list, but **no `description`** per job. With it: full HTML description. One request returns all published jobs (no pagination seen; page size/limit for very large accounts UNKNOWN).
- Alternative the careers page itself uses: `POST https://apply.workable.com/api/v3/accounts/{slug}/jobs` with body `{"query":"","location":[],"department":[],"worktype":[],"remote":[]}` (list only, no description, no apply URL; returns `results[]` with `shortcode`, `title`, `remote`, `workplace`, `published`, `location`). Needs a per-job detail call. Not recommended; use the widget.
- **Not documented**: official API (https://workable.readme.io/reference/jobs, checked 2026-10-09) is `https://{subdomain}.workable.com/spi/v3/jobs`, Bearer token required, `limit` default 50 / max 100. The widget endpoint is mentioned only by third parties (https://jobspipe.dev/answers/does-workable-have-an-api, vendor of a competing aggregator, low trust) and the redirect above.
- Test slug caveat: slug `workable` returns 404 on the widget; `huggingface` and `bitpanda` return 200.

**Fields** (per job in `jobs[]`)
| Need | Field |
|---|---|
| id | `shortcode` (e.g. `81B46579FE`) |
| title | `title` |
| company | top-level `name` (account), `description` (company blurb) |
| location | `country`, `city`, `state`, `locations[]` (`country`, `countryCode`, `city`, `region`, `hidden`) |
| remote | `telecommuting` (bool) |
| description | `description` (HTML, only with `details=true`) |
| salary | none seen. UNKNOWN (check for pay text in description) |
| posted | `published_on`, `created_at` (both `YYYY-MM-DD`, date only) |
| apply URL | `application_url`, `url`/`shortlink` (`https://apply.workable.com/j/{shortcode}`) |
Also `employment_type`, `department`, `function`, `industry`, `experience`, `education`.

**Rate limits**: none documented, no ratelimit headers (Cloudflare, `x-cached-response: HIT` seen, so responses are cached). Recommend `minIntervalMinutes: 360`, 1 request / 2 s across accounts.

**Unknown slug**: `404`, `content-type: text/plain`, body `Not Found` (9 bytes).

**Trimmed real response** (`huggingface`, 1 job shown, description cut):
```json
{"name":"Hugging Face","jobs":[{"title":"Open-Source Machine Learning Engineer - EMEA Remote","shortcode":"81B46579FE","code":"","employment_type":"Full-time","telecommuting":true,"department":"Open Source","url":"https://apply.workable.com/j/81B46579FE","shortlink":"https://apply.workable.com/j/81B46579FE","application_url":"https://apply.workable.com/j/81B46579FE/apply","published_on":"2026-05-29","created_at":"2026-05-29","country":"France","city":"Paris","state":"Île-de-France","education":"","experience":"","function":"Engineering","industry":"Computer Software","locations":[{"country":"France","countryCode":"FR","city":"Paris","region":"Île-de-France","hidden":false}],"description":"<p>At Hugging Face, we're on a journey to democratize good AI. …</p>"}]}
```

## 3. Recruitee

**Endpoint**: `GET https://{slug}.recruitee.com/api/offers/` (trailing slash used; `{slug}` = subdomain of the careers site). Works even when the company shows a custom domain (bunq's offers point to `careers.bunq.com`). Returns `{"offers":[...]}` with all published offers incl. HTML description in `translations.{lang}`. No pagination observed (20 offers in one response); behaviour for very large accounts UNKNOWN. Docs say `/offers/` can be filtered by department or tag (parameter names UNKNOWN, not tested).
- Official: https://docs.recruitee.com/reference/careers-site-api lists "Careers Site API" with `GET /offers/` and `POST /offers/:offer_slug/candidates` (page excerpt did not show an auth statement; a third-party summary quotes "does not require authorization and is available under your Careers Site address", https://jobspipe.dev/blog/recruitee-api-jobs). So: documented endpoint, keyless confirmed live.
- Separate token-gated ATS API at `api.recruitee.com/c/{company_id}/...` is out of scope.

**Fields** (per offer)
| Need | Field |
|---|---|
| id | `id` (int), `guid`, `slug` |
| title | `title` (also `translations.en.title`) |
| company | `company_name` |
| location | `city`, `country`, `country_code`, `location` (string), `locations[]` |
| remote | `remote`, `hybrid`, `on_site` (bools) |
| description | `description` + `requirements` (HTML; top-level and under `translations.{lang}`) |
| salary | `salary: {min,max,period,currency}`; null in bunq sample, so often empty |
| posted | `published_at` (`"2026-10-05 16:05:18 UTC"`, not ISO), `created_at`, `close_at` |
| apply URL | `careers_apply_url`, `careers_url` |
Also `employment_type_code`, `experience_code`, `education_code`, `category_code`, `department`, `tags`, `min_hours`/`max_hours`, `status` (filter to published). **`mailbox_email` is present: do not store or fixture it** (replace with `jobs@example.com`).

**Rate limits**: none documented; no ratelimit headers; `cache-control: max-age=0, private`. Recommend `minIntervalMinutes: 360`, 1 request / 2 s.

**Unknown slug**: `404`, `content-type: application/json`, body `{"error":"Not Found"}` (server Cowboy).

**Trimmed real response** (`bunq`, 1 offer, text cut, `mailbox_email` omitted):
```json
{"offers":[{"id":4415333,"guid":"wgtlr","slug":"deputy-aml-manager-belgium","title":"Deputy AML Manager - Belgium","company_name":"bunq","city":"Brussels","country":"Belgium","location":"Brussels, Brussels, Belgium","remote":false,"hybrid":true,"on_site":false,"employment_type_code":"fulltime_permanent","salary":{"max":null,"min":null,"period":null,"currency":null},"published_at":"2026-10-05 16:05:18 UTC","careers_apply_url":"https://careers.bunq.com/o/deputy-aml-manager-belgium/c/new","translations":{"en":{"title":"Deputy AML Manager - Belgium","description":"<p><strong>Ready to Get Shit Done?</strong></p><p>…</p>","requirements":"<p>Do You Have What It Takes?</p><ul>…</ul>"}}}]}
```
(Field values for `id/guid/slug/title/...` were read individually from the same response; key order and the omitted keys are not shown.)

## 4. Arbeitnow (board)

**Endpoint**: `GET https://www.arbeitnow.com/api/job-board-api?page=N` (UK mirror `arbeitnow.co.uk`). Optional documented filter `visa_sponsorship=true|false`. No key. Official post: https://www.arbeitnow.com/blog/job-board-api (checked 2026-10-09; also Postman docs linked there).
- Pagination: `?page=` (1-based). Response has `data[]`, `links{first,last,prev,next}`, `meta{current_page,per_page,from,to,terms,info}`. `per_page` is 100 (page 2 once reported 325, ignore: stop when `data` is empty or `links.next` is null). `page=9999` -> `200` with `"data":[]`, `next:null`.
- `meta.terms` (verbatim): "This is a free public API for jobs, please do not abuse. I would appreciate linking back to the site. By using the API, you agree to the terms of service present on Arbeitnow.com". **Attribution/link back requested; digest should show the Arbeitnow URL.** ToS page itself not read: UNKNOWN.
- `meta.info`: "Jobs are updated every hour and order by the `created_at` timestamp."
- Content is largely German/EU jobs aggregated from ATSs (Greenhouse, SmartRecruiters, Join, Teamtailor, Recruitee, Comeet per the blog); expect many German-language, Germany-located posts and duplicates of other adapters' companies (dedupe by apply URL / company+title).

**Fields** (per `data[]` item)
| Need | Field |
|---|---|
| id | `slug` (unique, ends in numeric id) |
| title | `title` |
| company | `company_name` |
| location | `location` (string, city) |
| remote | `remote` (bool); also `tags` |
| description | `description` (HTML) |
| salary | none. Not in schema |
| posted | `created_at` (Unix epoch seconds) |
| apply URL | `url` (Arbeitnow job page; apply link is on that page) |
Also `tags[]`, `job_types[]`.

**Rate limits**: response headers `x-ratelimit-limit: 50`, `x-ratelimit-remaining: 49` (window not stated; `cache-control: private, max-age=432000`, Cloudflare cached, `last-modified` hourly). Docs silent. Recommend `minIntervalMinutes: 60` at most (data refreshes hourly; 360 is plenty), <= 5 pages per run, 2 s between pages.

**Unknown company/page**: n/a (board). Empty page as above.

**Trimmed real response** (page 1, 1 item, description cut):
```json
{"data":[{"slug":"studentische-hilfskraft-potsdam-377838","company_name":"MCH Ventures","title":"Studentische Hilfskraft","description":"<p>Wir sind eine spezialisierte Beratung … </p>","remote":true,"url":"https://www.arbeitnow.com/jobs/companies/mch-ventures/studentische-hilfskraft-potsdam-377838","tags":["Remote","Business Consulting"],"job_types":["Working student","berufseinstieg"],"location":"Potsdam","created_at":1791477053}],"links":{"first":"https://www.arbeitnow.com/api/job-board-api?page=1","last":null,"prev":null,"next":"https://www.arbeitnow.com/api/job-board-api?page=2"},"meta":{"current_page":1,"per_page":100,"terms":"This is a free public API for jobs, please do not abuse. I would appreciate linking back to the site. …"}}
```
(`links` / `meta` for page 1 reconstructed from the page-2 response shape; first item fields are verbatim.)

## Risks / ToS notes
- SmartRecruiters, Workable widget: keyless access is **undocumented/tolerated**, not a published public API. Keep polling slow, and degrade to "source disabled" on 401/403 rather than retry. ToS pages for SmartRecruiters, Workable, Recruitee were not read: UNKNOWN. Each posting is the employer's public job ad; no logins used.
- SmartRecruiters unknown slug = 200 empty: adapter should treat `totalFound: 0` on a configured company as a warning, not an error.
- SmartRecruiters detail `creator.name` and Recruitee `mailbox_email` are personal/contact data: drop at the Zod layer, never put in fixtures (use `jobs@example.com`).
- Dates differ: SR ISO UTC, Workable date-only, Recruitee `"YYYY-MM-DD HH:MM:SS UTC"`, Arbeitnow epoch seconds. Normalise per adapter.
- Salary: only Recruitee has a structured (often null) salary; none of the others. Pay data must come from description text (LLM extraction).

## Sources (all checked 2026-10-09)
- https://developers.smartrecruiters.com/docs/posting-api , https://developers.smartrecruiters.com/docs/get-job-postings
- Live: `api.smartrecruiters.com/v1/companies/BoschGroup/postings[?limit=..&country=id]`, `.../postings/744000154502129`, `.../nonexistent-zzz-slug/postings`
- https://workable.readme.io/reference/jobs ; https://jobspipe.dev/answers/does-workable-have-an-api (third party)
- Live: `apply.workable.com/api/v1/widget/accounts/{huggingface,bitpanda,zzznonexistent123}`, `apply.workable.com/api/v3/accounts/huggingface/jobs`, `www.workable.com/api/accounts/workable?details=true` (302)
- https://docs.recruitee.com/reference/careers-site-api ; https://jobspipe.dev/blog/recruitee-api-jobs (third party)
- Live: `bunq.recruitee.com/api/offers/`, `zzznonexistent123.recruitee.com/api/offers/`
- https://www.arbeitnow.com/blog/job-board-api ; live `www.arbeitnow.com/api/job-board-api[?page=2|9999]`

## Confidence
Medium-high for endpoints, fields, errors (all observed live today). Medium for "stays keyless" (SmartRecruiters, Workable, undocumented). Low on rate limits (none published; recommendations are conservative guesses).
Would raise confidence: reading the three vendors' ToS; SmartRecruiters `/v1` `compensation` shape on a posting that has pay; Workable/Recruitee behaviour on accounts with >100 jobs (pagination); a longer observation of Arbeitnow's 50-request limit window.
