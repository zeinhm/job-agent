# Phase-end audit #3b: Phase 3 re-audit after the fix round (t_2ea13484)

Audited point: `main` = origin/main `fb47d31`. Range: `git diff 1608cff..main` (45 files, +1546/-561), read as a whole, with weight on `keywords.ts` (location and language cards), `apply-links/index.ts` (two cards), `docs/running.md`, `scripts/crontab.example` and the new `docs/decisions.md` entries.

Verdict: **PASS** (0 BLOCKER, 0 MAJOR, 3 MINOR). Tags: `audit-7` on `1608cff` (phase-end audit #3, still missing: `git tag` shows audit-1..audit-6), `audit-8` on `fb47d31`.

## 1. Setup
- Fresh detached checkout of `main` (`fb47d31`), `pnpm install --frozen-lockfile`: ok.
- `pnpm check`: typecheck clean, ESLint + Prettier clean, hook tests `31 passed, 0 failed`, python `Ran 10 tests ... OK` (its final line `OK`).
- `vitest run`: `Test Files 84 passed (84)`, `Tests 1644 passed (1644)` (1554 at `1608cff`: +90).

## 2. Cross-card review
- `keywords.ts`: location card removed `must reside in`, `must be located in` and the four fixed `authorized to work in ...` entries from `RESTRICTION_PHRASES` and added the work-authorization family to `HIRING_RESTRICTION_PHRASES` (`:65`); the language card added `LANGUAGE_NEGATION_PHRASES/PATTERNS`, `LANGUAGE_MARKET_NOUNS` (`:1284`) and moved "not required"/"nicht erforderlich" out of the optional list into the negation list. The two edits touch separate lists; no shared symbol changed. No overlap or conflict.
- `apply-links/index.ts`: card t_6e6fdf4a (same-company check `:304-318`, placeholder skip `:410`) and card t_45be12f8 (`LlmApiError` branch `:505`, `decideApplyType` call). Different functions; the new `company` lookup in the Haiku path is local. Consistent.
- `(unknown)`: one constant `UNKNOWN_COMPANY` (sources) -> `isPlaceholderCompany` (`apply-links/placeholder.ts`) used by `resolve-apply`, `save-ats.ts:57` and `company-research.ts:238`. No other probe path found (companies with no board are never polled).
- YC: `grep -rniE "ycombinator|algolia|workatastartup|fetchYc|yc_directory"` in `packages bin scripts workers config`: the only non-test hits are `core/src/http.ts` (guard), `normalize/company-domain.ts` (never-own host list), `hn/index.ts` (`hn.algolia.com`, a different service; builds `news.ycombinator.com` item URLs but never requests them) and `db/schema.ts` (`yc_directory` enum value, kept for stored rows). `yc.ts`, `discover-companies` YC part, the three YC fixtures and `discover-companies.yc.test.ts` are deleted.
- `docs/running.md` and `scripts/crontab.example` agree with the code and the decision entries: `discover-companies` weekly `0 7 * * 1`, no YC line or key text. `running.md` still says "Run it weekly" and matches the crontab; the `docs.test.ts` change keeps the doc/CLI summary check in sync.
- `docs/decisions.md`: the eight new entries (YC dropped, work-authorization = restricted, `bin/agent-step` closed without code, weekly discover-companies, language negation, apply-link safety, Haiku `decideApplyType`, location rules) match the code I read; I did not diff the golden row ids against the entry text.
- `docs/PLAN.md:53` still lists "YC Work at a Startup" and the YC Algolia bonus; the decision entry says it supersedes those rows. Wording only (MINOR 3).

## 3. Status of the items

| Item | Status | Where / proof |
|---|---|---|
| YC removal: no request to `ycombinator.com` or YC's Algolia index from any path | **closed** | Code removed (`sources/src/discovery/yc.ts`, YC part of `discover-companies.ts`). Host guard `core/src/http.ts:226` `assertNotYc` (ycombinator.com, `*.`, workatastartup.com, also on redirects). Tests: `http.test.ts` "YC host guard" (6 hosts + redirect), `discover-companies.test.ts:222` (no request to YC/`algolia.net`/workatastartup, no yc line), `apply-links.test.ts:1060,1073` (YC links in posting text / careers redirect are never requested). Break (a): guard made a no-op -> 6 failed in `http.test.ts` |
| Weekly `discover-companies` in the crontab example | **closed** | `scripts/crontab.example` `0 7 * * 1`; `running.md`; decision entry |
| P3-1 YAML scalars | **closed** | `save-ats.ts:22` always `JSON.stringify`; `save-ats.test.ts` "quotes YAML keyword and number-like names so they read back as the same strings". Break (b): old plain-scalar rule -> 2 failed |
| P3-2 freshness gap to now | **closed** | `freshness.ts:52-58`; `freshness.test.ts` ("now - last ok: 65 min is not late, 66 is", "ok at 05:05 ... 305 min and LATE", "one ok run"). Break (c): initial gap 0 -> 5 failed |
| P3-3 `(unknown)` company | **closed** | `placeholder.ts`; `index.ts:410`, `save-ats.ts:57`, `company-research.ts:238`; tests `apply-links.test.ts`, `company-research.test.ts` (+10), `save-ats.test.ts` |
| P3-4 corrupt Brave counter | **closed** | `search.ts:27` zod-checked, anything unreadable = spent; `search.test.ts` "a corrupt counter (...) counts as spent" x7 (not JSON, empty, object, null, array, string count, negative). Break (d): `return 0` -> 7 failed |
| P3-5 ledger / phase-3 report | **closed** | `docs/audits/phase-3.md` saved from `t_747e3bc8-report.md`, ledger rebuilt (this card) |
| Batch 5.1 "must be located in Europe or Asia" | **closed** | covering place check in `location.ts` (`findTextRestriction`), `keywords.ts:65`; `location.test.ts` work-authorization block, golden rows loc-152..161. Probe: "Candidates must be located in Europe or Asia" -> `worldwide` |
| Batch 5.2 "French speaker markets" | **closed** | `language.ts` `speaker(?!s? <market noun>)`; `language.test.ts` "not-required wording and markets". Probe: "Our customers are French speakers." -> ok |
| Batch 5.3 work authorization, Worldwide | **closed** | owner decision = restricted. `keywords.ts:65` family; `location.ts:285` also runs on the location/tags fields. Probe: "Must be authorized to work in the United States." with Worldwide -> `restricted`; "authorised to work in Indonesia" -> `worldwide`. Break (f): "authorized to work in" back in `RESTRICTION_PHRASES` -> 9 failed |
| Batch 5.4 `bin/agent-step` | **closed** | decision entry, no code change |
| Batch 6.1 YAML quoting | **closed** | see P3-1 |
| Batch 6.2 careers-page board same-company | **closed** | `index.ts:304-318` (name via `isSameCompany` or own slug candidates; else `unconfirmed`), note "careers page board not confirmed as the company's"; tests in `apply-links.test.ts` (+125 lines) |
| Batch 6.3 `company_form` / `paid_aggregator` verified by code | **closed** | `llm-step.ts:88` `decideApplyType`; `llm-step.test.ts` (table, board/ATS/paid host, foreign host). Break (extra): `company_form` always accepted -> 3 failed |
| Batch 6.4 stale-lock takeover race | **closed** | `bin/run-hourly:13-35` takeover lock + second age check; `run-hourly.test.ts:108` (20 rounds) and `:138` (pause between check and takeover). Break (extra): drop second `is_stale` -> the `:138` test fails |
| Batch 6.5 API outage parks the posting 7 days | **closed** | `index.ts:505` `LlmApiError` -> no row, step stops, `deferred`; `apply-links.test.ts`/`llm-step.test.ts`. Invalid output still stores the free result (as documented) |
| Batch 6.6 `BLOCK_PATTERN` bare number | **closed** | `workers/jobspy/run.py:39` numbers only next to status wording; `test_run.py` (+26 lines), passes in `pnpm check`. The break check on the pattern could not be run (a standalone python call is not allowed here); the combined test run passed |
| t_f75d6948 MAJOR (German "not required") | **closed** | `keywords.ts:1284`, `language.ts:143` `protectedLanguages`; `language.test.ts` repro texts from the audit ("Deutschkenntnisse auf beliebigem Niveau ... nie Voraussetzung", "German is not required. Fluent German is not a requirement ..."), `language.golden.test.ts`, new golden rows. Break (e): `isNegation` returns false -> 9 failed |

## 4. Live: `bin/smoke` (temp DB, example configs, no key, no `--with-jobspy`)
```
himalayas: ok, found 200, new 200
remoteok: ok, found 16, new 16
remotive: ok, found 2, new 2
weworkremotely: ok, found 17, new 17
hn: ok, found 33, new 33
arbeitnow: ok, found 1433, new 1309
greenhouse: ok, found 29, new 29
linkedin_posts: skipped (BRAVE_API_KEY not set)
process: processed 1604, kept 68, rejected 1536 (location 1407, indonesia 0, role 856, salary 1, language 216), flagged 1551
enrich: ANTHROPIC_API_KEY not set, LLM stages skipped / scam rules checked 68 postings, suspicious 0
resolve-apply --limit 3: checked 3, methods: ats_db 0, ats_board 1, careers_page 0, posting_text 0, source 2; types: ats 1, ..., unknown 2; requests 9
companies.yaml: added 1 (backup <smoke dir>/backups/companies.yaml.2026-10-14T15-24-55Z)   + ElevenLabs (ashby/elevenlabs)
status rows: analysis 1604, apply_links 3, companies 791, intel 68, llm_calls 0, postings 1606, source_runs 8
```
No YC line and no YC source in `source_runs`; the smoke run never lists a YC step. Against audit #3 (processed 1719, kept 59, location 1522, language 264): the feeds moved (arbeitnow new 1309 vs 1421, hn 33 vs 35, greenhouse 29 vs 30), so processed is 115 lower. Location is 87.7% of rejects (88.2% before). Language fell 264 -> 216 (-18% against -6.7% for the volume) and kept rose 59 -> 68: consistent with the language "not required" fix and the location text rules; no row-by-row comparison was run (the earlier code was not run on the same feed snapshot).

## 5. Break-the-code (each reverted with `git checkout -- .`, tree clean afterwards)
| Change | Result |
|---|---|
| (a) YC host guard made a no-op | 6 failed in `http.test.ts > YC host guard` |
| (b) old plain-scalar rule in `save-ats.ts` | 2 failed in `save-ats.test.ts` |
| (c) freshness gap starts at 0 (no `now - last ok`) | 5 failed in `freshness.test.ts` |
| (d) corrupt Brave counter returns 0 | 7 failed in `search.test.ts` |
| (e) `isNegation` always false | 9 failed (language.test.ts x8, `language.golden.test.ts`) |
| (f) `"authorized to work in"` back in `RESTRICTION_PHRASES` | 9 failed (keywords, location, golden) |
| extra: `company_form` accepted without code check | 3 failed in `llm-step.test.ts` |
| extra: second age check dropped in `bin/run-hourly` | 1 failed in `run-hourly.test.ts` (the pause test) |

Extra probes (edge texts, `tsx`, probe file removed): "Fluent German is required. A car is not required." -> reject; "English is not required, but fluent German is." -> reject; "German is not required. Native French speaker required." -> reject; "German is not required.\nNative French speaker needed." (new paragraph) -> reject. Location with `locationText: "Remote (must reside in Germany)"` -> `restricted`; `"Remote, must be located in Asia"` -> `apac_ok`.

## 6. Personal-data sweep
- Tracked `config/` files: only `README.md`, `*.example.*`, `private-patterns.example.txt`. No `data/` tracked. I did not read `config/` or `.env`.
- Added lines in `1608cff..main`: no e-mail-like strings (the only `@` hits are `@job-agent/...` imports), no phone-like or long digit runs, no `IDR` amounts. The only IP in tracked sources is `203.0.113.5` (RFC 5737) in `normalize.test.ts:299`.
- Owner name search (first/last name, handle, company): hits only `package.json:2` (the public repository URL) and `bin/escalate:2` (a comment naming `NEEDS-ZEIN.md`, the owner's first name; not in this round's diff, MINOR 2). The e-mail/phone grep patterns over the whole tree were blocked by the tool permissions, so those two checks cover only the added lines of this round and the audit #3 sweep.
- `docs/audits/phase-3.md` (saved from the #3 report): contains only the fake persona placeholder `16500000` (example config) and `hr@gmail.com`-style fixture mentions; no real data.

## Findings

### [MINOR] packages/pipeline/src/filters/keywords.ts:65 / location.ts — negated work-authorization wording is still read as a restriction
`classifyLocation({ locationText: "Worldwide", descriptionText: "We do not require you to be authorized to work in the US." })` -> `restricted`. The sentence logic looks only at the phrase and the places, not at a negation. A reject is final, so a rare posting that says it does not need work authorization is lost. The same happened before the round (the old fixed list), so it is not worse. Fix (optional): a "do not require / no ... required" guard in `findTextRestriction`.

### [MINOR] bin/escalate:2 — the owner's first name in a committed comment
Pre-existing, outside this round. Not a secret, but the rule is "personal data never reaches a commit"; a neutral wording ("the owner") costs nothing.

### [MINOR] docs/PLAN.md:53 — the "YC Work at a Startup" source row and the YC Algolia bonus are still written as plan
The decision entry of 2026-10-14 supersedes them, but PLAN.md was not edited (AGENTS.md: decisions.md is append-only, PLAN.md is the source of truth). Mark the row as dropped so a new agent does not rebuild it.

## Deep dive
- `core/http.ts` guard (a) and its redirect path; the removal of the YC code paths (grep, deleted files, fixtures).
- `language.ts` `protectedLanguages` (the most complex new logic): read fully, probed with eight adversarial texts (negation of a neighbouring different language, a different object negated in the same paragraph, a new paragraph).
- `bin/run-hourly` takeover logic read line by line; `find ... -mmin +10` cleanup of an abandoned `hourly.takeover` lock is safe (the next run takes over, this one skips).
- `decideApplyType` and the `LlmApiError` branch read with their callers.

## Fix tasks
None required. Optional: (1) negation guard for work-authorization wording; (2) neutral wording in `bin/escalate`; (3) PLAN.md YC row marked dropped.

## Owner items still open (not code)
- Confirm that `ask_idr_month: 16500000` in `config/salary.example.yaml` is not the real number (agents cannot read `config/`).
- The live proof (a day of hourly runs with the JobSpy worker) is still the owner's to read; no agent ran LinkedIn or Indeed.

## Tags and ledger (for the automation; I did not commit or tag)
- `audit-7` on `1608cff` (phase-end audit #3, missing).
- `audit-8` on `fb47d31` (the `main` commit audited here).
- `docs/audit-ledger.md` rebuilt: header row only, `Last audit tag: audit-8`, counts `medium 0 / 5 - low 0 / 10`.

## Verdict
PASS
