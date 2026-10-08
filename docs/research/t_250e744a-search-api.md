# Research: search API for company discovery (t_250e744a)

Date checked: 2026-10-09 (all URLs below accessed that day unless noted).

## Answer
- **Recommend Brave Search API** (Search plan, `site:` + `freshness` supported, own index, ~$5 per 1,000 requests, $5/month free credit covers ~1,000). At ~12 queries/day (~360/month) the cost is **$0/month** (card on file required; worst case ~$1.80/month if the credit were gone).
- **One real ToS risk for the owner:** Brave's terms forbid storing or building a database of Search Results beyond transient storage (see Terms). Mitigation: persist only the derived company slug + ATS type, never url/title/snippet.
- Fallback: Serper.dev (2,500 free queries, then ~$1 per 1,000; `tbs` freshness) - cheaper, but it resells Google results and its terms are silent on storage. Google Programmable Search is **closed to new customers**, ruled out.

## 1. Provider comparison

| | Brave Search API | Serper.dev | Google Programmable Search (JSON API) |
|---|---|---|---|
| Free tier | $5 credit/month, auto-applied (~1,000 Search requests); card required | 2,500 free queries on signup, one-off, no card (per Serper homepage) | 100 queries/day |
| Price | $5 per 1,000 requests (Search plan) | Prepaid packs: $50 = 50k credits (~$1/1k), $375 = 500k ($0.75/1k) (third-party reports, Jul 2026; official pricing page not readable) | $5 per 1,000, max 10k/day |
| Availability | Open | Open | **Closed to new customers**; existing customers must migrate by 2027-01-01 |
| `site:` | Yes, inside `q` | Yes (Google syntax) | Site-restricted engine, not general `site:` |
| Freshness | `freshness=pd` (24 h) / `pw` (7 d) / `pm` / `py` / custom range | `tbs=qdr:d` / `qdr:w` (third-party sources; not confirmed from Serper docs) | n/a |
| Results per call | `count` max 20 (default 20), `offset` max 9 | 10 per credit; 11-100 results cost 2 credits (third-party) | 10 |
| Rate limit | 50 queries/s on Search plan | not found | not found |

Sources:
- Brave plans: https://brave.com/search/api/ (Search plan $5/1,000, $5 monthly credit, 50 QPS)
- Brave endpoint/params: https://api-dashboard.search.brave.com/documentation/services/web-search
- Brave free-credit change (secondary): https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/ , https://agentdeals.dev/vendor/brave-search-api (they disagree on wording, agree on the $5 credit)
- Serper free credits: https://serper.dev ; pack prices (third-party): https://apiserpent.com/blog/serper-pricing-credits-explained , https://costbench.com/software/web-scraping/serper/
- Google CSE closure: https://developers.google.com/custom-search/v1/overview

## 2. Terms of service
**Brave** (https://api-dashboard.search.brave.com/terms-of-service):
- §3(a): API may be used "solely to develop, test, and integrate the API with" the Customer Applications. No clause about automated use as such; usage is by API key.
- §3(b)(i): may not "store, cache, or create a database of Search Results, in whole or in part, other than transient storage". Storage needs a plan that "explicitly grants storage rights" (https://brave.com/search/api/ FAQ); a secondary source lists "Data with Storage Rights" at $26/1,000 (Base) and $45/1,000 (Pro): https://community.brave.app/t/data-w-storage-rights-tos/571395 (not verified on Brave's own page).
- §3(b)(xiii): no using results to create/evaluate/train/fine-tune/benchmark AI models. **Our LLM stages must not receive Brave titles/snippets** (we only use the URL to derive a slug, then poll the ATS API).
- §3(b)(v): no bypassing rate limits (no second accounts). §3(b)(xii): no redistributing results. Our repo is public, so never commit search results/fixtures taken from live Brave responses.
- §4(d): attribution is optional ("POWERED BY BRAVE" if used). Some secondary sources say attribution is needed to keep the free credit; Brave's own pages do not say so (UNKNOWN, low impact: a private tool has no public site to attribute on).
- Privacy notice: Brave keeps queries up to 90 days for billing: https://api-dashboard.search.brave.com/privacy-policy . Our queries are generic role keywords, no personal data.
- **Interpretation (mine, not legal advice):** the slug of a company that hosts a board on Greenhouse is a public fact about that company, not a Search Result, but the URL it came from is. Keep the URL transient (in memory during the run), store `ats_type + slug + discovered_via=search + discovered_at`. If the owner wants zero ambiguity: email searchapi-support@brave.com (named in Brave's FAQ) or use Serper. **Needs an owner decision (legal / ToS).**

**Serper** (https://serper.dev/terms): B2B service; no clause on storage, automated use, or resale found; forbids circumventing limits and multiple accounts; 7-day refund on first payment. Credit expiry: sources conflict (6 months vs none). Results are scraped Google results; Google's ToS exposure sits with the vendor, not specified for customers (UNKNOWN).

## 3. Request/response shape (Brave)
```
GET https://api.search.brave.com/res/v1/web/search?q=<query>&count=20&freshness=pw
Header: X-Subscription-Token: <BRAVE_API_KEY>
        Accept: application/json
```
Response: `web.results[]` with `url`, `title`, `description` (optional `extra_snippets`); `query.more_results_available` (bool) decides whether to request `offset=1` (max 9). Operators (`site:`, quotes, `-`, `filetype:`) go inside `q`. Source: https://api-dashboard.search.brave.com/documentation/services/web-search . Not tested live (no key; agents must not hold one). Zod-parse only `web.results[].url`.

Serper shape (from third-party sources only, UNKNOWN until checked in the dashboard playground): `POST https://google.serper.dev/search`, header `X-API-KEY`, JSON body `{q, num, tbs, page, gl, hl}`, response `organic[].link/title/snippet`.

## 4. ATS host -> slug

| ATS | Host(s) seen in postings | Regex (apply to the result URL; slug = group 1) | Example |
|---|---|---|---|
| Greenhouse | `boards.greenhouse.io`, `job-boards.greenhouse.io`, `job-boards.eu.greenhouse.io` | `^https://(?:boards\|job-boards)(?:\.eu)?\.greenhouse\.io/(?!embed\b)([A-Za-z0-9_-]+)(?:[/?#]\|$)` | `https://job-boards.greenhouse.io/stripe` (redirects to the company site; slug `stripe` is also the API board token, see `docs/research/t_e94c6eb7-ats-apis.md`). Embed links `.../embed/job_app?for=<slug>`: use `[?&]for=([A-Za-z0-9_-]+)` |
| Lever | `jobs.lever.co`, `jobs.eu.lever.co` | `^https://jobs(?:\.eu)?\.lever\.co/([A-Za-z0-9_-]+)(?:[/?#]\|$)` | `https://jobs.lever.co/leverdemo` (fetched OK, job link `.../leverdemo/58db3f8e-...`) |
| Ashby | `jobs.ashbyhq.com` | `^https://jobs\.ashbyhq\.com/([^/?#]+)` (URL-decode; slugs can hold dots/uppercase, keep case) | `https://jobs.ashbyhq.com/ashby` (fetched: JS shell, title "Ashby Jobs") |
| SmartRecruiters | `jobs.smartrecruiters.com` (301 to `careers.smartrecruiters.com`) | `^https://(?:jobs\|careers)\.smartrecruiters\.com/([A-Za-z0-9_-]+)(?:[/?#]\|$)` | `https://jobs.smartrecruiters.com/smartrecruiters` (301 observed; the company's own slug later redirects to a custom careers domain). API check: `https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings?limit=1` returned `{"offset":0,"limit":1,"totalFound":0,"content":[]}` with no key |
| Workable | `apply.workable.com` | `^https://apply\.workable\.com/(?!api\b)([a-z0-9-]+)(?:[/?#]\|$)` | `https://apply.workable.com/workable/` (fetched, title "Current Openings"). Admins can rename the subdomain; old links break (https://help.workable.com/hc/en-us/articles/5270992137751 , per search snippet) |
| Recruitee | `<slug>.recruitee.com` | `^https://(?!(?:www\|api\|support\|careers)\.)([a-z0-9-]+)\.recruitee\.com/` | Format `https://<slug>.recruitee.com/o/<offer>` per https://support.recruitee.com/careers-site/changing-your-careers-sites-url . **No verified live example**: `recruitee.recruitee.com/api/offers/` and `careers.recruitee.com/api/offers/` both returned 404. Public endpoint `https://<slug>.recruitee.com/api/offers/` is vendor-reported only (https://jobspipe.dev/blog/recruitee-api-jobs) |

(`\|` above is a literal pipe escaped for the markdown table; use a plain `|` in code.)
Every extracted slug must be validated by the Phase 1 adapters' own "unknown slug -> 404" check before it is added to the poll list; regexes only propose candidates. Greenhouse/Lever API 404 behaviour: `docs/research/t_e94c6eb7-ats-apis.md`.

## 5. Query list (12 queries, run daily)
`freshness=pw` (past 7 days; use `pm` for the first backfill run). All with `count=20`, page 0 only.
1. `site:boards.greenhouse.io ("frontend" OR "front-end") remote`
2. `site:job-boards.greenhouse.io ("frontend" OR "full stack" OR "react") remote`
3. `site:jobs.lever.co ("frontend" OR "front-end") remote`
4. `site:jobs.lever.co ("full stack" OR "fullstack" OR "react") remote`
5. `site:jobs.ashbyhq.com ("frontend" OR "front-end") remote`
6. `site:jobs.ashbyhq.com ("full stack" OR "react" OR "typescript") remote`
7. `site:jobs.smartrecruiters.com ("frontend" OR "react") remote`
8. `site:apply.workable.com ("frontend" OR "front-end" OR "react") remote`
9. `site:apply.workable.com ("full stack" OR "fullstack") remote`
10. `site:recruitee.com/o ("frontend" OR "react") remote`
11. `site:job-boards.eu.greenhouse.io ("frontend" OR "react")`
12. `site:boards.greenhouse.io ("senior" OR "staff") "react" "typescript" remote`

Yield per query is UNKNOWN: the web search tool available to this agent ignores `site:` and no Brave key exists, so no live test was possible. The dev card should log result counts and new-slug counts per query so the owner can prune. Whether Brave honours `OR` and parentheses in `site:` queries must be checked on the first live run (UNKNOWN; if not, split into one term per query, up to ~24 queries/day).

## 6. Volume and cost
- 12 queries/day x 30 = **360 requests/month**; at Brave $5/1,000 = $1.80, fully covered by the $5 monthly credit -> **$0**. Even 24/day (720) stays inside ~1,000 credit.
- Cap in code: 20 queries/day, no pagination beyond offset 0 unless `more_results_available` and the day's cap is not reached; at most 1 request per 2 s.
- Serper equivalent: 360/month from the 2,500 free queries = ~7 months free, then $50 pack lasts years.

## Risks
- Brave storage clause (above) - owner decision.
- Secondary sources conflict on Brave's free-credit wording; Brave's own page (https://brave.com/search/api/) says $5 credit/month. Card on file is billed beyond it and there is no spending cap documented (apio.sh listing, secondary); the code cap above is the guard.
- Search results are web-index noise: closed postings, custom domains, non-company paths (`/embed`, `/api`). The slug validation step handles it.

## Confidence
Medium. High on Brave endpoint/params, pricing and ToS clauses (primary pages). Low on Serper details (third-party) and on query yield. Raise it with: a Brave key for 3-4 test calls (owner), the Serper dashboard playground, and Brave support's reply on slug storage.
