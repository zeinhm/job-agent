# Application questions from public ATS job APIs (t_5c4e4567)

Checked 2026-10-15. Only `GET` requests, UA `job-agent-research/0.1`, no login, no key, one request at a time (>= 2 s apart in practice).
Public company boards used as samples: Greenhouse `gitlab`, Lever `spotify`, Ashby `ashby`, SmartRecruiters `BoschGroup`, Workable `huggingface`, Recruitee `bunq`.
No form was opened in a browser, nothing was POSTed.

## Answer
- **Greenhouse**: documented, keyless `GET .../jobs/{id}?questions=true` returns every question (label, required, type, options). **Implement.**
- **Recruitee**: questions are already inside the offers list we poll (`open_questions[]`), zero extra requests. **Implement.**
- **Workable**: keyless but undocumented `GET https://apply.workable.com/api/v1/jobs/{shortcode}/form` returns the form. **Implement behind the same "tolerated" caveat as the widget; lowest priority.**
- **Lever**: no questions via API (docs say so). The apply page is a plain public GET with questions server-rendered in HTML. **Exclude** (default).
- **Ashby, SmartRecruiters**: none (no public GET; apply pages are JS shells without questions). **Exclude.**

## 1. Greenhouse
- **Endpoint**: `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true`. The list endpoint (`/jobs`) does not carry questions; one detail call per job.
- **Auth**: none. Official: "Job Board data is publicly available, so authentication is not required for any GET endpoints" (only the application POST needs Basic Auth).
- **Response**: job fields plus `questions[]`, `location_questions[]` (only if configured), `compliance[]` (EEOC, only if enabled), `demographic_questions` (only if the org has Greenhouse Inclusion; `null` on the gitlab sample).
- **Question shape**: `{ "label", "required", "description", "fields": [ { "name", "type", "values": [ {"label","value"} ] } ] }`.
  Field `type` seen: `input_text`, `input_file`, `textarea`, `multi_value_single_select` (also `multi_value_multi_select`, `input_hidden` per docs, not seen). Options are in `fields[].values` (a yes/no select is `[{"label":"Yes","value":1},{"label":"No","value":0}]`; the country select had 197 values).
  One question can hold two fields (resume: `resume` file + `resume_text` textarea).
- **Standard vs custom**: standard fields have fixed names: `first_name`, `last_name`, `email`, `phone`, `resume`, `cover_letter`. Custom questions are named `question_<id>` (including LinkedIn URL, "preferred name", visa, prior-employee, residence). EEOC/demographic blocks are separate arrays and are optional/voluntary: never auto-answer.
- **Sample** (gitlab job 8860302002, `?questions=true`, 13 questions, trimmed):
```json
{"label":"First Name","required":true,"fields":[{"name":"first_name","type":"input_text","values":[]}]}
{"label":"Resume/CV","required":true,"fields":[{"name":"resume","type":"input_file"},{"name":"resume_text","type":"textarea"}]}
{"label":"LinkedIn Profile","required":false,"fields":[{"name":"question_38624168002","type":"input_text"}]}
{"label":"Are you subject to any employment agreements and/or post-employment restrictions with ...","required":true,"fields":[{"name":"question_38624170002","type":"multi_value_single_select","values":[{"label":"Yes","value":1},{"label":"No","value":0}]}]}
{"label":"What is your current country of residence?","required":true,"fields":[{"name":"question_38624174002","type":"multi_value_single_select","values":[ ...197 ]}]}
```
  `compliance[0]` = `{"type":"eeoc","questions":[{"label":"VeteranStatus","required":false,"fields":[{"name":"veteran_status","type":"multi_value_single_select"}]}, ...]}`.
- **Terms / rate limit**: the Job Board docs state no terms and no rate limit. `boards-api.greenhouse.io/robots.txt` only disallows `/embed/`. Reading is the documented purpose of the GET endpoints. (Greenhouse's separate Harvest API limit of 50 req/10 s does not apply to the Job Board API; the Job Board limit is UNKNOWN.)

## 2. Lever
- **Endpoint for questions**: none. `GET https://api.lever.co/v0/postings/{site}/{id}` returns only title/description/lists/categories/applyUrl/hostedUrl (keys verified live; no question keys). The official README lists under "The API does not": "Expose custom questions built into your job postings".
- **Apply**: `POST /v0/postings/SITE/POSTING-ID?key=APIKEY` needs an API key; out of scope.
- **Apply page** `GET https://jobs.lever.co/{site}/{id}/apply`: plain public GET, HTTP 200, 769 KB, server-rendered HTML form (no login). Questions are in the HTML: standard inputs (`name`, `email`, `phone`, `org`, `location`, `urls[LinkedIn]`, `urls[GitHub]`, ...), custom questions as `cards[<uuid>][field<n>]`, EEO/diversity surveys as `surveysResponses[<uuid>][...]`, labels in `<div class="application-label">`. Submit is protected by hCaptcha (`h-captcha-response`).
- **Terms / rate limit**: README has no terms; says published postings "may be scraped by third parties". `jobs.lever.co/robots.txt`: `Allow: /`, `Crawl-delay: 1`. 429 limit documented only for application POSTs (2/s).
- **Recommendation: exclude from Phase 4.** It is technically a plain public GET, but it means parsing apply-page HTML (fragile; conventions section 7 says "unless the research shows plain GET with no terms problem"). No terms were found that forbid it, so it is a candidate for a later phase if Lever turns out to be a large share of matches. Lever postings still get the apply link; the owner answers on the page.

## 3. Ashby
- **Endpoint**: none for questions. `GET https://api.ashbyhq.com/posting-api/job-board/{name}` (keys verified: no form/question key); official page (https://developers.ashbyhq.com/docs/public-job-posting-api) does not mention application form questions, auth, rate limits or terms.
- **Apply page** `GET https://jobs.ashbyhq.com/{org}/{id}/application`: HTTP 200, 137 KB, but a JavaScript app shell; grep for `fieldEntries`/`applicationForm` found nothing, i.e. questions are not in the HTML. The SPA loads them through a POST GraphQL call (`jobs.ashbyhq.com/api/non-user-graphql`, from general knowledge, NOT tested); POST is out of scope.
- **Recommendation: exclude.**

## 4. SmartRecruiters
- **Endpoint**: none public. Application-form configuration is `GET https://api.smartrecruiters.com/postings/{id}/configuration`, which returns `401 {"message":"Authentication data missing"}` without a key (tested). `/v1/companies/{id}/postings/{id}/configuration` and `/questions` return 404.
- **Posting detail** (`/v1/companies/{id}/postings/{id}`, already used) has no questions (keys listed in t_bb8a60de; re-checked, none).
- **Apply page** `jobs.smartrecruiters.com/{co}/{id}-{slug}`: 200, 123 KB, no `<form>`/screening-question markup in the HTML (JS app).
- **Recommendation: exclude.** Nothing keyless exists.

## 5. Workable
- **Endpoint**: `GET https://apply.workable.com/api/v1/jobs/{shortcode}/form` (tested on `huggingface` / `81B46579FE`: 200 `application/json`). `.../api/v1/accounts/{slug}/jobs/{shortcode}/form` and `.../api/v2/accounts/{slug}/jobs/{shortcode}/form` are 404. `GET .../api/v2/accounts/{slug}/jobs/{shortcode}` gives job detail only.
- **Auth**: none. **Undocumented**: not in the official API reference (token-only `spi/v3`). It is what Workable's own apply page uses (inference, not verified).
- **Response**: array of sections `[ {"name":"Personal information","fields":[...]}, {"name":"Profile",...}, {"name":"Details",...}, {"name":null,"fields":[gdpr]} ]`.
- **Question shape**: `{ "id", "label", "type", "required", "options": [ {"name","value"} ] }`. Types seen: `text`, `email`, `phone`, `file`, `paragraph`, `boolean`, `dropdown`, `group` (education/experience repeaters).
- **Standard vs custom**: standard ids `firstname`, `lastname`, `email`, `phone`, `education`, `experience`, `resume`, `cover_letter`, `gdpr`, `avatar`. Custom ids are `CA_<n>` (account-level, e.g. "Github profile", "Expected salary", "Notice period") and `QA_<n>` (job-level questions).
- **Sample** (huggingface, trimmed):
```
Personal information  firstname First name text true | lastname | email email true | phone phone false
Profile               resume Resume file true | CA_47143 "Github profile" paragraph true | CA_47383 "Linkedin" paragraph true
Details               cover_letter paragraph false | CA_10626 "Expected salary" text false
                      CA_10627 "Notice period / availability" dropdown false options:[{"name":"139527","value":"Availab..."}]
                      CA_10628 "Are you eligible to work in the country you are applying?" boolean false
                      QA_11844076 "Why Hugging Face, and where would you make the biggest difference in this role? ..." (long text)
(no section)          gdpr boolean true
```
- **Terms / rate limit**: Workable's published terms (https://www.workable.com/terms) are customer-facing and say nothing about candidate-facing automated reads; clause 4.5.4 forbids circumventing "fair usage limitations" of the Services. No rate limit published; earlier research saw Cloudflare caching, no limit headers. Treat as tolerated, same as the widget.

## 6. Recruitee
- **Endpoint**: the same `GET https://{slug}.recruitee.com/api/offers/` we poll. No extra request.
- **Auth**: none (keyless, tested). The doc page https://docs.recruitee.com/reference/careers-site-api lists `GET /offers/` but shows no field list, `open_questions` is not mentioned there (field observed live only).
- **Fields per offer**: `open_questions[]` (14-19 per bunq offer), `dynamic_fields`, and the standard-field switches `options_cv`, `options_cover_letter`, `options_phone`, `options_photo`, `options_salutation`, `options_title` (values like `off` / `required` / `optional`; bunq: `options_cv: off`, `options_phone: required`), plus `locations_question*`.
- **Question shape**: `{ "id", "position", "required", "kind", "body", "translations": {"en":{"body"}}, "open_question_options": [ {"id","position","body","translations"} ] }`. `kind` counts over 22 bunq offers: `single_choice` 194, `infobox` 110 (informational text, not a question: skip), `string` 42, `boolean` 35, `text` 3, `multi_choice` 1. `body` can contain HTML (`infobox`).
- **Standard vs custom**: name/email/phone/CV are standard switches (docs: `name`, `phone`, `email`, `cv` required by default); everything in `open_questions` is custom.
- **Sample** (bunq, trimmed):
```json
{"id":4435735,"position":1,"required":true,"kind":"string","body":"What country do you currently live in?","open_question_options":[]}
{"id":4435737,"position":3,"required":true,"kind":"single_choice","body":"Which visa situation fits you best? ...","open_question_options":[{"id":6832271,"position":0,"body":"NL: I am a EU/EEA/Swiss citizen"}, ...6 total]}
```
- **Terms / rate limit**: none published on the page read; the endpoint is part of Recruitee's documented Careers Site API. Do not store `mailbox_email` (see t_bb8a60de).

## Recommendation for Phase 4
| ATS | Implement | Source | Extra requests |
|---|---|---|---|
| Greenhouse | yes (priority 1, documented) | `?questions=true` detail | 1 per job |
| Recruitee | yes (priority 2) | `open_questions` in offers list | 0 |
| Workable | yes, lowest priority, tolerated like the widget; degrade to "no questions" on 401/403/404 | `/api/v1/jobs/{shortcode}/form` | 1 per job |
| Lever | no (exclude; revisit later) | apply-page HTML | - |
| Ashby, SmartRecruiters | no | none | - |

- **Which jobs**: only postings that reach the review queue (kept, passed rules, scored), never the whole board. Fetch lazily when a posting first enters the queue, not at poll time.
- **Pacing**: Greenhouse and Workable: 1 request / 2 s, sequential, per host; cap ~50 question fetches per run. Recruitee: none (comes with the poll, minIntervalMinutes 360 as already recommended). Same UA as the adapters. Stop that source for the run on 401/403/429 (no retry loop).
- **Re-fetch**: once on first queue entry; again only if the posting's `updated_at` changes (Greenhouse list has `updated_at`) or after 7 days while the posting is still open and unreviewed; never for reviewed/closed postings. Recruitee refreshes naturally on each poll; store a hash of the questions and only re-match when it changes. A 404 means the job closed: keep stored questions.
- **Data handling**: question text from public job posts is not personal data, but per conventions section 1 never print question text in logs. Unknown-question rows come from `label`/`body` plus type; options are kept for `choice` matching only.
- **Mapping hint for matching code**: standard ids (Greenhouse `first_name`...`cover_letter`; Workable `firstname`...`gdpr`; Recruitee `options_*`) map to fixed keys; EEOC/demographic/gdpr/infobox are never answered from the bank; salary-like questions ("Expected salary", `CA_10626`) go to the per-posting tier ask (PLAN 5.6).

## Evidence (all GET; trimmed outputs shown above)
```
curl -s -A job-agent-research/0.1 "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs"                                  -> 200
curl -s -A ... "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/8860302002?questions=true"                           -> 200 (13 questions, location_questions [], compliance eeoc)
curl -s -A ... "https://boards-api.greenhouse.io/robots.txt"                                                                -> Disallow: /embed/
curl -s -A ... "https://api.lever.co/v0/postings/spotify?mode=json&limit=1"                                                 -> 200, no question keys
curl -s -A ... "https://api.lever.co/v0/postings/spotify/223f9722-3579-4ff2-b123-e4cc7b0c1a64"                              -> 200, same keys
curl -s -A ... "https://jobs.lever.co/spotify/223f9722-3579-4ff2-b123-e4cc7b0c1a64/apply"                                   -> 200, 769456 bytes, form in HTML, h-captcha-response present
curl -s -A ... "https://jobs.lever.co/robots.txt"                                                                           -> Allow: /  Crawl-delay: 1
curl -s -A ... "https://api.ashbyhq.com/posting-api/job-board/ashby"                                                        -> 200, no form keys
curl -s -A ... "https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application"                            -> 200, 136965 bytes, no questions in HTML
curl -s -A ... "https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/744000154502129"                           -> 200, no question keys
curl -s -A ... ".../postings/744000154502129/configuration" (v1/companies path)                                             -> 404
curl -s -A ... ".../postings/744000154502129/questions"                                                                     -> 404
curl -s -A ... "https://api.smartrecruiters.com/postings/744000154502129/configuration"                                     -> 401 {"message":"Authentication data missing"}
curl -s -A ... "https://jobs.smartrecruiters.com/BoschGroup/744000154502129-operator-2-2nd-shift-"                          -> 200, 123336 bytes, no form markup
curl -s -A ... "https://apply.workable.com/api/v1/widget/accounts/huggingface"                                              -> 200, no question keys
curl -s -A ... "https://apply.workable.com/api/v2/accounts/huggingface/jobs/81B46579FE"                                     -> 200, detail only
curl -s -A ... "https://apply.workable.com/api/v1/accounts/huggingface/jobs/81B46579FE/form"                                -> 404
curl -s -A ... "https://apply.workable.com/api/v2/accounts/huggingface/jobs/81B46579FE/form"                                -> 404
curl -s -A ... "https://apply.workable.com/api/v1/jobs/81B46579FE/form"                                                     -> 200 application/json (4 sections)
curl -s -A ... "https://bunq.recruitee.com/api/offers/"                                                                     -> 200, open_questions on all 22 offers
```
Outputs were parsed locally with `jq` from files under /tmp (not committed).

## Sources (checked 2026-10-15)
- Greenhouse Job Board API: https://docs.greenhouse.io/job-board.html (redirect from developers.greenhouse.io/job-board.html)
- Lever Postings API README: https://github.com/lever/postings-api
- Ashby public job posting API: https://developers.ashbyhq.com/docs/public-job-posting-api
- SmartRecruiters Posting API: https://developers.smartrecruiters.com/docs/posting-api (via t_bb8a60de, checked 2026-10-09)
- Workable terms: https://www.workable.com/terms ; API reference https://workable.readme.io/reference/jobs (via t_bb8a60de)
- Recruitee Careers Site API: https://docs.recruitee.com/reference/careers-site-api
- Live endpoints listed under Evidence; existing notes: docs/research/t_bb8a60de-ats-board-apis.md, t_e94c6eb7-ats-apis.md, t_5f31fe9d-apply-routes.md

## Confidence
High: Greenhouse (documented + live), Recruitee shape (live), Lever and Ashby/SmartRecruiters "none" (live + Lever docs).
Medium: Workable form endpoint (live but undocumented; may change), Recruitee `kind` list (only bunq observed; other kinds may exist).
Low: rate limits for all (none published); the Ashby GraphQL path (not tested).
Would raise confidence: a second Greenhouse and a second Recruitee/Workable board (more field types, `multi_value_multi_select`, `demographic_questions` non-null); reading the SmartRecruiters, Recruitee and Ashby ToS; asking Workable support whether the form endpoint is supported.
