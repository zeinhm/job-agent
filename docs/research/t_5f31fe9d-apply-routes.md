# Free apply routes: ATS lookup, careers-page embeds, aggregator links, paid-only sites (t_5f31fe9d)

Checked 2026-10-14. Manual requests only: UA `job-agent-research/0.1`, no login, no sign-up, no CAPTCHA bypass, public companies only
(Stripe, Spotify, Ramp, Hugging Face, Bosch, bunq, Personio as examples), at most a few requests per host. Binding design:
`docs/phase-3-conventions.md` section 2.

## Answer
- **Board lookup works without a key for all six ATSs.** Existence is a plain GET: 200 for a real slug and 404 for an unknown one on Greenhouse, Lever, Ashby, Workable and Recruitee. SmartRecruiters is the exception and answers **200 with an empty list** for unknown slugs.
- **Name check:** Greenhouse (`/v1/boards/{slug}` -> `name`), Workable (`name`), Recruitee (`company_name`) and SmartRecruiters (`company.name`) expose the company name. **Lever and Ashby expose none** in the board JSON, so the dev must match the posting title as well as the name.
- **Careers-page embed detection is solid for Greenhouse and Ashby** (confirmed live / vendor doc). Lever, Workable, Recruitee and SmartRecruiters embed snippets could not be read (vendor docs hide them behind the admin UI), so only their hosted-page link patterns are given, marked medium confidence.
- **Aggregator links:** only web3.career, Arbeitnow and JobSpy's `job_url_direct` can carry an employer URL. Himalayas' Apply button leads to a Himalayas sign-up page. RemoteOK's button is a redirect `/l/<id>`, but the description usually says "Apply at <url>". WWR/Remotive pages could not be read (Cloudflare / 403).
- **Paid-only:** FlexJobs, Remote.co, TheLadders, RemoteJobs.io, Virtual Vocations (partly) are paid. WWR has a Pro tier ($14.95/mo); whether the free tier can apply is UNKNOWN.

## 1. Board lookups per ATS

All requests: GET, no auth. "404" row = what an unknown slug (`zzznonexistent123`) returned today.

| ATS | Board URL (list) | Real slug | Unknown slug | Size (real) | Name / company field | Collision check |
|---|---|---|---|---|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` (add `?content=true` only for descriptions) | 200 JSON `{"jobs":[...]}`, `stripe`: 452 KB | **404** `{"status":404,"error":"Job board not found"}` (44 B) | 452 KB (list, no description) | cheap probe `GET /v1/boards/{slug}` -> `{"name":"Stripe","content":""}` (30 B, 200) | compare `name` to the company name |
| Lever | `https://api.lever.co/v0/postings/{slug}?mode=json` (EU tenants: `api.eu.lever.co`) | 200 JSON array, `spotify`: 802 KB; `&limit=1` -> 11.6 KB | **404** `{"ok":false,"error":"Document not found"}` (41 B), EU host same | 802 KB full, ~12 KB with `limit=1` | **none** in response | match posting title + company name in `descriptionPlain`; `hostedUrl` is `jobs.lever.co/{slug}/{id}` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{slug}` | 200 JSON `{"jobs":[...]}`, `ramp`: 2.76 MB | **404** `Not Found` (9 B text/plain) | up to several MB (no size param tested) | **none** at top level (first key `jobs`; each job has `jobUrl`, `applyUrl`) | title match + `jobUrl` host; **do not** use `jobs.ashbyhq.com/{slug}`: unknown slugs return 200 (9 KB SPA shell) |
| SmartRecruiters | `https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=1` | 200, `BoschGroup`: ~1.5 KB at `limit=1`, `totalFound` 4984 | **200** `{"offset":0,"limit":1,"totalFound":0,"content":[]}` (50 B) | ~1.5 KB probe | `content[].company.name` + `company.identifier` | exists only if `totalFound > 0`; compare `company.name`. `id` is case-sensitive as in `jobs.smartrecruiters.com/{id}` |
| Workable | `https://apply.workable.com/api/v1/widget/accounts/{slug}` (add `?details=true` for descriptions) | 200 JSON, `huggingface`: 4.3 KB without details | **404** `Not Found` (9 B text/plain) | 4 KB without details | top-level `name` | compare `name` |
| Recruitee | `https://{slug}.recruitee.com/api/offers/` | 200 JSON, `bunq`: 622 KB | **404** `{"error":"Not Found"}` (21 B) | 622 KB | `offers[].company_name` | compare `company_name` |

Sources: live curl 2026-10-14 for every row. Older detail: `docs/research/t_bb8a60de-ats-board-apis.md`, `t_e94c6eb7-ats-apis.md`.
Greenhouse `?content=true` and Lever `limit` are from the vendors' public job-board docs / tested only for Lever (`limit=1` honoured: 11,638 B).

### Findings that change the dev design
1. **Misses are cheap, hits are heavy.** A 404 costs 9-44 B. A hit on a large company downloads 0.4-2.8 MB. Because we want the board only after the slug is accepted, use the cheap probe first where one exists:
   - Greenhouse: `GET /v1/boards/{slug}` (30 B), compare `name`, then fetch `/jobs` only if accepted.
   - Lever: `?mode=json&limit=1` (~12 KB) as probe.
   - SmartRecruiters: `limit=1` (~1.5 KB) as probe.
   - Workable: the plain call is already small (4 KB).
   - Ashby and Recruitee: no cheap probe found (UNKNOWN whether Ashby/Recruitee accept a size limit; not tested). Accept the full download once per positive hit, then cache the board.
2. **SmartRecruiters is the only ATS where an unknown slug is a 200.** Existence = `totalFound > 0` and name match.
3. **Lever and Ashby carry no company name.** The name check is therefore replaced by: (title match, as step 1 requires anyway) AND (company name appears in the posting description or the board's job URL slug equals one of our candidate slugs).

### Slug candidates from a company name (max 3)
Not vendor-documented; this is a heuristic and should be tested against a golden list.
1. Normalize: NFKD-strip accents, lowercase, `&` -> `and`, drop everything except `[a-z0-9 -]`.
2. Strip legal suffix tokens at the end (repeat): `inc`, `inc.`, `llc`, `ltd`, `limited`, `gmbh`, `ag`, `corp`, `corporation`, `co`, `company`, `plc`, `bv`, `sa`, `pte`, `sdn bhd`, `pty`.
3. Drop a leading `the`.
4. Candidates, in order, deduplicated, length >= 3, first three kept:
   - A: all words joined with no separator (`acme labs` -> `acmelabs`)
   - B: words joined with `-` (`acme-labs`)
   - C: first word only (`acme`), **only when the name has more than one word and the first word is >= 4 chars and not generic** (`global`, `digital`, `group`, `tech`, `labs`, `software`, `systems`, `solutions`, `the`, `new`, `first`).
   - "Typeform" -> `typeform` (one candidate; B and C collapse into A). "Acme Labs, Inc." -> `acmelabs`, `acme-labs`, `acme`.
5. Real-world check of the idea: `Hugging Face` is `huggingface` on Workable (variant A); `Bosch Group` is `BoschGroup` on SmartRecruiters (case-sensitive; keep the original-case join as candidate A for that ATS, or lowercase and accept a miss).
### Collision handling (does this board belong to the company?)
- Accept when normalized board name == normalized company name (after suffix stripping), or one contains the other **and** the posting's company domain (`companies.domain`) equals the host in a job's `absolute_url` / `hostedUrl` / `jobUrl` base, or the title matches.
- Otherwise reject the slug and record the negative result. A short slug such as `acme`, `stripe`, `apple` is the highest collision risk, which is why candidate C is gated above.
- Concrete example of a name that is not the board's own host: Stripe's Greenhouse jobs have `absolute_url` = `https://stripe.com/jobs/search?gh_jid=8172510`, i.e. a **company-domain URL, not a greenhouse host**. The dev must treat `?gh_jid=` on a company domain as an ATS job URL (apply type `ats`, `ats_type=greenhouse`) and keep the board's `absolute_url` as the apply URL.

## 2. Careers-page embeds and links

Scan the fetched `/careers` or `/jobs` HTML (max 2 pages/company) with the regexes below. The group `slug` is what to feed back into section 1.

| ATS | Pattern (what it looks like) | Regex (case-insensitive) | Example / source | Confidence |
|---|---|---|---|---|
| Greenhouse embed script | `<script src="https://boards.greenhouse.io/embed/job_board/js?for=stripe">` plus `<div id="grnhse_app">` | `greenhouse\.io/embed/job_board(?:/js)?\?for=([a-z0-9_-]+)` | live: `https://boards.greenhouse.io/embed/job_board/js?for=stripe` returns the loader (`boardURI: https://job-boards.greenhouse.io/embed/job_board?for=stripe`, `baseURI: https://stripe.com/jobs/search`, iframe id `grnhse_iframe`, param `gh_jid`) | high |
| Greenhouse hosted | `boards.greenhouse.io/{slug}`, `job-boards.greenhouse.io/{slug}`, `boards.eu.greenhouse.io/{slug}`, job `.../{slug}/jobs/{id}` | `(?:job-)?boards(?:\.eu)?\.greenhouse\.io/(?!embed)([a-z0-9_-]+)` | live: `https://job-boards.greenhouse.io/embed/job_board?for=stripe` 200; `job-boards.greenhouse.io/zzznonexistent123` 404 | high |
| Greenhouse job id on company site | query `?gh_jid=<digits>` on the company's own page | `[?&]gh_jid=(\d+)` | Stripe `https://stripe.com/jobs/search?gh_jid=8172510` (live API) | high |
| Lever hosted | `https://jobs.lever.co/{slug}` and `/{slug}/{uuid}`; EU `jobs.eu.lever.co/{slug}` | `jobs(?:\.eu)?\.lever\.co/([a-z0-9_-]+)` | live: Spotify API `hostedUrl` `https://jobs.lever.co/spotify/2193db3f-...`; unknown slug page returns 404 (297 KB!) so use the API, not the page | high (host), embed snippet UNKNOWN: Lever's help article could not be loaded |
| Ashby embed | `<div id="ashby_embed">` + `<script src="https://jobs.ashbyhq.com/{slug}/embed?version=2">`; iframe id `ashby_embed_iframe`; query `ashby_jid=<uuid>` on the company page | `jobs\.ashbyhq\.com/([A-Za-z0-9._-]+)/embed` and `[?&]ashby_jid=([0-9a-f-]{36})` | https://www.ashbyhq.com/job-board-embed-examples/full-job-board (demo slug `ashby-embed-demo-org`); live: `https://jobs.ashbyhq.com/ramp/embed?version=2` 200 (19 KB) | high |
| Ashby hosted | `https://jobs.ashbyhq.com/{slug}` and `/{slug}/{uuid}` | `jobs\.ashbyhq\.com/(?!api)([A-Za-z0-9._-]+)` | same | high |
| SmartRecruiters hosted | `https://jobs.smartrecruiters.com/{Id}/{postingId}-{slug}`, `https://careers.smartrecruiters.com/{Id}` | `(?:jobs|careers)\.smartrecruiters\.com/([A-Za-z0-9_-]+)` | live: Bosch posting `postingUrl` `https://jobs.smartrecruiters.com/BoschGroup/744000154502129-operator-2-2nd-shift-` | high (host), widget snippet UNKNOWN (vendor says generated in admin UI) |
| Workable hosted | `https://apply.workable.com/{slug}/` and `/j/{shortcode}` | `apply\.workable\.com/(?!j/|api/)([a-z0-9_-]+)` | live: Hugging Face `https://apply.workable.com/j/81B46579FE`; widget code only in admin UI (Settings > Integrations > Apps > Company website per https://help.workable.com/hc/en-us/articles/115012801727) | high (host), embed snippet UNKNOWN; styling hook class `whr_embed_hook` from a third-party guide, unverified |
| Recruitee hosted | `https://{slug}.recruitee.com/` and `/o/{offer}`; many use a custom domain (bunq: `careers.bunq.com/o/{slug}/c/new`) | `([a-z0-9-]+)\.recruitee\.com` | live `https://bunq.recruitee.com/api/offers/` 200; offers point to `careers.bunq.com` | high (host); custom-domain careers pages need a `/o/` path hint (`/o/[a-z0-9-]+(/c/new)?`) |
| Teamtailor | `https://{slug}.teamtailor.com/jobs`; custom domains common | `([a-z0-9-]+)\.teamtailor\.com` | live: unknown tenant 404; real embed/tag UNKNOWN | medium (host only) |
| Personio | `https://{slug}.jobs.personio.de/` (also `.com`), feed `/xml?language=en`, job `/job/{id}` | `([a-z0-9-]+)\.jobs\.personio\.(?:de|com)` | https://developer.personio.de/docs/integration-of-open-positions ; live: `personio.jobs.personio.de/xml?language=en` 200 text/xml 8.5 KB, unknown tenant 404 | high |
| BambooHR | `https://{slug}.bamboohr.com/careers` (list JSON `/careers/list`) | `([a-z0-9-]+)\.bamboohr\.com/(?:careers|jobs)` | live: unknown tenant `/careers/list` -> **302** (to the vendor site) so 404-detection must treat a redirect off-tenant as "no board" | medium |
| Breezy | `https://{slug}.breezy.hr/`, `/p/{id}-{title}`, JSON `/json` | `([a-z0-9-]+)\.breezy\.hr` | live: unknown tenant `/json` 404 | medium (host) |
| Pinpoint | `https://{slug}.pinpointhq.com/`, JSON `/postings.json` | `([a-z0-9-]+)\.pinpointhq\.com` | live: unknown tenant 404 | medium (host) |
| Workday | `https://{tenant}.wd{N}.myworkdayjobs.com/{site}` (`wd1`..`wd12`) | `([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)` | not fetched | low (from vendor convention; not verified today) |
| Rippling | `https://ats.rippling.com/{slug}/jobs` | `ats\.rippling\.com/([a-z0-9-]+)` | not fetched; the repo already lists `rippling.com` as a vendor domain | low |

Notes
- "Link but do not poll" ATSs (Teamtailor, Personio, BambooHR, Workday, Breezy, Pinpoint, Rippling): if a posting links to one of these, set `apply_type = ats` with the job URL; no board API call.
- A found job link beats a board link: prefer `…/jobs/{id}`, `/j/{shortcode}`, `?gh_jid=`, `?ashby_jid=` over a board root.
- Embed script tags are only in the raw HTML if the page is server-rendered; a JS-only careers page shows nothing without a headless browser, which is out of scope (no render step). Record `unknown` then.

## 3. What each source's stored link is

Code reading: `packages/sources/src/*/index.ts` (`url`, `applyUrl`). Live: page fetches 2026-10-14.

| Source | Stored `url` / `applyUrl` | Link kind | Needs login / payment to follow? | Where the employer link is |
|---|---|---|---|---|
| Himalayas | `url` = `applicationLink` = `https://himalayas.app/companies/{co}/jobs/{slug}` | aggregator page | The page's "Apply now" goes to `https://himalayas.app/signup/talent?redirect=...`; JSON-LD `"directApply":false`; page says jobs never require payment. **Free sign-up required to apply** (never sign up per our rules) | none on page; only if the description text contains a link |
| RemoteOK | `url`, `applyUrl` = `https://remoteOK.com/remote-jobs/{slug}` | aggregator page | No login to read; "Apply" button = `href="/l/{id}"` (RemoteOK redirect, not followed by us); premium pop-up only promotional | Description text often says "Apply at <company careers URL>" (seen: Leverage Live Local posting, with `utm_source=remoteok` query). Use posting-text step (3) |
| Remotive | `url` only: `https://remotive.com/remote-jobs/{cat}/{slug}-{id}` | aggregator page | page request got a **Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`)** with plain curl; we do not bypass it. Apply behaviour UNKNOWN | UNKNOWN. API terms forbid resubmitting jobs elsewhere (see remote-boards research) |
| WWR | `url` = RSS `<link>` `https://weworkremotely.com/remote-jobs/{slug}` | aggregator page | Page fetch returned HTTP 403 for WebFetch; apply behaviour UNKNOWN. Site has a paid "WWR Pro" tier (section 4) | UNKNOWN; WWR RSS descriptions often include a company URL in the text per the earlier research (`t_92e11b3f`) |
| Arbeitnow | `url` = `https://www.arbeitnow.com/jobs/companies/{co}/{slug}-{id}` | aggregator page with its own apply form | No login or payment seen. The page shows an inline form (name, email, CV upload) handled by **JOIN** (privacy links to `join.com`), plus "Prefer to apply directly? Try the company portal" -> `{job url}/apply` (still an arbeitnow.com path) | the employer ATS is not named on the page; UNKNOWN whether `{job url}/apply` redirects to the employer. Blog says jobs are aggregated from Greenhouse, SmartRecruiters, Join, Teamtailor, Recruitee, Comeet |
| web3.career | `url` = `applyUrl` = API `apply_url` | "direct apply link **or** web3.career form URL" per docs | docs only; not verified live (needs token, none used) | `apply_url` may already be the employer link; otherwise a web3.career URL. UNKNOWN which share |
| HN | `url` = `news.ycombinator.com/item?id=`, `applyUrl` = first non-HN link in first line | comment; link is usually company site or careers page | No login. Mailto/e-mail text is plain, not a link | see section 5 |
| Greenhouse / Lever / Ashby / SmartRecruiters / Workable / Recruitee | `url`, `applyUrl` = ATS job/apply URL | ATS | No login | already `ats`; the resolver skips them |

### JobSpy (LinkedIn, Indeed) and Phase 3 sources
Output columns of `scrape_jobs` (README of the JobSpy repo, https://github.com/speedyapply/JobSpy, checked 2026-10-14):
`id, site, job_url, job_url_direct, title, company, location, date_posted, job_type, salary_source, interval, min_amount, max_amount, currency, is_remote, job_level, job_function, listing_type, emails, description, company_industry, company_url, company_logo, company_url_direct, company_addresses, company_num_employees, company_revenue, company_description, skills, experience_range, company_rating, company_reviews_count, vacancy_count, work_from_home_type`. The README says "a column is empty when the job board doesn't provide it" and does not define the URL columns; meanings below are from the scraper source.

| Site | `job_url` | `job_url_direct` | `company_url` / `company_url_direct` | Evidence |
|---|---|---|---|---|
| Indeed | `https://{domain}.indeed.com/viewjob?jk={key}` (Indeed page) | `job.viewJobUrl` **only when its host is not `*.indeed.com`**, else None | `company_url` = Indeed company page; **`company_url_direct` = `employer.corporateWebsite`** (the employer's own website when set) | https://raw.githubusercontent.com/speedyapply/JobSpy/main/jobspy/indeed/__init__.py (read via fetch, code excerpt) |
| LinkedIn | `https://www.linkedin.com/jobs/view/{id}` always | **not set by the LinkedIn scraper code** (no `externalApply`/`applyUrl` reference); `fetch_description` only adds description, job type/level/function, industry, logo, emails | `company_url` = the LinkedIn company page from the card (query string stripped); `company_url_direct` not set | https://raw.githubusercontent.com/speedyapply/JobSpy/main/jobspy/linkedin/__init__.py |

So: `job_url_direct` helps for Indeed postings whose employer link is not hosted by Indeed; LinkedIn rows never carry a direct URL in this scraper version, only a LinkedIn page and a LinkedIn company page. Following any `linkedin.com` URL needs a login for apply and is forbidden by AGENTS.md (no LinkedIn automation); the resolver must never fetch `linkedin.com` pages. For LinkedIn use name + title lookup (section 1) and careers pages from `companies.domain` only. **Caveat:** the file excerpts above were summarised by the fetch tool; the main branch may differ from the version pinned in our JobSpy dependency. The dev card should read the pinned version's source or its `columns` output.

| Source | Link kind | Login / payment | Direct company link |
|---|---|---|---|
| YC (Work at a Startup) | `workatastartup.com/companies/{slug}`, `/jobs/{id}` | YC's FAQ describes a single application form on the site for companies in its directory, and says to apply on the company's own website for companies not in it (https://www.workatastartup.com/faq, via search excerpt). Whether a logged-out visitor can apply is UNKNOWN; the user agreement mentions an account | company page lists the company website (not verified today). Unknown company slug returns 404 (live) |
| JobStreet | `jobstreet.com` / country subdomains, "Apply with SEEK" in-platform flow (Zoho post on Enhanced Apply with SEEK for JobStreet/JobsDB; not an official SEEK page) | apply needs a JobStreet/SEEK profile; UNKNOWN whether a company-site option exists on listings (nothing found) | UNKNOWN. Treat as aggregator with no free route unless the description holds a link |

## 4. Paid-only aggregators (`paid_aggregator` list)

Never signed up; claims below come from vendor pages / search excerpts and are labelled by strength.

| Host | Evidence | Strength |
|---|---|---|
| `flexjobs.com` | Listings are vetted and the site is member-funded; "Subscriptions allow users to apply" ($9.95/week to $59.95/year per search excerpt of https://www.lilachbullock.com/flexjobs-remote-jobs-review/; second-hand) | medium: second-hand; vendor FAQ fetch timed out |
| `remote.co` | Sister site of FlexJobs with a reduced listing set, same member model per the same excerpt | medium-low |
| `theladders.com` | Premium needed to apply to a posted role one was not contacted about ($25-$99); https://bestcompany.com/job-search/theladders excerpt, plus Wikipedia entry listed in results | medium |
| `remotejobs.io` | Paywall once you click apply, save, upload a resume or view full company details; https://resume.co/blog/remotejobs-io-review | medium |
| `virtualvocations.com` | Pay-to-apply per reviewers; vendor says a free tier lets you apply to select jobs; paid tier unlocks the full database (https://sidehusl.com/virtual-vocations/) | medium-low (partly free) |
| `weworkremotely.com` | Official FAQ (via search excerpt) lists Basic (free: browse, save, upload resume) and **WWR Pro $14.95/mo adding "unlimited job applications"**; so the free tier probably has limited applications. A 2026 Trustpilot reviewer says a 12-month $168 plan was needed to apply to one job. Free cap UNKNOWN | **UNKNOWN**; do not mark every WWR job `paid_aggregator` automatically |
| `himalayas.app` | Not paid; free sign-up required to apply (live page). Different class: "sign-up wall" | high (observed) |

Detection (no sign-up needed):
- By host: matching the table above (suffix match on hostname).
- By URL: a stored apply link whose host is a known aggregator (`JOB_BOARD_HOSTS` in `company-domain.ts`) **and** no employer URL was found in steps 1-3 = the only route is the aggregator.
- By page: not recommended. Paywall wording ("subscribe to apply", "upgrade to apply", "membership required") is per-site and changes; scanning for it costs a request per job. Keep a static host list with an `evidence` URL per entry and let the human edit it.

Open design question for the PM: **Himalayas** (and possibly Arbeitnow's in-site form, JobStreet) need a free sign-up, not a payment. Conventions define `paid_aggregator` as "a payment or subscription". Recommend either extending its definition to "payment or sign-up wall" or adding a fifth apply type; an owner decision, not made here.

## 5. Apply phrasing inside HN comments and descriptions

HN "Who is hiring" thread 49922569 (October 2026), counts from the Algolia search API restricted to comment text of that thread (`/api/v1/search?tags=comment,story_49922569&query=...&hitsPerPage=0`; counts are token matches, so approximate; checked 2026-10-14):

| Phrase / host in comment | Comments |
|---|---|
| `"apply at"` | 22 |
| `careers` | 81 |
| `ashbyhq` (e.g. `jobs.ashbyhq.com/...`) | 31 |
| `greenhouse` | 9 |
| `lever.co` | 2 |
| `workatastartup` | 2 |
| `"email us"` | 6 |
| `mailto` | 0 (HN renders e-mail addresses as plain text, not links) |
| `"send your resume"` | 4 |

Observed shapes (company details deliberately omitted; real examples contain private e-mail addresses that must not be committed):
1. Pipe-separated first line, then a link to a careers page or an ATS job (`Company | Role | REMOTE | ... \n https://jobs.ashbyhq.com/<slug>/<uuid>`).
2. "Apply at https://<company>/careers" or "Apply here: <url>" in the body.
3. "CONTACT: <addr> -- please send your resume and include the role name and 'HackerNews' in the subject line" (e-mail route).
4. "Please send your resume + a short cover letter to: <addr>".
5. "If you're interested, send your resume to <addr> and mention which role".
6. E-mail may be obfuscated (`name [at] domain`, "at ... dot ..."): from general HN practice; not counted today.

Regexes for the dev card (case-insensitive, run on the HN comment text after tag stripping):
- Apply hint lines: `\b(apply|applications?)\b[^\n.]{0,40}\b(at|here|via|through|on|to)\b[^\n]{0,20}(https?://\S+)` -> take the URL.
- E-mail route: `\b(send|email|e-mail|mail)\b[^\n.]{0,60}\b(cv|resume|r[eé]sum[eé]|application)\b[^\n]{0,60}([\w.+-]+@[\w-]+\.[\w.-]+)` and the bare `\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b`.
- Obfuscated: `([\w.+-]+)\s*(?:\[at\]|\(at\)| at )\s*([\w-]+(?:\s*(?:\[dot\]|\(dot\)|\.| dot )\s*[\w-]+)+)`.
- URL ordering for the resolver (matches conventions step 3): ATS job URL (section 2 table) > link on `companies.domain` > any other link. An e-mail found in the company's own posting is `company_form` per conventions; an e-mail in a personal-looking mailbox (gmail.com etc.) is still what the poster stated, but **must not be stored in committed fixtures** and should be treated as personal data (stored under `data/` only).

## 6. Request budget per posting (steps 1-2, 3-slug cap, 30-day negative cache)

Assumptions: shared HTTP client paces 1 request / 2 s per host; DB checks (canonical ATS posting or known `ats_type`/`ats_slug`) cost 0.

Worst case for one company with no cache entry and nothing found:
- Step 1: 3 slug candidates x 6 ATSs = **18 requests**, each to a different ATS host group (so no more than 3 sequential per host; wall time ~6 s per host if the hosts run in parallel, ~36 s sequentially). Byte cost is dominated by hits, not misses (misses are 9-44 B, except SmartRecruiters 50 B).
- Step 2: up to 2 careers pages (`/careers`, `/jobs`) = **2 requests** (typical HTML 100-600 KB).
- Total **<= 20 requests** per company in the worst case, then cached for 30 days (`companies.ats_checked_at`). A positive hit adds 1 board download (0.01-2.8 MB, see section 1) and stops the search.
- Realistic: companies already in the DB with `ats_type` cost 0. Most others will 404 on most probes; expect 18 cheap 404s + 2 pages.
- Reduction options (the dev card can choose):
  1. Probe only the ATSs that the careers page hints at first; run step 2 before step 1's blind slug probes when a company domain is known (2 requests vs 18). Conventions order them 1 then 2; this is a deviation that needs a decision entry.
  2. Skip candidate C unless candidates A and B both fail the same ATS, as already gated in section 1.
  3. Cache results per (company, ATS, slug) negative for 30 days and a company-level negative; positive boards cached in the DB.
- Expected daily budget: if the digest shows ~20 new kept companies a day, 20 x 20 = 400 tiny requests a day across 6 hosts (~65 per host) plus occasional positive downloads: far below any limit seen. Rate limits of the six APIs are not published (Arbeitnow 50/window header is for a different host); polite pacing is the control.

## Risks and ToS notes
- Greenhouse, Lever, Ashby board APIs are the vendors' documented public job-board APIs (checked in earlier research `t_e94c6eb7`); SmartRecruiters keyless access and Workable widget are undocumented/tolerated (`t_bb8a60de`). Probing unknown slugs at volume is still "guessing"; the 3-slug cap and 30-day cache are the courtesy limit.
- SmartRecruiters detail JSON has `creator.name` (a person) and Recruitee has `mailbox_email`; never put in fixtures.
- Remotive's API terms forbid republishing its jobs to other boards; following a Remotive link to its employer is not the same, but pages are behind a Cloudflare challenge: do not attempt to defeat it.
- LinkedIn: no fetch of `linkedin.com`; JobSpy fields only. `lnkd.in` is in the repo's shortener list.
- HN comment text contains private e-mail addresses: keep only under `data/`.

## UNKNOWN (what was tried)
- Literal Lever, Workable, Recruitee and SmartRecruiters embed snippets: vendor help pages need an admin login or did not load (WebFetch of the Workable article returned no code; the Lever help page returned a CSS error; searches returned no snippet). Hosted-link patterns above are used instead.
- Greenhouse helper article: code only in screenshots; the loader script itself was read live instead.
- Remotive and WWR job pages: HTTP 403 / Cloudflare challenge; not bypassed.
- Whether Ashby / Recruitee accept a size limit for a cheap probe: not tested.
- Whether WWR free accounts can apply, and how many applications: official FAQ only seen via a search excerpt.
- What `{arbeitnow job url}/apply` redirects to.
- web3.career `apply_url` split between employer links and its own form (needs a token; none used).
- YC logged-out apply flow, JobStreet company-site option.
- Workday and Rippling URL patterns were not fetched.

## Sources (access date 2026-10-14)
- Live APIs: `boards-api.greenhouse.io/v1/boards/{stripe,zzznonexistent123}[/jobs]`; `api.lever.co/v0/postings/{spotify,zzznonexistent123}?mode=json`; `api.eu.lever.co/...`; `api.ashbyhq.com/posting-api/job-board/{ramp,zzznonexistent123}`; `jobs.ashbyhq.com/{zzznonexistent123,ramp/embed?version=2}`; `jobs.lever.co/zzznonexistent123`; `apply.workable.com/api/v1/widget/accounts/{huggingface,zzznonexistent123}`; `api.smartrecruiters.com/v1/companies/{BoschGroup,zzznonexistent123}/postings?limit=1`; `{bunq,zzznonexistent123}.recruitee.com/api/offers/`; `boards.greenhouse.io/embed/job_board/js?for=stripe`; `boards.greenhouse.io/embed/job_board?for=stripe`; `boards.greenhouse.io/zzznonexistent123`; `{personio,zzznonexistent123}.jobs.personio.de/xml?language=en`; `zzznonexistent123.{bamboohr.com/careers/list,breezy.hr/json,pinpointhq.com/postings.json,teamtailor.com/jobs}`; `workatastartup.com/companies/zzznonexistent123`; remoteok.com / himalayas.app / arbeitnow.com job pages; `remotive.com` job page (403 challenge); `hn.algolia.com/api/v1/search?tags=comment,story_49922569`.
- https://www.ashbyhq.com/job-board-embed-examples/full-job-board ; https://docs.ashbyhq.com/embedding-ashby-job-boards-in-an-external-careers-page (search excerpt)
- https://support.greenhouse.io/hc/en-us/articles/46365908766875-Embed-a-Greenhouse-job-board-on-your-career-site
- https://developer.personio.de/docs/integration-of-open-positions ; https://support.personio.de/hc/en-us/articles/4403382315153
- https://help.workable.com/hc/en-us/articles/115012801727-How-to-embed-jobs-on-your-website
- https://github.com/speedyapply/JobSpy (README, `jobspy/indeed/__init__.py`, `jobspy/linkedin/__init__.py`)
- https://www.workatastartup.com/faq ; https://help.zoho.com/portal/en-gb/community/topic/enhanced-apply-with-seek-now-with-jobstreet-jobsdb-29-1-2025
- https://weworkremotely.com/frequently-asked-questions (search excerpt) ; https://www.trustpilot.com/review/weworkremotely.com ; https://pitchmeai.com/blog/we-work-remotely-pricing-job-seekers (third party)
- https://resume.co/blog/remotejobs-io-review ; https://bestcompany.com/job-search/theladders ; https://sidehusl.com/virtual-vocations/ ; https://www.lilachbullock.com/flexjobs-remote-jobs-review/
- Repo: `packages/sources/src/*/index.ts`, `packages/pipeline/src/normalize/company-domain.ts`, `docs/research/t_bb8a60de-ats-board-apis.md`, `t_92e11b3f-remote-boards.md`, `t_a300c0dc-web3career-api.md`, `t_fd541b14-hn-who-is-hiring.md`

## Confidence
- High: board URLs, 200/404 behaviour and sizes (observed today); Greenhouse and Ashby embed patterns; Himalayas / RemoteOK / Arbeitnow link kinds (page observed).
- Medium: slug-derivation heuristic (not validated against a golden list); JobSpy field semantics (source excerpts via the fetch tool, current main); hosted-link regexes for Teamtailor, BambooHR, Breezy, Pinpoint.
- Low: paid-only list (second-hand reviews, no sign-ups); Workday, Rippling; WWR free-tier apply limit; YC and JobStreet flows.
- To raise: read the pinned JobSpy version's source; run a 30-company golden list through the slug rules and the name check; ask the owner to confirm the paid-site list from sites they have seen; capture embed snippets from 5 real careers pages per ATS by hand.
