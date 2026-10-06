# Job Search Agent - Build Plan

A local agent that finds new remote jobs as soon as they are posted, filters out ineligible and scam postings, scores them against my CV, decides a salary ask per posting, and either applies, prepares the application for my review, or saves it to a manual list.

---

## 1. Goals and constraints

**Target**
- Remote worldwide roles (Senior Frontend / Software / Full-Stack Engineer), including Web3.
- Not targeting Indonesian companies. Exception: foreign companies hiring Indonesian developers.
- Based in Indonesia (GMT+7).

**Salary**
- A monthly floor in IDR (hard filter, never ask below it).
- Realistic asks depend on the employer type (see section 5).
- All actual numbers live in `config/salary.yaml`, which is private (gitignored).

**Hard rules**
- Never log into LinkedIn or use my session cookies for automation. Scraping only logged out, at a low rate.
- Never invent answers to application questions. Only use answers I approved.
- Never act automatically on scam-flagged postings.
- Run any take-home repo from a Web3 recruiter only in a disposable VM or container.

---

## 2. Sources

### Tier 1 - official public APIs (no login, no ban risk)

| Source | Notes |
|---|---|
| Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee | Public JSON job boards behind most tech company careers pages. Jobs appear here first. Ashby can include compensation. Requires a list of companies to poll. |
| web3.career | Official API with a free token (request at web3.career/web3-jobs-api). Filters for remote, country, tag. Large source, many listings show salary. |
| Remotive, RemoteOK, Himalayas, Arbeitnow, We Work Remotely (RSS) | Remote-focused boards. |
| Hacker News "Who is hiring" | Monthly thread, via the Algolia HN API. |
| Reddit API | r/forhire, r/remotejs, hiring threads. |
| Threads API | Official keyword search (needs threads_keyword_search permission). RECENT mode gives newest first. Limit: 500 queries per rolling 7 days (~70 per day). |

Known ATS endpoints:
- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- Lever: `https://api.lever.co/v0/postings/{company}`
- Ashby: `https://api.ashbyhq.com/posting-api/job-board/{company}`

**Company discovery:** search-engine queries such as `site:jobs.ashbyhq.com "frontend" remote` or `site:boards.greenhouse.io "react"` find new companies on these ATS. Each new company is added to the polling list automatically.

### Tier 2 - logged-out scraping (gray area, may get IP-blocked)

| Source | Notes |
|---|---|
| LinkedIn job search | Guest search with "past hour" / "past 24 hours" filter, sorted by newest. Solves the recency problem of email alerts. Two searches: location "Worldwide" + remote, and location "Indonesia" + remote (finds foreign companies hiring Indonesian devs). |
| Indeed, Glassdoor, Google Jobs | Indeed is the most reliable of these. Two Indeed searches: global remote, and Indeed Indonesia + remote (foreign companies hiring here). |
| YC Work at a Startup | Job pages on ycombinator.com are public, no account needed. No official API, so a logged-out scraper; low risk. Bonus: YC's company directory uses a public Algolia API, so hiring YC companies get added to the ATS polling list (many use Ashby / Greenhouse). Many roles are "Remote (US)" only; the location filter handles that. |
| JobStreet | Custom scraper of public search pages (no known API, scraping behavior not yet verified). The Indonesia rule filters out domestic companies; foreign companies hiring in Indonesia / SEA stay. |

LinkedIn, Indeed and Glassdoor via **JobSpy** (Python library, supports `hours_old`). YC and JobStreet need their own adapters. Against LinkedIn's terms even when logged out; the realistic risk is a temporary IP block, not account loss.

**Applying from Tier 2 needs my own login**, so the agent never applies there on its own:
- **JobStreet and YC Work at a Startup:** semi-automated (see section 6). The agent fills the form in my logged-in browser; I review and click submit.
- **LinkedIn:** fully manual. No automation of any kind on my LinkedIn account.

When the same job also exists on the company's own ATS, the agent prefers that link, which can be applied to directly.

### Social posts

- **Threads:** official keyword search (see Tier 1).
- **LinkedIn posts:** no logged-out post search. Use search-engine queries like `site:linkedin.com/posts "hiring" "frontend" "remote"` with a past-day freshness filter. Partial coverage, usually hours to a day behind.
- **X:** official API exists but is paid. Optional.

### Not automated

- Anything logged in as me: LinkedIn (Easy Apply, post search, messaging), YC Work at a Startup applications, JobStreet applications.
- Glints, Kalibrr: mostly domestic companies, covered better by LinkedIn / Indeed / JobStreet with the Indonesia rule.

### To evaluate during the build

CryptoJobsList, Cryptocurrency Jobs, Remote3 (Web3 boards). Add whichever has a clean API or RSS feed.

---

## 3. Filters (rules, before any LLM call)

### Location eligibility

| Class | Action |
|---|---|
| Remote worldwide | keep |
| Remote APAC / Asia / Indonesia allowed, or GMT+7-friendly hours | keep |
| Remote but restricted elsewhere ("US only", "EU only", "must reside in") | reject |
| Unclear | keep, flag for the LLM step |

### Indonesia rule

Exclude Indonesian companies. Keep foreign companies hiring in Indonesia, identified by: foreign HQ, salary in a foreign currency (USD, SGD, EUR), or hiring through an employer-of-record (Deel, Remote, etc.).

### Salary

- Normalize every salary to **IDR per month** using a daily FX rate (yearly / 12, hourly x 160).
- Maximum below the floor (from `config/salary.yaml`) -> reject.
- No salary listed -> keep, mark "salary unknown". Most postings don't list one.

---

## 4. Scam detection

Rules plus an LLM check. Each posting gets a risk score. Above the threshold -> "suspicious" list, never acted on automatically.

**Red flags - contact and process**
- Contact only via Telegram, WhatsApp or Discord
- Recruiter on a personal email domain instead of the company domain
- Interview done entirely over chat
- Requests for ID, bank details or payment early on

**Red flags - the offer**
- Unrealistic pay for the role, vague description, extreme urgency
- "No experience needed" combined with high pay
- Crypto / "data entry" style roles

**Web3-specific**
- **Malicious take-home tests:** a fake recruiter sends a "coding assessment" repo; running `npm install` or starting it executes hidden code that steals passwords, wallets, SSH keys and session tokens. Treat any repo-based assessment early in the process as high risk.
- "Paid trial tasks", no verifiable team or product, very new domains.

**Verification (strongest signals)**
- Company has a real website; domain age is not suspiciously new.
- **The role also exists on the company's own careers page or ATS.**
- For social posts: the poster actually works at that company.

---

## 5. Salary strategy

### Three numbers

| Number | Meaning |
|---|---|
| **Floor** | Lowest I accept. Used as a filter. |
| **Ask** | What I answer to "expected salary". The opening number of a negotiation, so it sits **above** the floor (recruiters often negotiate down 10-20%). |
| **Target** | What I hope to get. Used for scoring, never as a cap. |

### Employer types and tiers

| Tier | Who | Ask |
|---|---|---|
| `indonesia` | Foreign company hiring specifically in Indonesia, local benchmark, EOR | Modestly above the floor |
| `regional` | APAC-limited roles, agencies | Above the `indonesia` tier |
| `global_adjusted` | Global company that pays by employee location | Similar to `regional` |
| `global_flat` | Global company that pays the same regardless of location | ~70% of their band, or a fixed global ask if no band |

Floor applies to every tier. Actual values are in `config/salary.yaml` (private). They are starting values and get replaced by real data (section 5.5).

### 5.1 Pay-context extraction

The LLM only extracts facts; plain code makes the decision.

```ts
type PayContext = {
  listedSalary?: { min?: number; max?: number; currency: string; period: "year" | "month" | "hour" };
  hiringScope: "worldwide" | "region" | "countries";
  regions?: string[];
  indonesiaExplicit: boolean;
  companyHq?: string;
  companyType: "product" | "enterprise" | "web3_protocol" | "agency" | "talent_marketplace" | "unknown";
  payPolicy: "location_agnostic" | "location_adjusted" | "unknown";
  employment: "employee" | "contractor" | "eor" | "unknown";
  seniority: "mid" | "senior" | "lead" | "unknown";
};
```

### 5.2 Signals

| Signal | Higher tier | Lower tier |
|---|---|---|
| Hiring scope | "Anywhere", worldwide | Indonesia or a few SEA countries only |
| Pay policy wording | "global band", "same pay regardless of location" | "based on your location", "local market", "cost of labor" |
| Listed currency | USD, EUR | IDR, or a small USD number |
| Why they hire there | Talent-focused | Cost-focused ("offshore", "build our SEA team") |
| Company type | Product startup, funded Web3 protocol | Agency, talent marketplace, staffing firm |
| Employment model | Contractor at a USD rate | EOR with a local contract |

**Flat-pay companies almost always say so** (it is a selling point), in the posting, careers page or handbook. So "unknown" most likely means location-adjusted.

**Trap:** many US companies show a range only because of US pay-transparency laws (often with a note like "for US-based candidates" or a mention of Colorado, New York, California). That range says nothing about pay for Indonesia. Treat it as `unknown`, not `global_flat`.

### 5.3 Decision flow

```
posting lists a range?
├─ yes, location-agnostic  -> ask at ~70% of the range (never above the max)
├─ yes, but US/legal note  -> treat as unknown
└─ no
   ├─ flat-pay signals or registry says flat     -> global_flat ask
   ├─ adjusted signals or registry says adjusted -> global_adjusted / indonesia ask
   └─ unknown -> research company (careers page, handbook)
                 still unknown?
                 -> text field: "Open, happy to align with your compensation band for my location"
                 -> number required: regional ask
floor always applies
```

### 5.4 Company pay-policy registry

Each company's pay policy (flat / adjusted / unknown) is stored with its source, so a company is researched only once.

### 5.5 Learning from data

- **Salary observations:** every posting with a listed salary is stored with tier, seniority, region. After a few weeks, tier asks come from real postings instead of guesses.
- **Outcomes:** "out of our budget" or an offer is recorded against the posting's tier. A tier that keeps getting "too high" goes down; one that never gets pushback is probably too low.

### 5.6 Practical rules

- Use a range or "negotiable" when the form accepts text; a single number only when required.
- Salary answers stay in the review queue until I have checked 20-30 real decisions per tier.

### Config sketch

```yaml
salary:                      # real values: config/salary.yaml (private)
  floor_idr_month: <number>
  position_in_listed_range: 0.7
  tiers:
    indonesia:       { ask_idr_month: <number> }
    regional:        { ask_idr_month: <number> }
    global_adjusted: { ask_idr_month: <number> }
    global_flat:     { ask_usd_year: <number> }
  unknown_policy: research_then_regional
location:
  accept: [worldwide, apac, asia, indonesia, "GMT+7 overlap"]
  reject: ["US only", "EU only", "must reside in"]
  unclear: flag_for_review
indonesia:
  exclude_domestic_companies: true
  keep_if: [foreign_hq, foreign_currency_salary, eor_hiring]
```

### Reference data (2026)

- Local senior (Glassdoor, Jakarta): Senior Frontend Engineer median ~21.7M IDR per month (p75 28.1M, p90 33.7M). Senior Software Engineer median ~25.3M (p75 32.3M, p90 44.6M). Glassdoor labels these "per year" but they are monthly amounts.
- Indonesian salary guide: senior 15-30M IDR per month, tech lead 35-55M+.
- Remote for foreign companies: Plane median $48K per year (p10 $12K, p90 $99K); Arc expected senior frontend $68.6K (expectations, optimistic); Lemon.io senior contracts $30-44/hr.
- Surveys lean optimistic; real data collected by the agent takes priority.
- FX at planning time: ~17,900 IDR per USD (fetched live by the agent).

---

## 6. Applying

| Tier | When | What happens |
|---|---|---|
| **Auto-apply** | Greenhouse / Lever / Ashby form, every question covered by the answer bank, no CAPTCHA | Playwright fills and submits. Starts **off**, then dry-run, then on. |
| **Needs input** | Form has questions the answer bank doesn't cover | Agent fills what it can, drafts the rest, queues it. I answer and approve; new answers go into the answer bank. |
| **Semi-automated** | JobStreet, YC Work at a Startup | Agent opens the job in a visible browser where **I am already logged in**, fills the form from the answer bank, and stops. I review and click submit myself. |
| **Manual** | LinkedIn (any kind), social posts, complex portals, CAPTCHA | Saved with link, fit score, drafted message or cover note. I apply myself. |

Never try to bypass a CAPTCHA; hand the application to me instead.

### Semi-automated rules

- **My session, not the agent's:** uses my normal browser profile where I logged in myself. My JobStreet / YC password is never given to or stored by the agent.
- **The agent never clicks submit.** The final click is always mine, one application at a time.
- **Human pace:** one application at a time, only while I'm at the screen. No batch runs, no background runs, no retries in a loop.
- **Stops on anything unexpected:** CAPTCHA, a login prompt, a changed form, or a question the answer bank doesn't cover -> stop and hand over to me.
- **Never on LinkedIn**, not even semi-automated.
- Remaining risk is low but not zero: it is still automation on my account, so watch for warnings from the site and stop if any appear.

**Shortcut before the full build:** use Claude Code with a Playwright MCP, or Claude in Chrome, to fill applications while I watch and approve.

---

## 7. Architecture

### Stack

- Node + TypeScript, Drizzle ORM on SQLite, Zod
- Hono backend, React + TanStack Query/Table dashboard
- Anthropic SDK: cheap, fast model for bulk extraction; stronger model only for fit scoring and drafting
- Playwright for applying and company research (never LinkedIn)
- Python worker running JobSpy, writing to the same SQLite file
- node-cron or system cron

### Repo structure

```
job-agent/
├── config/          PRIVATE (gitignored): cv.md, answers, salary, companies. Only *.example files are committed.
├── data/            sqlite db, logs
├── packages/
│   ├── core/        types, config loader, db schema, fx rates
│   ├── sources/     one adapter per source (ats/, web3career/, remote-boards/,
│   │                hn/, reddit/, threads/, search/)
│   ├── pipeline/    normalize, dedupe, filters, scam, pay-context, scoring, tiers
│   └── apply/       answer bank, form fillers per ATS, review queue
├── workers/jobspy/  python worker for LinkedIn + Indeed
└── apps/dashboard/  review queue, digest view, tracker
```

Every source adapter implements `fetch(since) -> RawPosting[]`. Adding a source = adding one adapter.

### Data model

| Table | Purpose |
|---|---|
| `companies` | name, domain, ATS type + slug, HQ country, company type, pay policy + source, verified flag |
| `postings` | source, external ID, URL, apply URL, title, description, location text, salary text, posted date, dedupe hash |
| `analysis` | location class, salary (IDR/month), pay context, tier, ask, scam score + reasons, fit score + reasons, decision |
| `applications` | state (`needs_input` -> `ready` -> `submitted`, or `manual`), answers used, submitted when and how |
| `answer_bank` | canonical question, approved answer, alternative phrasings |
| `unknown_questions` | questions waiting for my answer |
| `outcomes` | reply, screening, interview, rejection, offer, salary feedback |
| `salary_observations` | every posted salary with tier, seniority, region |
| `source_runs` | per run: source, found, new, errors (detect broken or blocked sources) |
| `fx_rates` | daily USD/IDR |

### Pipeline and schedule

| Stage | What happens | When |
|---|---|---|
| Discover (Tier 1) | ATS APIs, web3.career, remote boards, HN, Reddit | every 1-2 hours |
| Discover (Tier 2) | JobSpy: LinkedIn + Indeed, past hour, Worldwide + remote, Indonesia + remote; YC and JobStreet adapters | every 30-60 min, low volume |
| Discover (social) | Threads keyword search, search-engine queries for LinkedIn posts | every 3-4 hours |
| Company discovery | Search-engine queries on ATS domains | daily |
| Normalize + dedupe | Same job on LinkedIn and an ATS -> one record, ATS link preferred | each run |
| Rule filters | Location, salary floor, Indonesia rule | each run |
| LLM extraction | Pay context, scam signals | only postings that pass the rules |
| Scoring + tier | Fit score vs CV, tier, ask | same |
| Act | Queue, manual list, or auto-apply | same |
| Digest | Top matches + items needing input | daily, plus instant alerts for very strong matches |

Rules run before the LLM, so most postings (rejected on location) never cost an API call.

---

## 8. Build phases

| Phase | Scope | Done when |
|---|---|---|
| **1. Discovery MVP** | Tier 1 sources, normalize, dedupe, rule filters, SQLite, daily digest | A daily list of real, remote-eligible postings |
| **2. Intelligence** | Pay context, tiers, scam scoring, fit scoring, pay-policy registry, company discovery | Ranked digest, each posting shows why it scored what it did |
| **3. More sources** | JobSpy worker (LinkedIn, Indeed), YC and JobStreet adapters, Threads, LinkedIn posts via search | LinkedIn jobs appear within an hour of posting |
| **4. Review workflow** | Dashboard, review queue, answer bank, unknown-questions inbox | A day's matches processed in under 30 minutes |
| **5. Assisted applying** | Greenhouse / Lever / Ashby fillers in dry-run (fill, screenshot, don't submit), CAPTCHA -> manual; semi-automated filler for JobStreet and YC (fills in my logged-in browser, I submit) | 20-30 dry runs reviewed and correct; semi-automated fills correct on 10+ real forms |
| **6. Auto-apply + learning** | Submitting for fully covered forms, outcome tracking, tiers recalculated from data | Tiers based on real postings and outcomes |

---

## 9. To prepare

- [ ] CV as structured markdown (`config/cv.md`)
- [ ] Answer bank v1, all truthful: notice period, work authorization, relocation, time zone / working hours, years per skill, degree status, how I heard about the role
- [ ] Anthropic API key
- [ ] web3.career API token
- [ ] Meta developer app with Threads keyword search permission
- [ ] Search API key (Brave or similar)
- [ ] Seed company list (target companies + known remote-first ones)
- [ ] Digest channel: Telegram, email, or dashboard only (**open decision**)

---

## 10. Guardrails (from day one)

- No LinkedIn login or session cookies, and no automation of any kind on my LinkedIn account; conservative request rates on all Tier 2 sources.
- Semi-automated applying (JobStreet, YC) only in my own logged-in browser, never stores my credentials, never clicks submit.
- Salary answers and newly drafted answers go through the review queue until switched off per tier.
- Auto-apply starts in dry-run and only runs on forms fully covered by approved answers.
- Scam-flagged postings are never acted on automatically.
- Web3 take-home repos only in a disposable VM or container.
