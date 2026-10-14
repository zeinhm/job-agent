# Research: LinkedIn hiring posts via Brave Search (t_788d14a9)

Date checked: 2026-10-14 (all URLs accessed that day). No Brave key was used, no linkedin.com page was opened (only a
web-search tool's result lists, which show titles/URLs). No personal data below: the example posts are described
generically, no names.

## Answer
- **Query set:** 6 queries (section 1), `freshness=pd`, `count=20`, page 0 only. Real yield is **UNKNOWN** (no key, and
  the only search tool available ignores `site:`); a hand search suggests Brave-like engines return mostly LinkedIn
  *profile* pages (`/in/...`) that embed a person's recent post, so the query must allow `/in/` and `/posts/` hosts and
  the adapter must classify by URL.
- **Storage is the blocker for anything beyond the URL:** Brave's terms §3(b)(i) forbid storing Search Results "in whole
  or in part" beyond transient storage. Options (a) URL + own extracted facts, (b) URL + snippet, (c) a storage-rights
  plan are in section 3. (b) is not allowed on the Search plan. **Owner decision (ToS).**
- **Cost:** 44 requests/day (32 posts + 12 discovery) = about 1,320/month = **$6.60, i.e. about $1.60/month over the $5
  credit** (section 4). Trimming to 36/day fits in about $5.40.
- **Fetch risk (Q5):** no query form makes Brave fetch linkedin.com for us; the risks are in our own downstream steps
  (section 5).

## 1. Query set (Q1)
All: `GET https://api.search.brave.com/res/v1/web/search?q=<q>&count=20&freshness=pd`. `pd` = "24 hours or less"
(https://api-dashboard.search.brave.com/api-reference/web/search/get , 2026-10-14). Brave filters by "the most relevant
date the content reports", so a profile page whose newest post is fresh but whose text is old may pass or fail
unpredictably (my inference, not documented).

| # | Query | Aim |
|---|---|---|
| 1 | `site:linkedin.com/posts hiring ("senior frontend" OR "senior front-end") remote` | senior FE |
| 2 | `site:linkedin.com/posts hiring ("full stack" OR "fullstack") (react OR typescript) remote` | full-stack React |
| 3 | `site:linkedin.com/posts hiring "react" (senior OR staff OR lead) remote` | React seniors |
| 4 | `site:linkedin.com/posts hiring (frontend OR react) (APAC OR "Southeast Asia" OR Indonesia OR Asia)` | region match |
| 5 | `site:linkedin.com/posts ("we're hiring" OR "we are hiring") (frontend OR "full stack") "worldwide"` | worldwide |
| 6 | `site:linkedin.com/in hiring (frontend OR "full stack" OR react) remote (APAC OR Indonesia OR worldwide)` | profile-hosted posts (see below) |

Run 4 of them per 3-hour slot (rotate, or drop 5/6 if yield is poor): 4 x 8 runs = 32/day, matches the card.

**Expected results per query: UNKNOWN.** What was tried:
- Brave docs: `count` max 20, `offset` max 9 (https://api-dashboard.search.brave.com/documentation/services/web-search). The
  docs give no index-size or LinkedIn-coverage figure; Brave's own guide says nothing about social content
  (https://brave.com/search/api/guides/what-sets-brave-search-api-apart/ , it only claims "over one hundred million new
  and refreshed pages each day").
- Ordinary web search by hand (a non-Brave engine, `site:` was ignored): `site:linkedin.com/posts "hiring" "senior
  frontend" "remote"` returned 9 results, 6 of them `*.linkedin.com/in/<handle>` pages, 0 `/posts/` URLs, 1 company
  job page, 1 job list. Of the 6 LinkedIn pages: 3 showed an employer/recruiter hiring post (titles such as "Hiring:
  Senior Frontend Engineer - Remote Worldwide", "Hiring React Frontend Developers From ..."), 3 were job-seekers
  ("Open to Work"). Second query (`"we're hiring" "React" "full stack" remote APAC`): 9 results, 0 `/posts/`, ~4 hiring
  posts hosted on profile pages (Vietnam, Philippines, Ukraine), 1 job seeker, rest noise (Indeed, a 2019 Reddit
  thread). Third query: no figure for freshness lag or index size found. These are single runs on a different engine;
  treat as a rough hint only: **roughly 40-50% of the LinkedIn hits look like real hiring posts, but most are `/in/`
  pages, and many are region-locked** (e.g. "open to Filipinos only", "Vietnamese candidates", "Remote LATAM").
- LinkedIn indexing by search engines is not guaranteed: a past outage de-indexed linkedin.com from Google for about ten
  hours (https://searchengineland.com/oops-linkedin-temporarily-drops-out-of-google-search-334323), which shows
  dependence on the engine's crawl, not a rate.
- To raise confidence: owner runs the 6 queries 3-4 times with a key and reports counts (the dev card should log
  per-query result count, count by URL type and count passing the role filter).

**Practical implication:** the card's `site:linkedin.com/posts` form may under-return. Query 6 (`site:linkedin.com/in`)
is the hedge; both need a URL classifier (`/posts/`, `/feed/update/`, `/pulse/` = post; `/in/<handle>` = profile page
hosting a post; `/company/` = skip; `/jobs/view/` = job, already covered by JobSpy).

## 2. Result fields (Q2)
Documented in Brave's response schema (https://api-dashboard.search.brave.com/api-reference/web/search/get ; the page
was truncated before `web.results[]`, so the descriptions below are from the identical field set under
`discussions.results[]` on the same page, plus third-party mirrors, e.g. https://mcpservers.org/agent-skills/brave/web-search):

| Field | Meaning (quoted/near-quoted) | Use for us |
|---|---|---|
| `url` | "URL where the page is served" | keep |
| `title` | "Title of the web page" | for LinkedIn pages a post's first line or the profile headline |
| `description` | "Description of the web page" (the snippet) | where role/company/apply text would be |
| `extra_snippets` | up to 5 extra excerpts, only with `extra_snippets=true` | more text, same storage limits; plan requirement not documented |
| `age` | "Human-readable age of the result, such as '2 days ago'" | optional |
| `page_age` | "Date of the page, based on its published or last-modified date" (date or datetime string, handle both) | freshness check |
| `profile` | `name`, `url`, `long_name`, `img` | for a post/profile hit this is the publisher identity; see personal-data note |
| `meta_url` | scheme, netloc, hostname, favicon, path | not needed |

`age`/`page_age`/`profile` exact presence on web results is **not confirmed** from Brave's own page for web results;
third-party mirrors disagree on whether `age` is a relative string or an ISO stamp. Confirm on the first live run.

**How often the snippet holds role / company / apply link: UNKNOWN** (no live Brave response). From the by-hand
search above (other engine's text extracts): role/stack present in nearly every hiring hit (the query terms force it);
company name present in the post text in roughly half (often only in the poster's headline); an apply link or e-mail
in the snippet was **not visible in any of the ~8 hiring hits** (apply routes are usually "DM me" or a link beyond the
snippet). Expect snippets of ~150-300 characters; links mostly truncated. So the adapter will mostly give a lead
(role, region, poster), not an apply URL; `apply_links` step 3 ("links inside the posting text") will rarely fire.

**Personal-data note:** a post hit identifies a named person (poster). The poster name/headline are third-party
personal data under Brave's results. Keep it out of the repo (fixtures, docs, commits); in `data/` only if the owner
allows (it falls under the storage question below anyway).

## 3. Storage terms (Q3) - owner decision, not a recommendation
Brave API Terms of Service (https://api-dashboard.search.brave.com/terms-of-service, 2026-10-14). Exact quotes:
- **§3(b)(i):** Customer may not "store, cache, or create a database of Search Results, in whole or in part, other than
  transient storage required for operation of Customer Applications or related software, service or systems".
- **§3(b)(xiii):** may not "use the Search Results to create, evaluate, train, re-train, fine-tune, benchmark or
  otherwise improve ... artificial intelligence models or services offered by Customer or third parties".
- **§3(b)(xii):** may not "redistribute, resell, or sublicense the Search Results".
- **§3(b)(xiv):** after expiry/termination may not "retain Documentation or Search Results in Customer's possession and
  control"; **§13(c)(ii):** must "cease using, destroy, and permanently erase all copies of the API, Documentation,
  Search Results".
- **§9(a)(ii):** Brave owns Search Results "subject to the rights of third parties in any Third-Party Content
  referenced, linked to or included in Search Results".
- The ToS has **no storage-rights plan clause**. The plans page says "Plans with storage rights grant special permissions
  which are not covered in our general Terms of Service" and the FAQ says to keep results "you will need to subscribe to
  a plan that explicitly grants storage rights" (https://brave.com/search/api/). The Search ($5/1,000) and Answers plans
  list no storage rights; Enterprise is custom.
- Brave's "what sets apart" guide: "specific plans for storing results if developers are building a persistent dataset";
  paid tiers scale with "rights to store data and rights to use the data in LLM training".

| Option | What we keep | Fits the terms? | Cost |
|---|---|---|---|
| (a) URL + our own facts | the post URL (a pointer, but it came from a Search Result), plus facts we derived (role title, company, region, remote flag, poster-agnostic). Snippet/title dropped right after extraction; never logged, never in fixtures | Most defensible, **not certain**: the URL is itself part of a Search Result, and §3(b)(i) says "in whole or in part". Same reasoning the earlier card used for ATS slugs (t_250e744a section 2), which is weaker here because the stored fact (a particular post) is the result itself, not a public fact about a company. Also **§3(b)(xiii) risk**: sending the snippet to an LLM for extraction might read as "improve AI models"; extraction is not training, but the earlier card chose to keep Brave text away from LLMs. Plain-code extraction (regex/keywords) avoids it | $0 extra |
| (b) URL + snippet | URL, title, snippet | **No** on the Search plan: it is exactly "store ... Search Results ... in part" | n/a |
| (c) storage-rights plan | everything | Yes, if a plan grants it | A third-party/Brave community listing gives "Data with Storage Rights" at **$26/1,000 (Base, 20 req/s) and $45/1,000 (Pro, 50 req/s)** (https://community.brave.app/t/data-w-storage-rights-tos/571395 , search snippet only, not verified); another 2026 account of Brave's Feb restructure lists only Search/Answers/Spellcheck/Autosuggest with no storage tier (https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/). **Current price and availability: UNKNOWN**; ask searchapi-support@brave.com. At $26/1,000, 1,320 requests/month = about $34 |

Extra practical points for (a): the product must still re-find the post URL to dedupe; storing only a hash of the URL plus
the derived fields is the weakest-footprint version (my suggestion, not a legal view). Recall that this repo is public:
never commit live Brave responses as fixtures (§3(b)(xii)); fixtures must be hand-written fake results.

**Decision needed from the owner (OWNER/legal):** pick (a) with plain-code extraction, (a) with LLM extraction, or (c), or
drop the source. Optional: email Brave to ask whether storing a result URL plus derived facts is "transient storage".

## 4. Cost (Q4)
Brave Search plan: $5 per 1,000 requests, $5 monthly credit (https://brave.com/search/api/ , 2026-10-14) = 1,000
requests free per month.

| Scenario | Requests/day | /month (30 d) | Cost | Over credit |
|---|---|---|---|---|
| Discovery only (current) | 12 | 360 | $1.80 | $0 |
| Posts only (4 x 8 runs) | 32 | 960 | $4.80 | $0 |
| **Posts + discovery (card)** | **44** | **1,320** | **$6.60** | **$1.60** (31-day month: 1,364 = $6.82) |
| Posts 3 queries x 8 + discovery | 36 | 1,080 | $5.40 | $0.40 |
| Posts 4 x 8 + discovery every 2nd day | 38 | 1,140 | $5.70 | $0.70 |

The credit alone runs out around day 22-23 at 44/day. Code impact: `DAILY_QUERY_BUDGET = 20` in
`packages/sources/src/discovery/search.ts:6` is a per-run cap shared by discovery; the posts adapter needs its own
budget (`MAX_POST_QUERIES_PER_RUN`) and a combined monthly guard (e.g. refuse above 1,000 unless the owner raises it).
If the storage-rights plan (c) were chosen: about $34/month at $26/1,000 (unverified price).
Brave keeps queries up to 90 days for billing (https://api-dashboard.search.brave.com/privacy-policy, per the earlier
card); our queries carry no personal data.

## 5. Does any query form fetch linkedin.com content? (Q5)
- **Brave side: no.** The API returns indexed text only; our request goes to `api.search.brave.com`. `site:linkedin.com/...`
  is a filter inside `q`, not a fetch. `freshness`, `extra_snippets`, `count`, `offset` are Brave-side parameters.
  `result_filter`/`summarizer`/`rich` callbacks also call Brave endpoints, not LinkedIn; do not use them (cost, terms).
- **Our own downstream steps are the risk** (all must be fenced in the dev card):
  1. Apply-link resolution step 3/2 (`docs/phase-3-conventions.md` section 2) follows links found in posting text: a
     `linkedin.com/redir/redirect?url=...` or `lnkd.in/...` link in a snippet must **never be requested**; extract the
     target `url=` parameter with plain parsing only if it is an ATS/company host, else store nothing.
  2. Company-domain careers fetch must reject any `linkedin.com` host (the conventions already say "no LinkedIn").
  3. The generic `httpGetJson` client must have a host deny-list (`linkedin.com`, `*.linkedin.com`, `lnkd.in`) so a
     bug cannot fetch a result URL. The adapter should only ever pass URLs to the DB, never to a fetcher.
  4. Thumbnails/favicons in `meta_url`/`thumbnail` are Brave proxies, but do not load them anyway.
- Result URLs can sit on regional subdomains (`pt.linkedin.com`, `vn.linkedin.com`) - host matching must be suffix-based.

## Risks
- Storage (section 3) and personal data of posters.
- Yield could be low or noisy; most hits may be profile pages and job-seeker posts. Cheap mitigation: URL classifier,
  title/snippet keyword filter in plain code, per-query counters logged.
- Posts lag: the index depends on Brave's crawl; "hours to a day behind" (PLAN) is plausible but unmeasured.
- Region locks inside snippets ("Filipinos only", "LATAM") need the existing location rules, not a reject at this stage.

## Sources (accessed 2026-10-14)
- https://api-dashboard.search.brave.com/terms-of-service
- https://brave.com/search/api/ and https://brave.com/search/api/guides/what-sets-brave-search-api-apart/
- https://api-dashboard.search.brave.com/documentation/services/web-search
- https://api-dashboard.search.brave.com/api-reference/web/search/get (partial: first 100k characters)
- https://community.brave.app/t/data-w-storage-rights-tos/571395 (via search snippet)
- https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/ (secondary)
- https://mcpservers.org/agent-skills/brave/web-search (third-party mirror of field list)
- https://searchengineland.com/oops-linkedin-temporarily-drops-out-of-google-search-334323
- Repo: `docs/research/t_250e744a-search-api.md`, `docs/phase-3-conventions.md` sections 2 and 8, `packages/sources/src/discovery/search.ts`

## Confidence
Medium on terms, pricing and cost (primary Brave pages). Low on yield, snippet contents and field presence (no key, no
live response, other engine used by hand). Raise it with: 3-4 live test runs by the owner (log counts and URL types), a
sample real response kept under `data/`, and Brave support's answer on whether URL + derived facts counts as transient
storage and on the current storage-rights price.
