# Running the pipeline (Phase 1 to Phase 4)

How to run the pipeline on your Mac: find remote postings (Phase 1, more sources in Phase 3), filter them with rules,
score them with the LLM stages and write a ranked daily digest (Phase 2), and find the free apply link for each match
(Phase 3), then review the day's matches in a local dashboard and keep an answer bank (Phase 4, see "Dashboard and
review flow"). Everything runs hourly from cron (see "Schedule with cron"). It only reads public job feeds, calls the
Anthropic API for the LLM stages, and writes local files. It never applies anywhere: "applied" in the dashboard only
records what you did by hand.

## Prerequisites

- Node.js LTS (the repo declares `node >= 24` in `package.json` `engines`)
- pnpm (the version pinned in `package.json` `packageManager`; `corepack enable` picks it up)
- git

## Install

```sh
git clone <repo url> job-agent
cd job-agent
pnpm install
```

`pnpm install` also activates the pre-commit hook (`git config --get core.hooksPath` prints `.githooks`).

## Config files

`config/` is private and gitignored. The pipeline reads three files from it. Start from the example files and put your own
values in the copies; never commit them:

```sh
cp config/salary.example.yaml config/salary.yaml
cp config/companies.example.yaml config/companies.yaml
cp config/cv.example.md config/cv.md
```

| File | Used by | What it holds |
|---|---|---|
| `config/salary.yaml` | `process` | `floor_idr_month`: postings whose listed max is below it are rejected (plus later-phase fields) |
| `config/salary.yaml` `unknown_tier_ask` | `enrich`, `process --reprocess` | Optional `unknown_tier_ask: { ask_idr_month: <number> }`: your ask when a company's pay policy is unknown (including a US pay-transparency range). The floor still applies. Missing: the regional ask is used and each run prints one warning line `unknown_tier_ask not set in salary.yaml, using the regional ask` (no value). The tier label stays `regional`; the stored `ask_reason` says `ask from unknown_tier_ask` or `ask from regional (unknown_tier_ask not set)` |
| `config/companies.yaml` | `discover` | companies whose ATS boards are polled (`name`, `ats`, `slug`) |
| `config/cv.md` | `enrich` | your CV in Markdown, used by the fit-scoring stage |

`config/cv.example.md` is a fake persona; replace the copy's content with your own CV. `cv.md` is **sent to the
Anthropic API** for fit scoring (that is what the stage is for). It is never logged or committed. If it is missing,
`enrich` prints `cv.md not found in the config dir, fit scoring skipped (extraction still runs)` and carries on
without fit scores.

`config/README.md` lists every example file. `answers.yaml` (copy `config/answers.example.yaml`; see "Answer bank") is read only by `answers import`;
`private-patterns.txt` is used by the pre-commit hook.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `JOB_AGENT_DB` | `data/job-agent.db` | SQLite database file |
| `JOB_AGENT_CONFIG_DIR` | `config` | Folder holding `salary.yaml` and `companies.yaml` |
| `WEB3_CAREER_TOKEN` | (none) | API token for the web3.career source. Without it, that source shows `error` in Source health; the other sources still run |
| `ANTHROPIC_API_KEY` | (none) | Anthropic API key for the LLM stages of `enrich`. Without it `enrich` prints `ANTHROPIC_API_KEY not set, LLM stages skipped`, makes no calls and exits 0; postings stay `pending` and the digest lists them under Waiting for scoring |
| `BRAVE_API_KEY` | (none) | Brave Search API key for `discover-companies` and the `linkedin_posts` source. Without it `discover-companies` prints `BRAVE_API_KEY not set, company discovery skipped` and exits 0, and `linkedin_posts` records a `skipped` run with that reason |
| `JOB_AGENT_BRAVE_USAGE` | `brave-usage.json` next to the database | Path of the Brave request counter file (see "LinkedIn hiring posts") |
| `JOB_AGENT_ENV_FILE` | `<repo root>/.env` | Env file the CLI loads at start (see "Schedule with cron"); `bin/smoke` sets it to `/dev/null`. Set it in the shell, not inside `.env` |
| `JOB_AGENT_LLM_CAP_USD` | `1` | Daily LLM spend cap in USD. It can only **lower** the cap (see "LLM cost cap") |

Never put a key or token in a committed file. Put them in the repo's `.env` (git-ignored; the CLI loads it itself,
variables already set in the environment win) or in your shell profile. `.env.example` lists the names with empty values (the path overrides `JOB_AGENT_DB`, `JOB_AGENT_CONFIG_DIR` and
`JOB_AGENT_BRAVE_USAGE` are commented out there: an empty value in `.env` would be used as an empty path). Internal
switches that tests and scripts set (`JOB_AGENT_CLI`, `JOB_AGENT_DATA_DIR`, `JOB_AGENT_JOBSPY_SMOKE`) are not
settings; leave them alone.

## Sources

`discover` polls these sources. Each has a minimum poll interval enforced in code; a source polled too recently is
recorded as `skipped` and gets no request, so the hourly cron never sends extra requests.

| Source (`--source`) | Key or token | Min poll interval |
|---|---|---|
| `greenhouse`, `ashby` | none (companies from `companies.yaml` and the database) | 60 min |
| `lever` | none | 60 min |
| `recruitee`, `workable`, `smartrecruiters` | none | 6 h |
| `himalayas`, `weworkremotely` | none | 60 min |
| `remoteok` | none | 4 h |
| `remotive`, `arbeitnow`, `hn` | none | 6 h |
| `web3career` | `WEB3_CAREER_TOKEN` (without it the run is an `error`) | 5 min |
| `linkedin` | none; needs the JobSpy worker (see "LinkedIn and Indeed through JobSpy") | 50 min |
| `indeed` | none; needs the JobSpy worker | 2 h |
| `linkedin_posts` | off by default; `sources.linkedin_posts: true` in `companies.yaml` and `BRAVE_API_KEY` (without the key the run is `skipped`) | 3 h |

### LinkedIn hiring posts (`linkedin_posts`) and Brave cost

**Disabled by default** (Brave does not index linkedin.com/posts, so it only used up the Brave cap). It makes no Brave
request and Source health shows `disabled` until `companies.yaml` has a `sources:` block with `linkedin_posts: true`.
Everything below applies only when it is switched on.

`discover --source linkedin_posts` runs 4 Brave queries per run (`MAX_POST_QUERIES_PER_RUN`, `freshness=pd`, rotating
through 5 `site:linkedin.com/posts hiring ...` queries) and polls at most every 3 hours. It never requests a
linkedin.com or lnkd.in URL (the HTTP client refuses those hosts); it only reads Brave's result list. Per the owner's
storage choice (docs/decisions.md) it stores the post URL and facts derived by plain code (role wording, remote,
region, company if stated), never the Brave title or snippet.

- **Requests per day:** 8 runs x 4 queries = 32 for posts, plus up to 12 for `discover-companies` = 44 wanted.
  A **hard cap of 30 Brave requests per UTC day, all callers together**, is enforced (counter file
  `brave-usage.json` next to the database, in gitignored `data/`; `JOB_AGENT_BRAVE_USAGE` overrides the path). When the
  cap is reached `linkedin_posts` records a `skipped` run (`Brave daily request cap (30) reached, skipping`) and
  `discover-companies` prints the same line and stops. Run `discover-companies` rarely, or it uses cap that posts need.
- **Cost:** Brave Search is $5 per 1,000 requests with a $5 monthly credit (research t_788d14a9 section 4). At the cap,
  30/day = about 900/month = $4.50, inside the credit; the uncapped 44/day plan would be about $6.60 (about $1.60 over).

## Commands

Run from the repo root as `pnpm job-agent <command>` (add `-s` to hide pnpm's own banner).

| Command | What it does |
|---|---|
| `answers import` | Loads `config/answers.yaml` (`<group>: <key>: { answer, approved, question?, alternatives?, type?, choices? }`, strict: an invalid file exits 1 and names the key path, never a value) and upserts every entry into the `answer_bank` table as `source = config`, key `<group>.<key>`. A row last edited in the dashboard is never overwritten (`kept dashboard version: <key>`). Entries removed from the file stay in the DB. A missing file prints `answers.yaml not found, answer bank empty`. Prints `answers import: <n> added, <n> updated, <n> unchanged, <n> kept`; a re-run with no change is a no-op. Never prints answer text. |
| `fx` | Fetches today's USD exchange rates (IDR, EUR, GBP, SGD, AUD, CAD, CHF) and stores them. Salaries are converted with the latest stored rate on or before the analysis date, so run it daily. Without a stored IDR rate, `enrich` parks kept postings as `fx_wait` (digest: "Waiting for scoring"); after `fx` the next `enrich` tiers them without any LLM call. |
| `discover [--source <name>] [--force]` | Polls every source that is due and stores new postings. Each source has a minimum poll interval enforced in code; a source polled too recently is recorded as `skipped` and gets no request. `--source` runs one source (see "Sources"); `--force` ignores the interval (manual use only). Exits 1 if any source errored. |
| `discover-companies` | Finds new companies to poll: runs a fixed list of 12 web searches (Brave Search API, at most 20 requests per run, one every 2 seconds) for Greenhouse, Lever, Ashby, SmartRecruiters, Workable and Recruitee board URLs, checks each new board with one request and stores it in the database (`verified` only if the board answered). Companies already known are skipped. The search part needs `BRAVE_API_KEY` (without it: `BRAVE_API_KEY not set, search discovery skipped`). Prints `discover-companies: <q> queries (<n> failed), <c> candidates, <v> new verified, <n> not found, <k> known, <e> verify errors`. Exits 1 if every search query failed (an error line says so). Run it weekly (Monday 07:00 WIB in `scripts/crontab.example`); the next `discover` polls the verified companies. Companies already stored with `discovered_via = yc_directory` stay and are polled through their own ATS APIs; nothing reads ycombinator.com. |
| `process [--reprocess]` | Normalizes and dedupes new postings, then applies the rule filters (location, Indonesia rule, role, salary floor, language) and records keep / reject with flags. Prints the counts. `--reprocess` also re-applies the current rules to every stored posting; see "Reprocessing after a rule change". |
| `fetch-descriptions [--force]` | Fetches the description of LinkedIn postings that have none (first the text of the same job on a company ATS board in the DB, no request; then the one job the apply link names on Greenhouse, Lever, Ashby, Workable or Recruitee, from that ATS's public API, no LinkedIn request; then JobSpy detail requests, only for postings with no ATS job link: at most 3 per run, 45 s apart, newest first, only postings first seen in the last 24 h, at most 3 attempts per posting), only for those whose title passes the role rule and whose own location text is not restricted; re-runs the rules for each posting that got its text. Skipped while the linkedin search backoff or the details-only backoff holds (`--force` does not lift it); a block on a detail request starts only the details backoff (6 h), never the search's. Prints `fetch-descriptions: requested <n>, fetched <n> (rejected by the rules <n>), failed <n>, from the ATS board <n> (missed: ...), from the ATS link <n> (failed <n>), older than 24 h and never requested <n>, left for the next run <n>`. Exits 1 after a block or a worker error. Details in "LinkedIn and Indeed through JobSpy". |
| `resolve-apply [--limit <n>]` | Finds the free apply link for kept postings from aggregator sources (not ATS sources) that have no link yet (or an `unknown` one older than 7 days), newest first. The free steps need no key. Order: an ATS posting already in the DB with the same company and title (`ats_db`), the company's stored ATS board (`ats_board`), then up to 3 slug guesses from the company name on the 6 ATS board APIs (at most 18 requests per company, a company with no result is not searched again for 30 days). A found board is saved on the company (`discovered_via = apply_resolve`, verified) so `discover` polls it. Stores the link in `apply_links` (`apply_type` `ats` or `unknown`; `unknown` keeps the source link). **Last step, one Haiku call (purpose `apply_link`, prompt `apply-link-v1`):** only for a posting with `final_decision = keep` and fit >= 60 whose text holds two or more candidate links (max 10, the posting's own listing and LinkedIn links excluded) and no ATS job URL after the free steps. Haiku sees the title, company, the numbered links with their link text and up to 2,000 characters of posting text around them, and answers a link number (0 = none) plus a kind; code stores that exact URL with `method = llm` (it never takes a URL from the model; an out-of-range number counts as none). One call per posting ever: a stored `llm` row is final until the posting text changes in `discover`. Cost bound: at most about $0.0005 reserved per call against the $1/day cap (`max_tokens` 64), i.e. below $0.05 for 100 calls. No key: the step is skipped with one line and those postings stay for a later run; budget used up: the step stops for the run (`deferred N` in the summary) and the rest stay too. Prints `resolve-apply: checked N, methods: ..., llm L; types: ...; requests R` (`llm L` and `deferred N` appear only when they apply). Exits 1 only for an invalid `--limit` or a posting that failed unexpectedly. Run it after `enrich`. Afterwards every verified `apply_resolve` company that is not yet in `companies.yaml` is appended to it (see "Automatic additions to companies.yaml" below); that can also make the exit code 1. |
| `fetch-questions [--limit <n>]` | Stores the application questions of kept postings (canonical, `final_decision = keep`, still open: not interested / applied / interested by the owner means no fetch; `later` stays open) whose apply link is an ATS job, in `posting_questions`. Read-only public GET endpoints, no key: Greenhouse `boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true` (EEOC / demographic blocks are not stored), Workable `apply.workable.com/api/v1/jobs/<shortcode>/form` (undocumented endpoint, tolerated like the widget), Recruitee `<board>.recruitee.com/api/offers/` (one request per board per run, infoboxes are not questions). Lever, Ashby, SmartRecruiters and the link-only vendors have no public questions endpoint and are skipped (`no public questions endpoint`, no request). ATS-source postings (from `greenhouse`, `workable`, `recruitee` polls) count as ATS without an `apply_links` row. Paced 1 request per 2 s per host; at most 50 fetches per run unless `--limit` says less (skipped postings do not count). A host that answers 401, 403 or 429 gets no more requests this run (`deferred`). Questions are fetched once, again after 7 days or when the posting's `updated_at` is newer; a 404 (job closed) keeps the stored questions; every run ends with the same matching as `match-questions` (a stored key never survives it, keys are recomputed). A response that does not match the expected shape is an error line `fetch-questions: error <posting id> <ats>: ...` for that posting (nothing stored), never an empty list. Prints `fetch-questions: selected N, attempted M`, one line per ATS (`fetched`, `questions`, `closed`, `skipped`, `deferred`, `errors`), the skip reasons, and `matched C covered, M need a choice mapping, S salary, U unknown (W wordings)` and `requests R`; never question text. Exits 1 for an invalid `--limit` or any error line. Run it after `resolve-apply`. A Greenhouse job behind a company career page (`https://<company page>/...?gh_jid=<digits>`) is handled too: the job id is the digits of `gh_jid` (a `/jobs/<id>` path wins), read from the posting's effective apply link (`apply_links.apply_url`, which holds the owner's correction, then `postings.apply_url`, then `url`). The board is the slug stored on the posting's `apply_links` row, then the company's Greenhouse board in the companies registry; only when neither exists does the command look it up: up to 5 candidate slugs (company-name guesses, then the career page's host name) are each checked with `GET boards-api.greenhouse.io/v1/boards/<slug>/jobs/<gh_jid>` (200 and the same job id = verified; redirects are not followed). A verified slug is stored on the `apply_links` row (and as the company's board when the company has none), so it is looked up once. A lookup counts toward the 50 fetches per run. When no candidate verifies, the posting is skipped with `greenhouse board not found for gh_jid` (never a guessed slug) and counted apart from `skipped` on the line `<ats>: career-page links: board found N, board not found M`. |
| `match-questions` | Matches every stored question (`posting_questions`) against the approved answer bank in plain code: normalized wording (case, punctuation, whitespace, trailing `?` / `*` ignored) equal to an approved answer's `question` or one of its `alternatives` sets `matched_key` to the answer key; standard ATS fields (name, e-mail, phone, resume, cover letter, LinkedIn) get `standard.<field>`; any salary or pay wording gets `salary` and is never answered from the bank. Unapproved answers cover nothing. The rest is upserted into `unknown_questions` (one row per normalized wording: `posting_count`, first / last seen from `fetched_at`). Everything is recomputed, so an answer that became unapproved un-covers its questions and a re-run changes nothing; an open inbox row whose wording is now covered is removed, a decided one (answered, linked, dismissed) stays with count 0. No fuzzy or LLM matching. A choice or multi-choice question (stored options) matched to an approved answer is covered only when the owner has also approved a choice mapping for (answer key, normalized wording, option-set hash); until then it counts as `need a choice mapping` and shows in the dashboard Inbox with the form's options and a picker (nothing is mapped automatically; salary questions never get a mapping; an option set that changes is a new mapping; any change that clears an answer's approval also clears its mappings' approval, the Answers tab lists them and can remove one). The queue shows `covered/total` per posting. Prints `match-questions: N questions, C covered, M need a choice mapping, S salary, U unknown (W wordings), X changed`; never question text. Run it after `answers import` or any change of approval; `fetch-questions` runs it itself. |
| `enrich [--limit <n>] [--no-reextract \| --reextract-only]` | Runs the LLM stages on kept postings, newest first, one posting at a time: extract facts (Haiku) -> resolve unclear flags -> scam score -> pay-policy registry -> fit score against `config/cv.md` (Sonnet, only for postings that were kept) -> tier and salary ask. Postings already done are not redone. `--limit` caps how many postings this run handles (new and re-extracted together). `--no-reextract` skips the re-extraction below, `--reextract-only` runs only it (the two cannot be combined). Prints `enriched <n>, budget_wait <n>, failed <n>, spent $<x> today`. Exits 0 except for an invalid `--limit`. Details below. |
| `review-stats [--date YYYY-MM-DD]` | Phase 4 done-when measurement for a day (default: today in Asia/Jakarta). Prints counts and times only: matches (Top + Suspicious, plus the postings reviewed that day that left the queue because of the review), processed, open, first/last review time, elapsed minutes, median seconds per processed posting (gap to the review action before it), actions and `not_interested` reasons recorded that day, ask checks per tier (ok / too_high / too_low, total against 20, counted over all days up to the date), and the last line `done-when: <elapsed> min for <n> matches (<met\|not met>)`; met = at least one match, all processed, elapsed <= 30. The same numbers, plus the last 7 days, are in the dashboard Stats tab and `GET /api/stats?date=`. |
| `eval-export-reviews` | Writes your own fit eval set from your reviews to `data/eval/reviews-<date>.json` (same as `pnpm --filter @job-agent/pipeline eval:export-reviews`). `interested` and `applied_manually` count as expected high, `not_interested` with reason role, stack or seniority as expected low, every other reason is skipped. `--since YYYY-MM-DD` keeps reviews from that Asia/Jakarta day on. The file holds posting text and is never committed. Prints only the path and counts. Refuses an `--out-dir` inside the repository outside `data/`. |
| `seed-demo [--date YYYY-MM-DD]` | Dev tool: writes a fake day (made-up companies on `example.com`, postings, analysis, intel with fit scores and scam reasons, one apply link per apply type, ATS questions, a few answers, two fake dry runs: one `filled`, one `needs_input`, no screenshot) into the database so the digest and dashboard have Top matches, Needs a look, Suspicious and Waiting for scoring rows without an API key. Default date: today in Asia/Jakarta. Idempotent per date. Refuses (exit 2, `seed-demo: refusing to write <reason>`) when `JOB_AGENT_DB` is unset or its real path (symlinks resolved) is `data/` or anywhere under it, and refuses (exit 1, nothing written) a database holding any posting whose id does not start with `demo-`, so it only seeds a fresh or demo-only scratch DB: `bin/smoke --demo` seeds before discover, and `bin/smoke run <smoke dir> seed-demo` on a smoke dir that already has public postings is refused. |
| `dry-run <posting-id> [--headless]` / `dry-run --fixture greenhouse` | Phase 5, owner-run. Fills the posting's Greenhouse form (apply link must be a Greenhouse job link, posting not scam-flagged, questions stored by `fetch-questions`; Lever and Ashby job links work too, see their sections, and need no stored questions) from the fill plan, screenshots it into `<data dir>/dryruns/` and records the run and its fields; **never submits**. Headed (a visible window) unless `--headless`. Prints one line `dry-run: status=<status> reason=<reason or -> fields=<filled>/<total> screenshot=<path>`, never a value. Only on the real database. `--fixture greenhouse` runs the committed synthetic form from 127.0.0.1 with a fake persona, only on a scratch DB (`bin/smoke run <dir> dry-run --fixture greenhouse`). Details and what to check: "Greenhouse dry run (Phase 5)". Exits 1 on a refusal or an error. |
| `status` | Prints the row count of every table and the latest run (status, found, new, error) per source. Read-only. |
| `digest [--date YYYY-MM-DD] [--out-dir <dir>] [--include-unpaid]` | Writes `data/digests/<date>.md` (or into `--out-dir`) with the kept postings not yet sent in an earlier digest, plus Source health and LLM spend, and prints the file path. Sections: Top matches (fit-scored at 60 or more, ranked, no why line; see "Reading the ranked digest"), Scored, not a fit (fit-scored below 60, one line each), Waiting for scoring (no intel yet, budget wait, failed or no fit score), Needs a look, Suspicious, Source health, LLM spend (today's cost vs the cap, calls per model). Without an `ANTHROPIC_API_KEY` every kept posting sits under Waiting for scoring. `--include-unpaid` appends one last section, Volunteer / unpaid, listing postings rejected as unpaid, volunteer or equity-only in the last 24h (title, company, pay type, location, link, posted date); they are not fit-scored, and without the flag the digest is unchanged. Default date: today in Asia/Jakarta. Re-running for the same date rewrites the same file and adds postings kept since. Each Top match shows `- Apply: <url> (<apply_type>)` from the `apply_links` row of the entry's lead posting (types `ats`, `company_form`, `paid_aggregator`, `signup_required`, `unknown`) and `- Found on: <source> — <listing url>`; without a row it shows the posting's own link as `(unknown, not resolved yet)`. A `paid_aggregator` job keeps its fit-based rank and section, with ` (paid-only apply)` after the title. Scored-not-a-fit and Waiting lines end with the apply URL when one is resolved. |

### Reprocessing after a rule change

Rule changes (filters, resolve rules, role families) only reach new or edited postings. After pulling such a change, run:

```sh
pnpm job-agent process --reprocess
```

It first runs the normal `process`, then, for every canonical posting, re-runs the rule filters (replacing the `analysis` row, keeping `digested_at`) and, for every posting with a stored extraction, the resolve rules. Nothing is deleted and nothing is paid: no LLM call, no network call, no `ANTHROPIC_API_KEY` needed. Suspicious rows stay suspicious (scam is not re-scored). A row that moves to `keep` and has no fit (or scam) result becomes `pending` for the next `enrich`, which reuses the stored extraction if its prompt version still matches; a row that moves to `reject` keeps its paid data. Tiers of kept, fit-scored rows are recomputed from the stored FX rates. It is safe to repeat: a second run right after prints all zeros. The last line reads:

```
reprocessed N postings: rules keep->reject A, reject->keep B; resolve keep->reject C, reject->keep D; now pending for enrich E
```

What it does not do: no re-extraction. An old extraction keeps its old facts, so a posting extracted before the role family or role title existed keeps a null family / title (no family reject) until it is extracted again. Exits 1 if any posting failed (reported on stderr; the rest are still processed).

A first manual run:

```sh
pnpm job-agent fx
pnpm job-agent discover --source remotive
pnpm job-agent process
pnpm job-agent enrich      # needs ANTHROPIC_API_KEY, otherwise it only prints a skip line
pnpm job-agent digest
```

Optional, once a week, to grow the company list (needs `BRAVE_API_KEY`): `pnpm job-agent discover-companies`, before
`discover`.

## Dashboard and review flow

Phase 4 adds a local web dashboard for the day's matches. Nothing in it applies, signs up or contacts anyone.

### Start the dashboard

```sh
pnpm dashboard              # prints: dashboard: http://127.0.0.1:4510/
pnpm dashboard --port 4600  # another port
pnpm dashboard --self-check # starts on a free port, requests /api/health and /api/queue, prints one line each, exits
```

Open the printed URL. It listens on **127.0.0.1 only** (there is no flag or variable to open another interface), reads
the same database as the CLI (`JOB_AGENT_DB`, default `data/job-agent.db`) and refuses requests with a foreign `Host`
or `Origin` header. Stop it with Ctrl-C. A busy port prints `dashboard: cannot listen on 127.0.0.1:<port> (<code>)` and
exits 1. The page is the web build in `apps/dashboard/dist/web` (`pnpm build:web`; `pnpm check` builds it too). The
cron run and the dashboard write the same SQLite file; it runs in WAL mode, so both can be active at once.

To try it without real data, seed a throwaway database: `bin/smoke --demo` (a fresh smoke dir, seeded before discover), then
`bin/smoke dash <smoke dir>`.

### Tabs

- **Queue**: the day's matches (Asia/Jakarta date; a date picker shows earlier days). Sections as in the digest: Top
  matches, Needs a look, Suspicious, Waiting for scoring. One row per posting with fit, tier, ask, apply type, review
  state and `covered/total` application questions. Click a row for the detail panel (fit reasons, flags, scam reasons,
  description, review history, actions). "Open only" hides what you already processed.
- **Answers**: the answer bank (see "Answer bank").
- **Inbox**: questions no approved answer covers (see "Unknown-questions inbox").
- **Stats**: the done-when numbers (see "Done-when check").

### Review flow and keyboard keys

Work down Top matches first. The header shows `<n> of <m> processed` and an elapsed timer that starts at the day's
first review action (not at page load). Keys act on the ticked rows when any are ticked (bulk, one transaction), else
on the selected row; after a status action the selection moves to the next open row. Keys are ignored while you type in
a field. `?` lists them in the page.

| Key | Action |
|---|---|
| `j` / `k` | next / previous posting (rank order, section by section) |
| `o` | open the apply link in a new tab (http and https only) |
| `i` | `interested` |
| `a` | `applied_manually` |
| `l` | `later` |
| `x`, then `1`-`9` or `0` | `not_interested` with a reason: 1 location, 2 timezone, 3 role, 4 seniority, 5 stack, 6 salary, 7 company, 8 domestic company, 9 language, 0 expired. Any other key cancels |
| `s` | `scam` |
| `u` | undo the last action (offered for 10 s; appends a restoring row, history is kept) |
| `?` / `Esc` | show or hide the key list / cancel |

`duplicate`, `scam_suspected` and `other` have no key: use the detail panel or the bulk bar (`other` needs a note).

Actions (each is one appended row in `reviews`; the newest status row is the posting's state):

| Action | Meaning | Extra |
|---|---|---|
| `interested` | shortlisted, you apply by hand | none |
| `applied_manually` | you applied outside the tool | none |
| `not_interested` | skip | reason (required) |
| `later` | look again tomorrow, stays in the queue | none |
| `wrong_apply_link` | stored apply link is wrong | corrected URL (optional) |
| `pay_policy` | the company's pay policy is known | `location_agnostic` or `location_adjusted` |
| `scam` / `not_scam` | your scam verdict (stored for learning, `final_decision` does not change) | none |
| `ask_ok` / `ask_too_high` / `ask_too_low` | check of the salary ask, 20 per tier is the target | none |

`not_interested` reasons: `location`, `timezone`, `role`, `seniority`, `stack`, `salary`, `company`,
`domestic_company`, `language`, `duplicate`, `expired`, `scam_suspected`, `other`. A posting counts as **processed** once
it has `interested`, `applied_manually` or `not_interested`; `later`, corrections, ask checks and scam verdicts do not
count. A corrected apply link is stored with `method = owner` (`resolve-apply` never overwrites it); a pay policy
updates the company and recomputes tier and ask for its kept postings (no LLM, no network).

### Answer bank

`config/answers.yaml` (private; start from `config/answers.example.yaml`) holds your standard application answers:

```yaml
profile:
  full_name:
    answer: Alex Example
    approved: true
work:
  notice_period:
    answer: 2 weeks
    approved: true
    question: What is your notice period?
    alternatives: [How soon can you start?]
    type: text
```

| Field | Required | Meaning |
|---|---|---|
| `<group>.<key>` | yes | the entry key, e.g. `work.notice_period` |
| `answer` | yes | the answer text |
| `approved` | yes | only approved answers ever count as covering a question |
| `question` | no | the canonical wording of the question |
| `alternatives` | no | list of other phrasings of the same question |
| `type` | no | `text`, `long_text`, `yes_no`, `number` or `choice` |
| `choices` | no | the allowed values when `type` is `choice` |

- `pnpm job-agent answers import` loads the file into the database (see Commands). Run it after editing the file.
- Edits in the dashboard (Answers tab: edit text and question wording, tick approved, add or remove alternatives, add an
  answer) **stay in the database**; the product never writes `config/`. A row last edited in the dashboard is not
  overwritten by a later `answers import` (`kept dashboard version: <key>`).
- **Export YAML** in the Answers tab writes the whole bank to `data/exports/answers-<date>.yaml` (gitignored; the page
  shows the path and count). Copy what you want back into `config/answers.yaml` by hand.
- Matching is plain code on normalized wording (case, punctuation, whitespace, trailing `?` and `*` ignored); no fuzzy
  or LLM matching. Salary questions are never answered from the bank: they use the posting's tier ask and stay in
  review. Nothing is approved automatically.
- Answers are personal data: they stay in `config/` and `data/`, never in a commit.

### Unknown-questions inbox

`fetch-questions` stores the application questions of kept ATS postings (Greenhouse, Workable, Recruitee; see Commands)
and matches them against the approved answers. Questions nothing covers appear in the **Inbox** tab, one row per
wording with the number of postings that ask it and a few example postings. Per row:

- **Answer**: pick group, key, type and answer (tick approve to approve it at once); it is stored as a dashboard answer.
- **Link to existing**: add the wording as an alternative phrasing of an existing answer (search by key or wording).
- **Dismiss**: stop asking about it.

After each action the open postings are re-matched, so the queue's `covered/total` and the inbox update at once.
Salary-type questions show "Answered by the tier ask, stays in review" and can only be dismissed.

`fetch-questions` runs in the hourly run (`bin/run-hourly`: `discover`, `process`, `fetch-descriptions`, `enrich`, `resolve-apply`,
`fetch-questions`, `digest`), at most 50 fetches per run, so the inbox fills by itself. Run
`pnpm job-agent match-questions` by hand after changing approvals outside the dashboard.

### Eval commands (owner-run, cost money)

`pnpm --filter @job-agent/pipeline eval:extract` and `eval:fit` call the real model only with `--live` **and**
`ANTHROPIC_API_KEY`; otherwise they print what they would run and exit 0. Spend counts against the $1/day cap and
`--max-usd` (default and ceiling 0.50). `pnpm job-agent eval-export-reviews` (or `eval:export-reviews`) builds your own
fit set from your reviews into `data/eval/`, which you score with `eval:fit --set <file> --live`. Details are under
"Eval scripts". Agents never pass `--live`.

### Done-when check

Phase 4 is done when a day's matches are processed in under 30 minutes. Review one real day, then:

```sh
pnpm job-agent review-stats                  # today, Asia/Jakarta
pnpm job-agent review-stats --date 2026-10-16
```

The last line reads `done-when: <elapsed> min for <n> matches (<met|not met>)`: met means at least one match, all
processed and elapsed (first to last review action) at most 30 minutes. The Stats tab shows the same numbers, the median
seconds per posting, action and reason counts, ask checks per tier and the last 7 days.

## LLM stages and cost cap

`enrich` is the only command that calls the Anthropic API. It uses `claude-haiku-5-5` for extraction and company
research and `claude-sonnet-5-5` for fit scoring only. The model only extracts facts and gives the fit score with its
reasons; keep / reject, scam score, tier and ask are decided by plain code.

- **Hard cap: $1.00 per day** (Asia/Jakarta day). Before every call the client reserves the worst-case cost; if
  today's spend plus that reserve would pass the cap, the call is not made. The real cost of every call is recorded in
  the `llm_calls` table. A call that failed with an API error response (400, 401, 429, 529, ...) is billed nothing and
  is recorded at $0; a timeout (request sent, tokens unknown) is recorded at the reserved worst case so the cap holds.
- **Failed calls are logged**: each failed attempt writes an `llm call failed` log line with `status`, `error_type` and
  `error_message` (key redacted, 300 characters at most). When `enrich` stops after 3 API errors in a row, the stderr
  line ends with the last error, e.g. `enrich aborted after 3 consecutive API errors: status 400 invalid_request_error: Your credit balance is too low ...`.
- **Every answered call logs its stop reason**: the `llm call` line has `status`, `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cost_usd` and `stop_reason` (`end_turn`, `max_tokens`, `refusal`, ...). Invalid output adds one
  `llm output invalid` warn line with `model`, `purpose`, `posting_id`, `stop_reason`, `output_tokens`, `max_tokens` and
  `issues` (Zod paths and codes, never the model's text). The same facts end up in `intel.resolved_reasons`, e.g.
  `fit stop_reason:max_tokens`, `fit output_tokens:1536`, `fit max_tokens:1536`.
- **Lower the cap** with `JOB_AGENT_LLM_CAP_USD`, e.g. `JOB_AGENT_LLM_CAP_USD=0.25 pnpm job-agent enrich`, or
  `JOB_AGENT_LLM_CAP_USD=0.25` in your `.env`. The variable can only lower the cap: a value above 1
  is ignored with a warning and the cap stays at $1.00; a value that is not a number is ignored too. `0` makes no
  calls. Raising the cap means changing `DAILY_LLM_CAP_USD` in the code, which is the owner's decision.
- **When the cap is reached**, `enrich` stops calling the API. The postings it did not reach are marked `budget_wait`
  (shown under Waiting for scoring in the digest) and are picked up by the next day's run. Nothing is skipped silently.
- Because postings are handled newest first and each is scored completely before the next, a small cap fully scores the
  newest postings rather than half-scoring all of them.
- To spend less per run, use `enrich --limit <n>` or lower the cap. The digest's LLM spend section shows today's cost
  against the cap and the calls per model.
- **Re-extraction of outdated postings** runs in `enrich` after all new postings, so new facts (role family, role title, pay type, hours zone) apply to postings stored before a prompt change. A posting is outdated when its stored extraction used an older `extract` prompt version, it is a canonical rule-kept posting with final decision keep or reject (never suspicious), and it was last seen within 14 days. Newest first. **Cost:** one Haiku extraction per outdated kept or rejected posting (cents), plus one Sonnet fit only when the posting is now kept and has no fit from the current fit prompt (a stored current fit is reused, never paid twice); everything inside the same $1/day cap. When the cap is reached the rest stays outdated and is picked up the next day; no status changes. A failed re-extraction keeps the old row as it was. Without `ANTHROPIC_API_KEY` nothing happens. The summary line gains `re-extracted N (decision changes: keep->reject a, reject->keep b)`. `process --reprocess` still makes no LLM call.
- **Company pay-policy research** runs inside `enrich`, after the scam check and before the registry, fit and tier
  stages, and only for postings that are kept (suspicious and rejected postings never trigger it). It looks at the
  company's own `/careers` and `/jobs` pages (at most 2 pages, never LinkedIn) for wording about location-based pay, at
  most once per company per run, and only when the company's policy is unknown and was not checked in the last 90
  days. A company with a policy set by a posting, a careers page or by you is never researched. The result is stored in
  the company registry (`careers:<url>`), so the tier of the posting being enriched uses it in the same run. A page
  fetch redirect is followed only within the company's own domain or to a known ATS host; any other host is refused.
  If the budget is reached during research the posting waits (`budget_wait`); any other research failure (page not
  reachable, API error, unusable answer) does not fail the posting: the policy stays unknown, the tier uses the
  unknown-policy ask, and `enrich` prints one warning line per company. Research costs one Haiku call per fetched page
  and is logged in `llm_calls` with purpose `company_research`.
  The company's domain (`companies.domain`) is filled by `process` from the first company-owned host among a posting's
  apply link and public link; ATS hosts, job boards (remoteok, remotive, himalayas, weworkremotely, arbeitnow (any TLD),
  web3.career, Hacker News ...), shorteners / form hosts and LinkedIn never count, and a domain that is already stored
  is never overwritten. Each researched company writes one `company research` log line (stderr) with `company_id`,
  `outcome` (`found`, `no_domain`, `fetch_failed`, `no_wording`) and `reason`: `no domain`, `fetch failed <url>: <HTTP
  status or network error>`, `redirected off-site`, `redirected to linkedin`, `empty page`, `no pay wording` or
  `found <policy>`; no page or posting text. A company checked while it had no domain is researched again as soon as it
  has one; every other check still waits 90 days. `enrich` ends its summary with `research: checked N, found F, no
  domain D, fetch failed X, no wording W` (companies researched in this run).
- Invalid model output is retried once inside the run (not when the answer was cut off at `max_tokens`: the same
  limit would cut it off again, so that call fails at once), then the posting is marked `failed` and shown under
  Waiting for scoring. A reason longer than 140 characters is cut on a word boundary and ends with "…", and more than
  3 reasons keep the first 3; neither fails the score. A score outside 0-100 or not a whole number still does.
- **A failed fit is tried again on the next `enrich`** (the stored extraction is reused, no Haiku call), at most 3 runs
  per posting. Each failed run adds `fit_attempt:<n>` to `resolved_reasons`. The digest shows
  `scoring failed (<short reason>), retried next run`, and `scoring failed 3 times` once the third run failed; after
  that the posting is not selected again. Postings that failed in the extract stage are not retried.
- Logs hold counts, ids, model, tokens and cost only. Prompts, your CV, posting text and model output are never logged.

## Eval scripts

Every LLM stage is meant to have an optional eval script (`pnpm --filter @job-agent/pipeline eval:<stage>`) that runs
the real model on a golden set, only with an explicit `--live` flag and `ANTHROPIC_API_KEY` set, and prints accuracy
and cost. All of them go through the shared client and the daily cap, plus `--max-usd` (default and ceiling $0.50).
Without `--live` or without a key they only print what they would run.

- `eval:extract`: extraction accuracy per field on `fixtures/eval/extract.json`.
- `eval:fit`: fit band accuracy (`high` is a score of 60 or more, `low` is below), confusion counts, ids of misses and
  cost, on `fixtures/eval/fit.json` (fake postings, scored against the fake persona CV `config/cv.example.md`).
- Your own fit set: `pnpm --filter @job-agent/pipeline eval:export-reviews [--since YYYY-MM-DD]` builds
  `data/eval/reviews-<date>.json` from your reviews, then
  `pnpm --filter @job-agent/pipeline eval:fit --set data/eval/reviews-<date>.json --live` scores it against your own
  `config/cv.md`. Both only print ids, counts and cost.

Besides the evals:

- `pnpm test` checks the rule and decision code (resolve, scam score, tier and ask) against the golden sets in
  `fixtures/golden/*.json`. These never call the model.
- All tests mock the Anthropic API; no test makes a live call.
- Evals cost real money and are run by you, not by the agents. They count against the same daily cap.

## Smoke test

`bin/smoke [dir]` runs the whole pipeline once against the live public feeds without touching `config/` or `data/`:
it copies the `config/*.example.*` files, uses a temp DB (`<dir>/smoke.db`, default dir from `mktemp`), then runs
`fx`, `discover --force --source <s>` for each keyless source one by one (`himalayas`, `remoteok`, `remotive`,
`weworkremotely`, `hn`, `arbeitnow`, plus one public ATS board: Greenhouse `gitlab`, written into the
temp `companies.yaml`; `web3career` only if `WEB3_CAREER_TOKEN` is already in your environment), `process`,
`enrich` (it runs without a key and prints its skip line), and `digest` into
`<dir>/digests/`. It ends with `status` (row counts and per-source result) and the smoke dir and digests paths.

A failing source shows as `error` and does not stop the others. The script exits 0 when `process` and `digest`
completed, 1 if either failed. It makes no LLM calls (`ANTHROPIC_API_KEY` is unset for the run).

## Dry-run harness browser (Phase 5)

The dry-run harness (`packages/apply/src/dryrun/`) drives Chromium through Playwright (`playwright` pinned to exactly 1.64.1). The
browser binary is not part of `pnpm install`. After `pnpm install`, in the repo or in a fresh worktree, run once:

```sh
pnpm playwright:install
```

It downloads Chromium into Playwright's shared cache (`~/Library/Caches/ms-playwright` on macOS), so other worktrees of
the same checkout reuse it. The tests that need the browser (`packages/apply/src/dryrun/harness.test.ts`) fail with
`Chromium for Playwright is not installed. Run: pnpm playwright:install` when it is missing; they never skip.

Safety, in code and not configurable: one run per process; every request that is not GET or HEAD is aborted (the only
exception is an Ashby GraphQL query on the read-only allowlist), WebSockets, `sendBeacon` and service workers are blocked,
and `form.submit()` / `requestSubmit()` / `submit` events are cancelled and recorded. The helpers only fill, select,
check and upload, plus picking an option of a combobox (it clicks only the combobox input and one `role=option` item); there is
no other click, and any element that is a submit control or inside one is refused. Fixture mode (tests,
`bin/smoke`) also aborts every host other than `127.0.0.1`. A visible CAPTCHA challenge (a passive script, badge or
hidden widget does not stop a run), a login wall or a page error stops the run before a field is filled; a challenge that
appears after a fill stops it there, and nothing more is filled. Output goes to `<data dir>/dryruns/<YYYY-MM-DD>/<run id>/screenshot.png` (dirs
0700, file 0600; the data dir is the folder of the DB file, so a smoke run writes inside its smoke dir). Screenshots
and filled values are personal data: never commit or share them.

## Greenhouse dry run (Phase 5)

`dry-run` fills a posting's Greenhouse application form, takes a full-page screenshot and records the run. It **never
submits**: there is no submit path in the code, and the harness guards above abort every non-GET request.

### Agents and smoke: the fixture

```sh
bin/smoke run <smoke dir> dry-run --fixture greenhouse
```

Serves the committed synthetic form (`packages/apply/fixtures/greenhouse/`, built from the selector map in
`docs/research/t_d0698332-ats-form-structure.md`, not recorded from a real employer) from `127.0.0.1`, with a demo
posting and a fake persona (answers, choice mappings and tier ask live in code, so the smoke DB's answer bank is not
touched). It prints one line and nothing else:

```
dry-run: status=filled reason=- fields=13/13 screenshot=<smoke dir>/dryruns/<date>/<run id>/screenshot.png
```

`--fixture` is refused on the real database (the default DB or one under `data/`), and a real posting id is refused on a
scratch DB: only the owner's real DB opens a real form. The fixture run is stored with `fixture` = true and never counts
for the done-when line. The folder holds other pages used by the tests: `changed.html` (stops `form_changed`),
`location.html` (the location autocomplete: `needs_input`) and
`captcha/<variant>.html`, snippets the fixture server adds to `form.html` (`passive`, `visible-checkbox`,
`visible-challenge`, `hidden-challenge`, `late-challenge`; the form itself is not changed).

### Owner: a real dry run

One posting at a time, in a window you watch. Pick a posting whose apply link is a Greenhouse job link, whose questions
were fetched (`fetch-questions`), and that is not flagged as a scam:

```sh
pnpm job-agent dry-run <posting-id>              # opens a visible Chromium window
pnpm job-agent dry-run <posting-id> --headless   # no window
```

If the browser is missing, run `pnpm playwright:install` once. The command refuses (exit 1, one `dry-run: refused: ...`
line) a posting that has no Greenhouse job link, is scam-flagged or has no stored questions. A link on a company career
page (`...?gh_jid=<id>`) works: `fetch-questions` finds and stores the board, and the dry run opens
`https://job-boards.greenhouse.io/<board>/jobs/<id>` (EU host for an EU link), never the career page. If
`fetch-questions` printed `greenhouse board not found for gh_jid` for the posting, no board could be verified: the
posting has no questions and the dry run is refused until the board is known (add the company's Greenhouse board to
`companies.yaml`). Otherwise it opens the
hosted form, and then:

1. **Stops** (nothing filled, screenshot taken, status `stopped`) when the page shows a visible CAPTCHA challenge (also one
   that appears while fields are filled; a passive script or badge does not stop), a login
   wall, an error page or another host; when the form differs from the stored questions (`form_changed`: the detail lists
   the labels of missing, extra and different fields); on a question type the planner cannot fill (`unexpected_field`);
   on a field that matches two answers or a scam flag (`other`).
2. **Fills** every covered field (approved answer, approved choice mapping, profile answer, tier ask, resume file) and
   leaves the others empty. Status `needs_input` (reason `uncovered_question` or `choice_unmapped`) when any field is
   left empty, or when the page did not keep a value (the field row shows `filled` = false and a note); `filled` when
   every field is in. Labels with no matching answer go to the Inbox. The EEO block and the phone country are never
   touched.
   **Location.** A board's Location question renders as an autocomplete (a "Location (City)" field with a helper "Search"
   input). The reader treats it as the stored Location question and never types into it, like Lever's location: the field
   is recorded as not filled (`location autocomplete: pick the suggestion yourself`) and the run is `needs_input`. Pick
   the suggestion yourself when you review. A form with a location control but no stored Location question, or the
   reverse, still stops `form_changed`.
3. Prints one line: `dry-run: status=<status> reason=<reason or -> fields=<filled>/<total> screenshot=<path>`. It never
   prints a value. The window closes by itself after the screenshot (it is not left open to submit from).

What to check, then review the run in the dashboard's Dry runs tab (Correct / Wrong with a reason):

- Every filled field holds the right value (name split into first / last, email, phone, links, resume file name,
  the right option in each choice, the salary field matches the posting's ask and its currency / period).
- Nothing that should be empty was filled (EEO questions, anything you would answer yourself).
- The stop or `needs_input` reason is the right one: a wrongly stopped or wrongly filled run is "wrong" with the reason.
- Nothing was sent: the page stays on the form; the application is not in your Greenhouse confirmation email.

Greenhouse loads an invisible reCAPTCHA Enterprise script on its forms (research t_ec2ae4c6). A passive script or badge no
longer stops a run (decision "Dry-run CAPTCHA rule", `docs/decisions.md`): the run goes on and its line says
`captcha=passive` (the stored detail lists labels only, e.g. `captcha=passive:script,badge`). Only a visible challenge stops
it. Never solve a challenge inside a dry-run window: the run does not touch it, and a solved or clicked challenge is not
part of a dry run.

**`ambiguous match` (stop reason `other`, nothing filled).** A form label is reached by two *different* answer keys, so the
run will not guess. A standard contact label (name, email, phone, location, LinkedIn, ...) counts as the key
`contact.<field>` (`contact.full_name`, `contact.email`, `contact.phone`, `contact.linkedin`, `contact.location`) and only
counts when that key has an approved answer; any other approved answer whose `question` or `alternatives` repeats that
wording is a second key. The same key reached by several routes is not ambiguous. The stop detail lists, per label, the
keys (never values), e.g. `ambiguous match, Email (contact.email, contact.mail)` (the detail is cut at 200 characters). What to do: open the
answers (dashboard Answers tab, or `config/answers.yaml` and `import-answers`) and look at the named keys: remove the
wording from the answer that should not carry it, or unapprove it. Rows that were once imported and later removed from
the YAML stay in the database (the import never deletes them), so a key named in the detail that is not in your YAML is
such a leftover: unapprove it in the dashboard.

The run, its fields and the screenshot are personal data under `<data dir>/dryruns/` (dirs 0700, files 0600): never commit
or share them.

## Lever dry run (Phase 5)

`dry-run <posting-id>` also works for a posting whose apply link is a Lever job link (`jobs.lever.co/<company>/<posting id>`,
also `jobs.eu.lever.co`; the command opens `.../apply`). Same guarantees, flags, refusals, stop reasons, output line and
review as the Greenhouse dry run above; this section lists only what differs. It **never submits**: the harness aborts every
non-GET request, so Lever's resume upload (`POST /parseResume`, which would send your CV to Lever on attach) never leaves the
browser either; the file still attaches locally.

- **Questions come from the page.** Lever has no questions API, and the hourly run does not fetch Lever pages. The run
  reads the form from the page the browser opened (one page load, no other fetch): the standard fields (`name`, `email`,
  `phone`, `org`, `location`, `urls[...]`, `comments`, the resume) and the custom `cards[<card>][field<n>]` questions, each
  with its options. It stores them as `posting_questions` (ats type `lever`, the control's `name` as the question id) and
  runs `match-questions`, so unmatched wordings reach the Inbox and a choice question gets a mapping request, exactly like
  the questions of a Greenhouse posting; then the same fill plan runs. The EEO surveys, the pronouns checkboxes, the
  marketing consent and the hidden inputs are never read or touched.
- **`form_changed`** means the page's fields differ from the ones stored by the last run (a field gone, a new one, or a
  changed label, type, required flag or option set). The first run of a posting has nothing to compare with and stores what
  it sees. On a change the run stops (detail: the labels), the page's new set replaces the stored one (so new questions
  reach the Inbox) and the next run compares with that. No separate `fetch-questions` step and no stored-questions refusal.
- **Location.** The "Current location" field is an autocomplete that clears itself unless a suggestion is picked, so a typed
  location is not kept: the field is recorded as not filled (`page kept a different value`) and the run is `needs_input`.
  Pick the suggestion yourself when you review.
- **CAPTCHA.** Every real Lever apply page carries an hCaptcha widget (research t_d0698332). A passive widget
  (invisible, or not drawn because the vendor script is blocked) does not stop a run; a visible hCaptcha checkbox or
  challenge does, with `captcha`, before anything is read.

Agents and smoke use the committed fixture (`packages/apply/fixtures/lever/`, synthetic, served from `127.0.0.1`, fake persona):

```sh
bin/smoke run <smoke dir> dry-run --fixture lever
```

```
dry-run: status=filled reason=- fields=13/13 screenshot=<smoke dir>/dryruns/<date>/<run id>/screenshot.png
```

`--fixture lever` is refused on the real database, like `--fixture greenhouse`. Besides `form.html` the folder holds the
pages the tests use: `captcha/<variant>.html` (snippets added to `form.html`, see the Greenhouse fixture), `changed.html` (stops `form_changed` after a run on `form.html`),
`date.html` (a date question: stops `unexpected_field`) and `location.html` (the self-clearing location field).

## Ashby dry run (Phase 5)

`dry-run <posting-id>` also works for a posting whose apply link is an Ashby job link (`jobs.ashbyhq.com/<organization>/<posting id>`;
the command opens `.../application`; a link on a company's own domain with `?ashby_jid=` is refused, the organization is
unknown). Same guarantees, flags, refusals, stop reasons, output line and review as the Greenhouse dry run; this section lists
only what differs. It **never submits**.

- **The form arrives after the page loads.** Ashby's HTML is a shell; the page POSTs a GraphQL query
  (`/api/non-user-graphql?op=<operation>`) and draws the form. Those POSTs are the one exception to "abort every non-GET": the
  harness lets a request through only when the `op` is on the read-only allowlist (`ASHBY_READ_ONLY_OPERATIONS` in
  `packages/apply/src/dryrun/request-guard.ts`: `ApiOrganizationFromHostedJobsPageName`, `ApiJobPosting`,
  `ApiJobPostingForApplicationRequest`, `ApiAutocompleteGeoLocation`, `ApiSearchSchoolByCanonicalName`), the body's
  `operationName` equals it and the query text has neither `mutation` nor `submit`. Everything else is aborted in the browser:
  `ApiSubmit*`, and also the benign draft writes (`ApiSetFormValue`, fired on every field change), the resume upload handle
  and "Autofill from resume", so a dry run saves nothing on Ashby's side. The run waits (up to 10 s) for the form to be drawn
  before its stop checks.
- **Questions come from the rendered page.** Ashby has no public questions endpoint. The run reads the fields from the drawn
  DOM (never from a network response): the controls inside `.ashby-application-form-container`, one
  `.ashby-application-form-field-entry` per question, the control's `name` (the field path: `_systemfield_name`,
  `_systemfield_email`, `_systemfield_resume` or a uuid) as the question id. It stores them as `posting_questions` (ats type
  `ashby`), compares them with the last stored set (`form_changed` on a difference, as for Lever) and runs `match-questions`,
  then the same fill plan. The survey / self-identification block, the texting and WhatsApp consent boxes and the "Autofill
  from resume" drop zone are never read or touched.
- **Phone.** Ashby's phone question is a country selector next to a `tel` input (often with a texting-consent group) inside
  one field entry. The run reads the `tel` input as the question (label such as "Phone", "Phone Number", "Mobile phone"), fills
  it from `contact.phone` through the usual phone check, and never touches the country selector or the consent radios. A field
  whose controls the run does not understand stops `unexpected_field`; the stop detail is the label plus the field type and the
  DOM shape (tags and input types, e.g. `Mobile phone (other, input:tel+input:tel)`), never a value. Send those labels and
  shapes (never values) to the PM when a field stops.
  The page may reformat the typed number (spaces, dashes, brackets, a country prefix): the phone is checked **by digits
  only**, and counts as kept when the kept digits equal the typed digits or end with them (a prefix the page added). Every
  other text field is still compared exactly. A stored question set written by an older version of the reader (the phone
  stored as type `other`) is not a form change when the label under the same control name is the same; the stored row is
  refreshed on the next run. A changed label, required flag or option set still stops `form_changed`.
- **The ids are unverified on the real site** (research t_d0698332 could not read a real form without POSTing). If the first
  real runs show `form_changed`, empty or "page kept a different value" fields, send the PM the field labels (never values):
  that is the signal to correct the selectors from one owner-run recording. Because the draft writes are aborted, a real page
  may also drop a typed value (or show an error toast); that field is then recorded as not filled, never as a wrong value.
- **CAPTCHA.** Ashby's job response carries a `recaptchaAction` and the page loads reCAPTCHA, which is passive (does not stop a
  run); only a visible challenge stops it with `captcha`.

Agents and smoke use the committed fixture (`packages/apply/fixtures/ashby/`, synthetic: `app.html` + `app.js` draw the form
from fake GraphQL answers the fixture server serves from `127.0.0.1`, fake persona):

```sh
bin/smoke run <smoke dir> dry-run --fixture ashby
```

```
dry-run: status=filled reason=- fields=13/13 screenshot=<smoke dir>/dryruns/<date>/<run id>/screenshot.png
```

`--fixture ashby` is refused on the real database, like the other fixtures. The fixture page itself sends the submit mutation
and a mutation hidden under an allowlisted operation name, and a draft write per field; the tests show that none of them reaches
the fixture server. `form.json` is the fake GraphQL answer; the tests use its variants (changed form, a date
question; the CAPTCHA variants are snippets in `captcha/`) built in `packages/apply/src/dryrun/ashby/fixture.ts`.

## Dry runs (Phase 5)

Phase 5 is done when **20 of your own dry runs are reviewed and marked correct in the dashboard, at least 10 of them full
fills**. A dry run opens one posting's application form in Chromium, fills what your approved answers cover, takes a
screenshot and records the run. **Nothing is ever submitted**: there is no submit path in the code, the harness aborts every
non-GET request (Ashby's read-only GraphQL queries are the only exception), and no click on a submit control is possible.
Per-ATS details and the fixture forms are in the Greenhouse, Lever and Ashby sections above.

### Check the whole flow on fixtures first

```sh
bin/smoke --demo
```

runs the pipeline on a temp DB with the fake demo day and ends with the three fixture dry runs (`dry-run --fixture
greenhouse`, `lever`, `ashby`: committed synthetic forms on `127.0.0.1`, fake persona, headless). Each prints one line,

```
dry-run: status=filled reason=- fields=13/13 screenshot=<smoke dir>/dryruns/<date>/<run id>/screenshot.png
```

and the dashboard self-check then lists `/api/dry-runs` (`runs=5`: the 2 seeded demo runs and the 3 fixture runs). The same
flow, with a CAPTCHA stop, a choice question mapped through the API, an uncovered question and the reviews, is the test
`apps/dashboard/src/server/e2e.phase5.test.ts` (needs the Chromium below). Fixture runs never count for the done-when line.

### Prerequisites for your real runs

1. **Browser:** `pnpm playwright:install` once (Chromium into Playwright's cache). A missing browser fails the command loudly.
2. **Approved answers** in the answer bank (Answers tab or `config/answers.yaml` + `answers import`), including
   `profile.resume_file`: the local path to your CV as a PDF, under 10 MB. Without it the resume field stays empty
   (`needs_input`). Only approved answers are ever used. Two approved answers that match the same field stop the run
   (`other`, "ambiguous match"): unapprove one.
3. **Choice mappings:** for each choice / dropdown / radio / multi-select question, the Inbox shows the form's options and
   the approved answer's text; pick the matching option(s) once and save. A new option set needs a new mapping. Salary
   questions never get one: they take the posting's tier ask.
4. **A posting** whose apply link is a Greenhouse, Lever or Ashby job link, not flagged as a scam. For Greenhouse run
   `fetch-questions` first (Lever and Ashby read the questions from the page).

### Your run

```sh
pnpm job-agent dry-run <posting-id>              # a visible Chromium window; you watch it
pnpm job-agent dry-run <posting-id> --headless   # no window
```

One posting per command. The command prints one line (`status`, `reason`, `fields=<filled>/<total>`, the screenshot path) and
never a value. Run it against the real database only; `--fixture` is refused there and a real posting id is refused on a
scratch DB.

### What each result means and what to do

| Status / reason | Meaning | What to do |
|---|---|---|
| `filled` | Every field of the form is in; nothing is empty. A **full fill**. | Check the screenshot and the values, then mark Correct or Wrong. |
| `needs_input` / `uncovered_question` | Covered fields are filled; a question has no approved answer (a salary field with no tier ask, a missing or invalid resume file, or a value the page did not keep, too). The label is in the Inbox. | Answer it in the Inbox, then run again, or mark the run Correct if leaving it empty was right. |
| `needs_input` / `choice_unmapped` | A choice question has an approved answer but no approved mapping to the form's options. | Map it in the Inbox (options shown), then run again. |
| `stopped` / `captcha` | A visible CAPTCHA challenge (or a widget that asks you to act) is on the page, at load or after a field was filled; a CAPTCHA container whose state could not be told also stops. A passive script, badge or hidden widget does not stop a run (the line says `captcha=passive`). Nothing more was filled and it is never bypassed or clicked. | Never solve a challenge inside a dry-run window. Mark Correct if the page really showed one; if every real run of an ATS stops here, tell the PM. |
| `stopped` / `login_wall` | The page asks you to log in. | Nothing to fix; the harness never logs in. |
| `stopped` / `form_changed` | The page's fields differ from the stored questions (the detail lists labels). | Run again: the new set was stored and the new questions are in the Inbox. |
| `stopped` / `unexpected_field` | A question type the filler does not fill (a date, a file other than the resume, ...). | Fill it yourself in a normal application; mark Correct if stopping was right. |
| `stopped` / `page_error`, `blocked_request` | The page failed to load, or it tried something the harness blocks. | Run again; if it repeats, tell the PM the posting id (no values). |
| `stopped` / `other` | An ambiguous match (a field that matches two answers), a scam flag or an unexpected page. The detail says which. | Fix the answers or skip the posting. |

The strict rule "every question covered by an approved answer or mapping" applies to submitting in Phase 6, not to Phase 5.

### Review in the dashboard

`pnpm dashboard`, tab **Dry runs**: newest first, one row per run (status, reason, fields filled / total, the review). Open
a run to see its fields (the values you would have sent) and the screenshot. Mark it **Correct**, or **Wrong** with a reason:
`wrong_value`, `wrong_choice`, `missing_field` (type the missing label: it goes to the Inbox), `salary_wrong`,
`stopped_wrongly`, `should_have_stopped`, `page_broken` or `other`. A review can be changed later; no history is kept.

### The done-when line

```
dry runs: <c> correct of <r> reviewed (<f> full fills); done when 20 correct, at least 10 full fills: met | not met
```

It shows in the Dry runs tab, the Stats tab and `pnpm job-agent review-stats`. Only your own runs count (fixture runs are
excluded). A full fill is a run marked Correct with status `filled` (no `needs_input` field). Plan for 20 to 30 runs.

### Where the output is stored (private)

The run and its field rows (including the filled values) are in the local DB (`data/job-agent.db`); the screenshot is
`<data dir>/dryruns/<YYYY-MM-DD>/<run id>/screenshot.png` (folders 0700, files 0600). All of it is personal data: `data/` is
gitignored, so never copy any of it into a commit, an issue or a message. Logs and the command's output carry labels and
counts only, never values. The dashboard serves a screenshot only by run id.

## LinkedIn and Indeed through JobSpy (optional, Tier 2)

The `linkedin` and `indeed` sources run a Python worker (`workers/jobspy/run.py`, JobSpy 1.3.0, logged out, no cookies, no proxies).
One-time setup from the repo root (Python >= 3.10):

```
python3 -m venv workers/jobspy/.venv
workers/jobspy/.venv/bin/pip install -r workers/jobspy/requirements.txt
```

Run it with `pnpm job-agent discover --source linkedin`. Each run does two searches (Worldwide + remote, Indonesia +
remote), at most 25 results each, 10 s apart; the poll interval is 50 minutes. The search window (`hours_old`, both
LinkedIn and Indeed) is the time since the start of the source's last ok run plus 10 minutes, rounded up to whole
hours and clamped to 1 to 24 hours; with no ok run yet it is 24. Errors, blocks and backoff-skipped runs do not advance
it, so nothing posted in such a gap is missed (dedupe absorbs the overlap). Without the venv the
run is recorded as `skipped` ("jobspy worker not installed (see workers/jobspy/README.md)"), never as `ok`.
Tests never start the worker: the spawn is refused when `VITEST` is set (the run is `skipped`), and tests inject a fake worker instead.

A block (HTTP 429 / 999 / 403, authwall, CAPTCHA) is recorded as an `error` run (`blocked: ...`) and the source is then
`skipped` for 6 hours (`backoff after block until <time>`), also with `--force`. Nothing is retried and nothing is
rotated. To lift the backoff early, wait it out: it is a protection for your home IP.

**LinkedIn descriptions (`fetch-descriptions`).** JobSpy returns LinkedIn search results with no description, so a posting
would be judged on its title alone. `pnpm job-agent fetch-descriptions` runs between `process` and `enrich` in the hourly
run (own command, not part of the search) and fetches the description of a posting only when it is `source = linkedin`,
has no description, its title passes the role rule (`classifyRole` is not `reject`) and its own location text is not
`restricted` (`classifyLocation`). Nothing else is fetched; postings already stored without a description are picked up
the same way (no migration step). The fetch is one JobSpy detail request per posting (`workers/jobspy/run.py`, details
mode, JobSpy's `LinkedIn._fetch_details`, logged out, no cookies), newest first:
- **Free route first:** when the DB holds a posting from the company's own ATS board (same company, same normalized title;
  also through the posting's resolved apply link) with a description, that text is taken and no LinkedIn request is sent.
  This applies to every pending posting, whatever its age, and also during a backoff.
- **Then the ATS link, still no LinkedIn request:** when the posting's apply link (the owner's correction or the resolved
  link in `apply_links`, else the link JobSpy found) is a job link of Greenhouse, Lever, Ashby, Workable or Recruitee, that
  one job is fetched from the ATS's public API (the adapters' endpoints and parsers: Greenhouse and Lever one job, Ashby,
  Workable and Recruitee the board's list once per run; a Greenhouse `?gh_jid=` company page first resolves its board).
  Logged-out GET, redirects never followed, 2 s per host; a host answering 401 / 403 / 429 gets no more requests in that
  run and nothing is counted. Only the same job is accepted (the id must equal the link's). The text is stored like a
  fetched one and the rules run again. Any age, also during a details backoff, at most 50 postings per run. A closed job, a
  job missing from the board, another job id, an unreadable answer or empty text is one counted failure
  (`description_attempts`): not asked again for 6 h, `description_unavailable` after 3 failures. A posting with an ATS job
  link is never sent to LinkedIn; LinkedIn requests are only for postings with no ATS job link (a link with no job id or
  board name does not count as one).
- **Age:** only postings first seen in the last 24 h (`DETAIL_MAX_AGE_MS`) get a LinkedIn request. Older pending postings
  are never requested: they stay `description_missing` and are never Top.
- **Spacing and cap:** one request at a time; the first one 10 s after the last search request (`SEARCH_GAP_MS`), each next
  one at least 45 s after the previous one ended (`DETAIL_GAP_MS`); at most 3 requests per run
  (`MAX_DETAIL_REQUESTS_PER_RUN`), newest first; the rest wait for the next run. No retry inside a run.
- **Block:** failures are counted per posting, a 429 included (`description_attempts`, `description_failed_at`,
  `description_blocked_at`). A 429 on ONE posting is that posting's failure: the run goes on with the next posting and no
  backoff starts. The **details-only** 6 h backoff starts only when 429s come from at least 2 different postings: a posting
  gets a 429 while another posting's 429 (same run or an earlier run) is less than 6 h old. The step then ends, keeps the
  descriptions already fetched, takes back the attempt of the postings in that block (a real block is not their fault) and
  writes the `blocked` flag of the `description_runs` row (no `source_runs` row). The search keeps running and its
  freshness line is untouched. A block on the search still stops the detail requests too (the command takes `--force` like
  `discover` and ignores it).
- **Order:** postings with fewer failures first, then newest first: after a 429 on job X the next run tries the other
  pending postings before X.
- **Attempts / poison jobs:** a posting that returns no description is tried again on a later run. It is given up
  (`description_unavailable`: processed and extracted on the title only, never requested again, stays in Needs a look with
  `description_missing`, never Top) after 3 counted failures (`MAX_DESCRIPTION_ATTEMPTS`), or after failures on 2 runs when
  another posting got its description in between or in the same run (`POISON_FAILED_RUNS`): one job that keeps failing while
  the others work is skipped and never starts the backoff. A worker error (JobSpy changed, worker not installed) counts
  nothing.
- **Until a posting has its description** (pending or unavailable) it has the flag `description_missing`, shows in Needs a
  look with that flag, never in Top matches (digest and dashboard queue share one selection), and a pending one is not
  sent to the LLM (no title-only spend); an unavailable one is.
- **When the description arrives** it is stored, the rules run again for that posting (location, Indonesia, role, salary,
  language), the flag is dropped, the title-only extraction (if any) is cleared, and `enrich` extracts the text.

Source health shows the detail requests of the latest run on the linkedin line, for example `details 3 (1 failed, 1 skipped)` (`skipped` = postings given up in that run, no job text), and
`, details backoff until HH:MM WIB` while a details backoff holds. They are stored per run in `description_runs`, not in
`source_runs`, so the freshness proof (gaps between ok runs, LATE) and the saturation count are untouched.

The `indeed` source (`pnpm job-agent discover --source indeed`) uses the same worker, venv and block backoff. Each run
does two remote searches, 10 s apart, the same lookback window, at most 50 results each: "global remote" (`country_indeed = usa`
with `is_remote`; Indeed has no worldwide site, so this one is US-scoped) and "Indonesia remote" (`location = Indonesia`,
`country_indeed = indonesia`, `is_remote`), term `senior frontend OR "full stack" OR react OR typescript`. The poll
interval is 110 minutes: a run started sooner is recorded as `skipped` (`indeed: skipped (polled less than 110 min ago)`).
Indeed dates are whole days, so postings dated more than 48 h before the run are dropped. The apply link is
`job_url_direct` when Indeed has one; Indeed is a board, so an ATS copy of the same job always wins in dedupe, and a
domestic Indonesian company's posting is rejected by the Indonesia rule as for every source.

**Paging.** A search that returns a full page (as many job lines as its `results_wanted`: 25 for LinkedIn, 50 for Indeed) is
asked for the next page (`offset += results_wanted`, same search and lookback) until a page is not full or the search holds
100 results. Worst case per run: LinkedIn 2 searches x 4 pages = 8 worker calls, Indeed 2 x 2 = 4. Every call but the first
of a run waits 10 s after the previous one. A block on any page stops everything at once (error + 6 h backoff, the postings
collected so far are kept); another worker error on a later page keeps what was collected and records an `error` run. A
search is **saturated** when its first page was full; the digest's Source health line for these two sources shows the count
for the latest run, right after `new`: `- **linkedin**: ok, found 61, new 7, saturated 1 — last ok ...` (`saturated 0` is
shown too; other sources have no such field). A saturated search that also hits the 100 cap may still lose older postings.

`bin/smoke --with-jobspy` adds one LinkedIn and one Indeed search with at most 10 results each to the smoke run (only if
the venv exists). Plain `bin/smoke` never touches LinkedIn or Indeed.

## Schedule with cron

`scripts/crontab.example` runs:

- `fx` daily at 06:50 Asia/Jakarta
- `discover-companies` weekly, Monday at 07:00 Asia/Jakarta (before that day's first `discover`)
- `bin/run-hourly` every hour at :05: `discover`, `process`, `fetch-descriptions`, `enrich`, `resolve-apply`, `fetch-questions`, `digest` in that order. Each
  step appends to `data/logs/<command>.log`; a failing step does not stop the next ones (the script then exits 1).

So the order in a day is `fx` -> `discover-companies` -> hourly `discover` -> `process` -> `fetch-descriptions` -> `enrich` -> `resolve-apply` -> `fetch-questions` -> `digest`.
Sources polled less often than hourly record `skipped` runs; the adapters' own minimum poll intervals still apply.

**No overlapping runs.** `bin/run-hourly` takes a lock by creating the directory `data/locks/hourly`. A run that finds
it prints `run-hourly: previous run still active, skipped` and exits 0. A lock older than 3 hours (left by a crashed
run) is removed with a log line, and the run goes on. The lock is removed when the run ends, also after a failing step.

**Keys live in `.env`, not in the crontab.** The CLI reads `<repo root>/.env` itself at start (the repo root is found
from the CLI file, not the working directory), so cron needs no environment lines for keys. A variable already set in
the environment wins over the file; a missing file is fine; an unreadable file or a line that is not `KEY=VALUE` gives
one stderr line that names the file (never a key or a value). `JOB_AGENT_ENV_FILE` points the CLI at another file.
`bin/smoke` sets it to `/dev/null`, so a smoke run never picks up your key.

Cron uses the Mac's local time. The example assumes the clock is set to Asia/Jakarta; otherwise convert the hours.

To install:

1. Copy it: `cp scripts/crontab.example data/crontab` (`data/` is gitignored).
2. In the copy, replace `/ABSOLUTE/PATH/TO/job-agent` with the repo root (`pwd`) and `/ABSOLUTE/PATH/TO/node/bin` with
   `dirname "$(command -v pnpm)"` (cron has a minimal `PATH`). Put the keys in the repo's `.env` (copy
   `.env.example`; `.env` is git-ignored), not in the crontab. Keep the copy in `data/`, never commit it.
3. Check what is already installed: `crontab -l`. `crontab <file>` **replaces** your whole crontab, so merge any
   existing lines into the copy first.
4. Install: `crontab data/crontab`, then `crontab -l` to confirm.

On macOS, cron may need Full Disk Access (System Settings → Privacy & Security → Full Disk Access → add `/usr/sbin/cron`)
if the repo lives in a protected folder such as Documents or Desktop. To remove the schedule: `crontab -r` (removes all
your cron jobs) or edit with `crontab -e`.

## Where output lands

| Path | Contents |
|---|---|
| `data/digests/YYYY-MM-DD.md` | The daily ranked digest |
| `data/logs/<command>.log` | Cron output per command (`fx`, `discover-companies`, `discover`, `process`, `enrich`, `digest`): plain lines plus JSON log lines |
| `data/job-agent.db` | The SQLite database |
| `data/exports/answers-YYYY-MM-DD.yaml` | Answer-bank export from the dashboard |
| `data/eval/reviews-<date>.json` | Your fit eval set from `eval-export-reviews` |

Everything under `data/` is gitignored and may contain personal data. Never commit it.

## Reading the ranked digest

Open `data/digests/YYYY-MM-DD.md`. Sections, in order:

- **Top matches**: kept postings with a fit score of 60 or more (`TOP_MATCH_MIN_FIT` in `digest/rank.ts`), best first. Each shows title, company, link, fit score with up to 3
  reasons, the employment **Type** (`employee`, `contractor`, `EOR` or `unknown`, from the extraction), the pay tier
  and your ask (or the text answer to use when the posting has no numeric field), the listed salary if any, and the
  scam score with its top reason if above 0. There is no Why line. `Location:` shows three or more UTC offsets or time
  zone names as a span (`UTC-8 to UTC+2 (9 zones)`) and is cut at 120 characters with "…". `Flags:` lists only flags
  still open after the resolve stage (`none` when all were settled). The rank is the fit score, minus
  10 per unresolved flag, plus 5 when the listed salary max is at or above your ask; ties go to the newer posting. The
  same company and title listed in several places is one entry with the locations joined.
- **Scored, not a fit**: kept postings scored below 60, one line each, so the list is quick to skim:
  `- title — company — fit N/100 — first fit reason — link` (no reason part when there is none). Highest fit first, then
  newer posting. They are not in Needs a look. The summary shows the count; "Kept" counts Top matches, Scored, not a
  fit and Waiting for scoring.
- **Waiting for scoring**: kept postings without a fit score yet: not enriched (no `ANTHROPIC_API_KEY`), `budget_wait`
  (daily cap reached, retried tomorrow), or `failed`. One line each:
  `- title — company — status — link`.
- **Needs a look**: postings with a flag the rules and the LLM could not settle (location, Indonesia rule, role).
- **Suspicious**: scam score at or above 60. Listed only; never fit-scored and never acted on. Each has its reason lines.
- **Source health**: see below.
- **LLM spend**: today's cost against the cap, and calls per model.

## Reading Source health

The last section of every digest has one line per source that has ever run, built from its latest run in the last
24 hours:

```
- **remotive**: ok, found 19, new 4
- **web3career**: error, found 0, new 0, error: [web3career] WEB3_CAREER_TOKEN not set — NO SUCCESSFUL RUN
- **hn**: skipped, found 0, new 0
```

- `ok, found N, new M`: the source answered; N postings in its response window, M not seen before.
- `skipped`: the latest run came too soon after the previous successful one (poll interval). Normal between polls.
- `error, ..., error: <message>`: the latest run failed; the message says why (HTTP status, invalid response, missing token).
- **Freshness (`linkedin`, `indeed`)**: these lines carry proof of how often the source was polled, e.g.
  `- **linkedin**: ok, found 12, new 2 — last ok 13:05 WIB, max gap 60 min in 24h`. `last ok` is the start of the latest
  successful run (WIB); `max gap` is the longest time between two consecutive `ok` runs in the last 24h
  (`max gap n/a` with a single ok run, `no ok run in 24h` with none). ` — LATE` is added when that gap is above 65 min
  (`linkedin`) or 130 min (`indeed`): the Phase 3 "LinkedIn jobs appear within an hour" check fails for that day.
  ` — in backoff until HH:MM WIB` means the source refused us (block) and is not polled until then. `pnpm job-agent status`
  prints the same suffix after each source's latest run. Other sources keep the plain line.
- `no run in the last 24h`: cron or `discover` has not run this source for a day.
- `NO SUCCESSFUL RUN`: no `ok` run in the last 24 hours. A source with this mark for more than a day needs a look:
  check `data/logs/discover.log`, then run `pnpm job-agent discover --source <name>` by hand.

## Resetting

- Start over completely: delete the database and its side files, `rm -f data/job-agent.db data/job-agent.db-*`.
  The next command recreates it (migrations run on open). The next `discover` looks back 7 days per source.
- Regenerate a digest: `pnpm job-agent digest --date YYYY-MM-DD` rewrites that day's file.
- Delete old digests or logs: remove the files under `data/digests/` or `data/logs/`.

## Automatic additions to companies.yaml

`resolve-apply` appends every ATS board it found (`discovered_via = apply_resolve`, verified, with an ATS and slug) to `config/companies.yaml` (the directory in `JOB_AGENT_CONFIG_DIR`), so your list grows without manual copying. Rules:

- Append-only. Existing lines and comments are never changed, and no entry is ever removed or edited. A company whose name already matches an entry (case and punctuation ignored) is not added.
- Each new line looks like `  - { name: Example Co, ats: ashby, slug: example }  # added by job-agent 2026-10-14 (apply resolve)`. Names with `:`, `#`, `,` or other special characters are written in double quotes.
- Before every write the old file is copied to `companies.yaml.<UTC timestamp>` in `backups/` next to the database file (`data/backups/` by default). Nothing new means no write and no backup. Backups are never deleted by the product.
- The new file is written to a temp file in the same directory, validated with the same schema as `loadConfig`, and only then renamed over the original. If validation fails (for example the file uses `companies: []`, which cannot take appended lines), the original stays untouched, an error naming only the file is printed and the command exits 1. Fix the file by hand and run again.
- A missing `companies.yaml` is never created: one line `companies.yaml: not found, nothing added` is printed.
- Summary line: `companies.yaml: added N (backup <path>)`, followed by one `+ <name> (<ats>/<slug>)` line per company (terminal only).

## Automation merges (bin/agent-step)

- **Automatic DB backup before a merge.** Before QA or the auditor merges a card (one helper, `backup_before_merge` in `bin/step-git.sh`), the automation looks for a line starting with `OWNER: back up data/job-agent.db` (leading spaces, `**` and the `[date] author: ` comment prefix allowed) in the dev card's report comments and in the reviewer's own report. If found it runs `sqlite3 data/job-agent.db ".backup 'data/job-agent.db.bak-<YYYYmmddHHMM>'"` (local time), checks the copy is non-empty and `PRAGMA integrity_check` returns `ok`, and keeps only the 5 newest `job-agent.db.bak-*` files. The file name goes into the squash commit body and the card summary. If the backup fails, nothing is merged and the card is held `[OWNER]` with the reason. No line, no backup. Nothing reads or prints the DB contents; restoring is manual.
