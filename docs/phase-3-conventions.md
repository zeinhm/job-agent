# Phase 3 conventions (PM decisions, binding for Phase 3 cards)

Phase 3 = More sources (PLAN 8), preceded by the owner's carry-over items from the 2026-10-14 review of the Phase 2
live run. Done when (PLAN 8): **LinkedIn jobs appear within an hour of posting.**

Everything in `docs/phase-1-conventions.md` and `docs/phase-2-conventions.md` still applies (worktrees, HTTP client,
errors, Zod, fixtures, DB, LLM rules, the $1/day cap, QA FAIL loop) unless this file says otherwise. Changing anything
here takes a PM comment on the card plus a decisions.md entry. If a card and this file disagree, this file wins; if this
file and PLAN.md disagree, block.

## Order of work (owner decision 2026-10-14)
1. **Carry-over items first, in the owner's order:** location truth (+ time zones), apply link resolution, re-extraction
   of outdated extractions, `unknown_tier_ask`, a larger free title deny-list, a shorter digest, the product schedule
   with `.env` loading. Rules are free and every reject before the LLM saves money, so these land before volume grows.
2. **Then the PLAN Phase 3 sources:** JobSpy (LinkedIn, Indeed), YC, JobStreet, LinkedIn posts via search, Threads.
   Research cards for them start right after the gate (they write docs only), so dev cards can follow without waiting.

## Live runs and keys (unchanged, repeated because Phase 3 adds Tier 2 sources)
- Agents use `bin/smoke` (temp DB, example configs, public feeds, no API key) and `bin/smoke run <dir> <command...>`.
  Never env-prefixed commands (`JOB_AGENT_DB=... pnpm ...`). Never read `.env` or `config/`.
- **LinkedIn and Indeed (JobSpy) are not part of `bin/smoke` by default.** They run from the owner's home IP and a block
  hurts the owner. `bin/smoke --with-jobspy` (added by the JobSpy card) runs at most one LinkedIn and one Indeed search
  with `results_wanted <= 10`; agents use it only if the owner answers yes on the gate (question 5). Otherwise the owner
  runs it.
- No agent ever opens linkedin.com in a browser, logs in, or uses cookies. LinkedIn job access lives only inside the
  JobSpy dependency (AGENTS.md public-repo rule). LinkedIn *posts* come only from search-engine results: the product
  never fetches a linkedin.com URL itself.
- Real LLM runs (`enrich` with a key) are still done by the owner.

## 1. Location truth (owner item 1)
- **The posting text beats the source's region label.** A source label ("Anywhere in the World" on WWR, a Himalayas
  "Worldwide" tag) is only a hint.
- Rule filter (free, `filters/location.ts`, lists in `keywords.ts`): a description sentence that states a hiring
  restriction (e.g. "can only hire in", "only able to hire", "we hire in the following countries", "must be based in",
  "must reside in", "eligible to work in") **plus** at least one known country or region, none of which covers Indonesia
  (Indonesia, APAC, Asia, Southeast Asia, worldwide), is `restricted` even when the location field says worldwide. Same
  wording with a list that does cover Indonesia stays as it is. Hiring wording with a country list the rule cannot read
  for sure (unknown place names, "and more", mixed with timezone text) is `unclear` + `location_unclear`, never a reject.
  A rule reject is final, so golden rows must show both sides (Typeform-style restriction rejected, "we hire in the UK,
  Germany and Indonesia" kept, "we also have offices in London" kept).
- Resolve (code, from the extraction, `intel/resolve.ts`): for **every** kept posting, flag or not, if the extraction
  says `hiringScope` is `countries` or `region` and all named places are known not to cover Indonesia, the posting is
  rejected with the existing location reason, even when the rule class was `worldwide`. Unknown places settle nothing.
- **Time zones for a GMT+7 candidate** (PM proposal, owner confirms on the gate, question 2):
  - Residence wording ("must be located in a European time zone", "based in CET +/- 2", explicit ranges such as
    "UTC-1 to UTC+3") = a location restriction: `restricted` (existing step 2 behaviour for ranges stays).
  - Working-hours wording with no residence requirement ("overlap of 4 hours with CET", "work European business hours",
    "available during EST mornings") = kept. The extraction gains the facts `hoursZone` (`europe | americas | apac |
    other | unknown`) and `overlapHours` (number, 0 = not stated). Code decides:
    - Europe / Africa hours: keep, digest line `Hours: overlap <n> h with Europe (about 14:00-23:00 WIB)` (n or
      "business hours" when not stated).
    - Americas hours: keep only when the required overlap is at most 3 hours (`MAX_AMERICAS_OVERLAP_HOURS = 3`, one
      constant); a full Americas working day or more than 3 hours of overlap is rejected in resolve with the reason
      `Hours: needs <n> h overlap with the Americas, which falls in the WIB night.`
    - APAC / unknown: no effect.
  - Bare "Europe time zone" with no verb that tells residence from hours: rule `unclear`, the extraction settles it.

## 2. Apply link resolution (owner item 2)
- Aggregators (WWR, Himalayas, RemoteOK, Remotive, Arbeitnow, web3.career, and later LinkedIn, Indeed, JobStreet, YC
  listings, social posts) are **discovery sources only**. For each match the agent looks for the free apply route,
  cheapest first, and stops at the first hit:
  1. **Known ATS by company name + title match:** a canonical posting from an ATS source with the same normalized
     company + title already in the DB (free), else the company's known `ats_type`/`ats_slug`, else slug candidates
     from the company name tried against the public board APIs (Greenhouse, Lever, Ashby, SmartRecruiters, Workable,
     Recruitee). Title match = the existing dedupe title normalization; at most `MAX_SLUG_CANDIDATES = 3` slugs per
     company, each ATS host paced by the shared HTTP client; a company whose lookup found nothing is not re-checked
     for 30 days (`companies.ats_checked_at`).
  2. **Company careers page with embedded ATS detection:** the company's domain (`companies.domain`) `/careers` and
     `/jobs` (same fetch rules as company pay-policy research: max 2 pages per company, no LinkedIn, redirect host
     rules, 1 request per 2 s), scanned for ATS embeds and links (patterns from the research card). A found board is
     then matched by title as in step 1.
  3. **Apply links inside the posting text** (HN comments, social posts, descriptions that say "apply at ..."): an ATS
     job URL wins, else a link on the company's own domain.
  4. **Haiku only when unclear:** when steps 1-3 leave two or more candidate links and no ATS job URL, one Haiku call
     (purpose `apply_link`, under the $1/day cap, only for postings with `final_decision = keep` and fit >=
     `TOP_MATCH_MIN_FIT`) picks one of the given candidate URLs or none. The model can only choose from the list; it
     never invents a URL.
- **Apply types** (stored per posting): `ats` (an ATS job URL), `company_form` (an apply page on the company's own
  domain, or an e-mail address stated by the company), `paid_aggregator` (the only route found is a site that wants a
  payment or subscription to apply or to see the link), `unknown`. Never pay, subscribe, sign up or log in anywhere to
  find or follow a link.
- Storage: new table `apply_links` (one row per canonical posting: `posting_id` unique, `apply_url`, `apply_type`,
  `method` (`ats_db | ats_board | careers_page | posting_text | llm | source`), `ats_type`, `ats_slug`, `found_on`
  (source name of the discovery listing), `reason`, `checked_at`). `companies` gains `ats_checked_at`;
  `companies.discovered_via` gains `apply_resolve`; `llm_calls.purpose` gains `apply_link`. One migration, in the first
  apply card.
- **A found ATS is saved to `config/companies.yaml`** (owner decision): append-only, only a company name not already in
  the file, the original file is copied to `data/backups/companies.yaml.<timestamp>` first, existing lines and comments
  are kept byte for byte, each added entry carries the comment `# added by job-agent <YYYY-MM-DD> (apply resolve)`,
  written atomically (temp file + rename), and the file must still pass the config Zod schema afterwards (else restore
  the backup and log an error). The DB company row is updated too, so `discover` polls the board from the next run.
  Tests only ever write into temp dirs.
- Command: `pnpm job-agent resolve-apply [--limit n]`, run after `enrich` in the schedule. Free steps run for every
  kept canonical posting from a non-ATS source without an `apply_links` row (or with `unknown` older than 7 days).
- Digest: every Top match and Scored-not-a-fit line shows `Apply: <url> (<type>)` and `Found on: <source>`.
  `paid_aggregator` jobs stay listed and ranked by fit, with the label `(paid-only apply)`; they are never hidden.

## 3. Re-extraction (owner item 3)
- An intel row whose `extract_prompt_version` differs from the current `EXTRACT_PROMPT_VERSION` is outdated.
  `enrich` re-extracts outdated rows **after** all new postings in the same run (new postings first, budget permitting),
  only for canonical postings with rule decision `keep`, `final_decision` keep or reject (never suspicious rows from a
  full scam check), and `last_seen_at` within the last 14 days (`REEXTRACT_MAX_AGE_DAYS`). `--no-reextract` skips it,
  `--reextract-only` runs only it. After a re-extraction the posting runs resolve -> scam -> registry -> fit (only when
  no fit with the current fit prompt version is stored, or the decision changed from reject to keep) -> tier. Fit
  results with the current fit prompt are reused, never paid twice.
- The summary line counts re-extracted rows and their decision changes.

## 4. Unknown pay policy ask (owner item 4)
- `config/salary.yaml` gains an **optional** key `unknown_tier_ask: { ask_idr_month: <number> }`. The unknown branch
  and the US-legal-note branch of `decideTierAndAsk` use it instead of `tiers.regional`; the floor still always wins.
  Missing key: current behaviour (regional) plus one warning line per run
  `unknown_tier_ask not set in salary.yaml, using the regional ask` (no value printed).
- `config/salary.example.yaml` gets the key with a **placeholder fake value** in the same style as the other fake
  numbers. Nobody asks for, prints, writes or commits the real amount; the owner fills it in.

## 5. Title deny-list (owner item 5)
- More clearly non-engineering titles rejected by the free rule filter before any AI call, in `keywords.ts`, same rule
  order and engineer/developer-noun exemption as decisions 2026-10-09 (t_9a476254, t_fa75c44e). Evidence comes from
  `bin/smoke` kept titles (public feeds), never from the owner's DB. Golden rows for every addition and for the target
  titles that must still be kept.

## 6. Shorter digest (owner item 6)
- Drop the `Why:` line (the `why.ts` builder may stay for tests of other lines or be removed with its tests).
- `Location:` compresses long timezone/UTC-offset lists to their span (e.g. `UTC-8 to UTC+2 (9 zones)`) and caps the
  line at `MAX_LOCATION_CHARS = 120`.
- New `Type:` field from the extraction's `employment` (`employee`, `contractor`, `EOR`, or `unknown`).
- `Flags:` lists only flags still open after resolve (settled ones are dropped; `none` when all settled).
- "Waiting for scoring" entries are one line each: `- <title> — <company> — <status> — <link>`.

## 7. Schedule and `.env` (owner item 7)
- The CLI loads `<repo root>/.env` itself at start (`process.loadEnvFile`, no new dependency) when the file exists;
  variables already set in the environment win; a missing file is not an error; values are never logged or printed.
  Tests use a temp `.env`. Agents never create or read the real `.env`.
- `scripts/crontab.example` (and `docs/running.md`): one **hourly** line at :05 runs `discover`, `process`, `enrich`,
  `resolve-apply`, `digest` in that order with a lock (`mkdir`-based lock dir under `data/`, a run that finds the lock
  exits 0 with a skip line), so runs never overlap. `fx` and `discover-companies` stay daily. No keys in the crontab.
- Each adapter's own minimum poll interval still limits real requests (sources polled less often than hourly record
  `skipped` runs).

## 8. New sources
| Source name | Adapter | Access | Max rate (binding) |
|---|---|---|---|
| `linkedin` | `packages/sources/src/jobspy/` + `workers/jobspy/` | JobSpy, logged out, adaptive `hours_old` (last ok run + 10 min, 1 to 24 h) | 2 searches per hourly run (Worldwide + remote, Indonesia + remote), `results_wanted <= 25`, >= 10 s between searches, min poll interval 50 min |
| `indeed` | same | JobSpy | 2 searches per run (global remote, Indonesia remote), min poll interval 2 h |
| `yc` | `packages/sources/src/yc/` | public ycombinator.com job pages (research decides endpoint) | per research, never faster than 1 request / 3 s, page cap |
| `jobstreet` | `packages/sources/src/jobstreet/` | public search pages / endpoint (research decides) | per research, never faster than 1 request / 3 s, page cap |
| `linkedin_posts` | `packages/sources/src/linkedin-posts/` | Brave Search results only (`site:linkedin.com/posts`, past day) | `MAX_POST_QUERIES_PER_RUN`, min poll interval 3 h |
| `threads` | `packages/sources/src/threads/` | official Threads API, keyword search, RECENT | <= 60 queries per day (limit 500 per rolling 7 days) |

- **JobSpy worker:** Python, pinned `python-jobspy` version in `workers/jobspy/requirements.txt`, its own venv under
  `workers/jobspy/.venv` (gitignored). The TS adapter spawns `workers/jobspy/run.py` with JSON arguments, reads JSON
  lines from stdout, validates every line with Zod, maps to `RawPosting`. The worker writes nothing to SQLite (keeps
  one writer; deviates from PLAN 7 "writing to the same SQLite file" on purpose, recorded in decisions.md by the card).
  Missing Python / venv = `skipped` source run with a one-line reason, never a crash and never `ok` with 0 postings.
- **Blocks are errors, never empty results.** HTTP 429 / 999 / a CAPTCHA or login page from any Tier 2 source = source
  run `error` with the reason, then that source is skipped for `BLOCK_BACKOFF_HOURS = 6` (recorded `skipped` runs).
  Never retry in a loop, never rotate IPs or user agents to get around a block, never solve a CAPTCHA.
- Every new source adds its name where source lists live (dedupe ATS-vs-board preference, `isAtsSource`, company-domain
  board hosts, digest display title rule for title-less sources) in the same card. LinkedIn / Indeed / JobStreet / YC /
  social copies always lose to an ATS original in dedupe (PLAN 2 "prefers that link").
- Social posts (`threads`, `linkedin_posts`) have no reliable title: the digest uses the extracted `roleTitle` for them
  as it does for `hn`.

## Freshness (the Phase 3 "done when")
- LinkedIn guest search filters on "posted in the last N hours", where N is the lookback since the last ok run plus 10 min
  (1 to 24, decisions.md 2026-10-14 adaptive lookback); the hourly schedule therefore makes a
  LinkedIn posting appear in the DB within about one hour. Proof = consecutive successful `linkedin` runs no more than
  65 minutes apart over a day, plus `first_seen_at` of postings found. The digest's Source health line for `linkedin`
  and `indeed` shows `last ok <hh:mm>, max gap <n> min in 24h`.

## Merge hotspots
`keywords.ts` (location truth, deny-list), `resolve.ts` (location truth, time zones), `prompts/extract.ts` +
`extract.ts` (time zones, then re-extraction relies on the version), `enrich.ts` (re-extraction), `digest/index.ts`
(shorter digest, then apply lines, freshness line), `registry.ts` and `dedupe/index.ts` (every source), `cli.ts`
(resolve-apply, `.env`), `schema.ts` (apply schema). Cards that share a hotspot are chained in the backlog; keep every
existing entry when resolving conflicts.
