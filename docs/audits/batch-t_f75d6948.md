# Audit: live-run fixes (t_f75d6948)

Audited: `main` @ 2f071c4 vs 838942c (round start). Verdict: **FAIL** (1 MAJOR, 4 MINOR). No tag. Nothing committed (FAIL).

## 1. Check

`pnpm install --frozen-lockfile` ok; `pnpm check`: **Test Files 68 passed (68), Tests 1158 passed (1158)**; typecheck, lint and pre-commit hook tests (31 passed, 0 failed) green.

## 2. Before / after smoke (back to back, same hour, `bin/smoke`, example configs)

Assumption: a second worktree could not be created in this run (approval needed), so the same detached worktree was checked out at 838942c, smoked, then at 2f071c4, smoked. Same code paths, sequential.

```
before (838942c): processed 1244, kept 472, rejected 772 (location 379, indonesia 0, role 574, salary 1), flagged 1179
after  (2f071c4): processed 1238, kept 68, rejected 1170 (location 1077, indonesia 0, role 642, salary 1, language 195), flagged 1172
```

Per-source discover (before / after): himalayas 200/200, remoteok 6/6, remotive 5/5, weworkremotely 14/14, hn 110/110, arbeitnow found 950 new 873 / found 950 new 867, greenhouse 40/40.

Kept by source (before -> after): arbeitnow 432 -> 30, hn 28 -> 28, himalayas 5 -> 5, greenhouse 1 -> 1, remoteok 2 -> 1, remotive 2 -> 1, weworkremotely 2 -> 2. Kept dropped 472 -> 68 (phase-2 baseline: 545, 495 Arbeitnow).

Join on `source` + `external_id`: kept before and rejected after **359** (arbeitnow 357, remoteok 1, remotive 1); kept in both 66; kept before and absent after 47 (feed churn); rejected before and kept after **0**.

### Kept before, rejected after, with an engineering-target title or non-Arbeitnow

| Source | Title | Location / remote | New rule | Verdict |
|---|---|---|---|---|
| remotive | Software Engineer / AI Code Trainer (Python, Web, Full Stack) | "USA, UK, India, Australia, Ireland, NZ, Philippines, Pakistan, Singapore, Mexico" / remote unset | location step 5 "onsite" | Result right (country list without Indonesia = restricted), label wrong. MINOR 2 |
| remoteok | Telefondienst fuer Tierarztpraxis Neuruppin | Neuruppin | location onsite + language | correct |
| arbeitnow | Full Stack Developer PHP / TypeScript in Hamburg oder Remote | Remote, Homeoffice / remote=1 | language ("sehr gute Deutschkenntnisse") | correct |
| arbeitnow | Senior Fullstack Entwickler PHP/Laravel - Remote | Remote/Leipzig / remote=0 | language (German title) | correct |

All other target/generic-engineering titles rejected from Arbeitnow (full stack, frontend, software engineer ...) have "source marks the posting as not remote" (remote=false, no remote wording) or a German/French language requirement. No English, genuinely remote engineering posting from these feeds was lost by the location/role rules.

### Language rejects not caused by location (sample of 15 of 195)

14 of 15 are right (German-language title, "Deutschkenntnisse" B2/C2 requirement). One is a false reject: **Lead AI Engineer (m/w/d)**, arbeitnow, "Stuttgart & Remote", see Finding 1.

### 20-plus spot check of postings still kept after

Examples the owner's rules should arguably catch but do not (all kept with a `*_unclear` flag, so the LLM stage costs money but nothing is lost):
- arbeitnow remote=0 "Germany Remote", "Berlin, DACH remote, Poland Remote", "Paris - Full Remote": country-restricted remote, step 2 country restriction only recognises "Remote, X" / "X (Remote)" / "Countries: X", not "X Remote".
- hn "Berlin, Germany (or remote, CET/CEST overlap)": `worldwide` from the word "worldwide" in the company blurb ("used by thousands of teams worldwide"); pre-existing description-signal weakness, not from this round.
- English non-engineering titles still kept as `role_unclear`: "Growth Manager", "Direct Tax Lead", "Impact Producer", "Freelancer - Group Fitness Instructor", "KYC/AML Associate". Role rule 2 only covers German/French non-engineering words; English ones are out of the owner's four rules, noted for the PM.

## 3. Enrich (item 4)

Read `packages/core/src/llm/client.ts` (lines 57-82, 238-251). `sanitizeErrorText` redacts the configured key and `sk-ant-[A-Za-z0-9_-]+` before the 300-character cap (so the cap cannot cut a key in half); headers, prompts and bodies are never read.

Break-the-code:
- (d) worst-case cost for every failed call (`record("error", null, reserve)`): **8 tests fail** (enrich.test "an API error response is recorded at $0...", llm.test 400/401/429/529 rows, refused connection, 429/529 retry). Reverted.
- Redaction removed: **3 tests fail** (llm.test "redacts the key and sk-ant strings and caps...", "never logs the key...", enrich.test "aborts after 3 consecutive API errors ... no key in output"). Reverted.
- Timeout keeps the reserved cost: covered by the llm.test timeout case (passes; the `status !== undefined || isNotSent` split keeps `reserve` for a timeout).

## 4. Break-the-code (items 5a-5c)

All reverted; `vitest run packages/pipeline/src/filters packages/core`: 19 files, 491 tests pass after revert.
- (a) drop `input.remote !== true` in location step 5: fails `location.test` "Berlin with remote: true is not restricted by the onsite rule", "on-site wording with a remote option is not restricted by the on-site rule", and the location golden gate.
- (b) widen STAGE_INTERNSHIP to any whole word "stage": fails `role.test` "does not read the English word Stage as an internship" and the role golden set.
- (c) remove the language `isOptional` guard: 5 `language.test` "keeps ..." cases (Fluent German is a plus, German (C1) nice to have, Native Spanish speaker is an advantage, Deutschkenntnisse von Vorteil, Francais courant un plus) and the language golden set fail.
- (d) see section 3.

## 5. Personal-data sweep

grep of the whole worktree (excluding node_modules, .git, lockfile) for owner name/handle, gmail, +62, IPv4: only the public repo URL in package.json, placeholder `...@gmail.com` addresses in scam fixtures/tests (invented), a comment in bin/escalate. `config/` in the worktree holds only `*.example.*`. New golden rows (language.json, location.json, role) use invented/public titles and short snippets. Clean.

## 6. Docs

`docs/decisions.md` entries (Location 41-43/47, role 46, language 48, failed-call cost 44) match the code. `docs/running.md` lines 71, 95-101 match (language in `process`, $0 error / timeout reserve, `llm call failed` log, abort line). Decision 47 still says Remotive "Software Engineer / AI Code Trainer" is "still rejected": it was *kept* (unclear) in the 838942c baseline, newly rejected now; the entry's "before" is an earlier iteration, not 838942c. Wording only.

## Findings

**[MAJOR] packages/pipeline/src/filters/language.ts:103-112 and keywords.ts:1084 - negated or neighbouring-sentence "not required" wording does not protect a German mention; real postings and plain English are falsely rejected.**
`isOptional` only looks inside the same clause (clauses are split on `.`, `;`, newline, "but", "while"), and the optional list lacks "nie Voraussetzung", "keine Voraussetzung", "beliebigem Niveau", "not a requirement", "no ... needed".
Repro (tsx against main):
```
classifyLanguage({title:"Lead AI Engineer (m/w/d)", descriptionText:"* Deutschkenntnisse auf beliebigem Niveau. In Teilen des Unternehmens hilfreich, fuer diese Rolle aber nie Voraussetzung."})
  -> reject: description requires a language ("Deutschkenntnisse")
classifyLanguage({title:"Backend Engineer", descriptionText:"German is not required. Fluent German is not a requirement for this role."})
  -> reject: description requires a language ("Fluent German")
```
Live: arbeitnow "Lead AI Engineer (m/w/d)", "Stuttgart & Remote", remote-first, whose text says German is never a prerequisite (the only language hit in that posting), is now rejected; it was kept before. A rule reject is final, so the owner never sees it. Fix: add negation/"not a requirement/prerequisite/needed", "nie/keine Voraussetzung", "beliebigem Niveau" to the optional list or let a "not required" clause protect the previous clause too; add these as `language.test` and golden rows (the existing "a plus / nice to have" tests cannot catch this).

**[MINOR] packages/pipeline/src/filters/location.ts:241-253 / sources (remotive, remoteok, himalayas, weworkremotely) - remote-only boards never set `remote: true`.** A country list from Remotive (USA, UK, India, ..., Mexico) is labelled "onsite" and a one-country list ("Germany") would be too. The decision is right (restricted, no Indonesia), but the reason text is misleading in the digest/report. Either set `remote: true` in those adapters (step 5 then yields `unclear`/restricted via the country list rule) or phrase the reason as "location names places without remote wording".

**[MINOR] location.ts:41-68 - "<Country> Remote" is not a country restriction.** "Germany Remote", "Paris - Full Remote" stay `unclear` and cost an extraction each. Not one of the owner's four rules; for the PM.

**[MINOR] digest/index.ts:394-401 - the rejected-by-language count re-runs `classifyLanguage` on posting text instead of reading the stored reason** (same pattern as role). If keywords change later, the digest count can disagree with stored decisions; use `parseList(r.reasons)` like the salary count.

**[MINOR] docs/decisions.md:47 - the Remotive "still rejected" statement is not true against 838942c** (it was kept as unclear). Wording only.

## Fix tasks

1. Language optional/negation guard (MAJOR): extend `LANGUAGE_OPTIONAL_PHRASES` (or the clause logic) for "not a requirement / not needed / no ... required", German "nie / keine Voraussetzung", "beliebigem Niveau", French "pas obligatoire"; add the two repro texts to `language.test.ts` and `language.json`. High risk (fix task).
2. Remote-only adapters set `remote: true`, or reword the step-5 onsite reason (MINOR).
3. Digest language count from stored `reasons` (MINOR).
4. For the PM, not a defect of this round: "X Remote" country restriction; English non-engineering titles kept as `role_unclear`; "worldwide" in company blurbs.

## Note for the owner

Postings already analysed in an existing DB keep their old decision (`process` only analyses new or edited postings); a fresh DB, or a re-process if one exists by then, applies the new rules. Smoke DBs: `data/handoff/f75/{before,after}/smoke.db`.
