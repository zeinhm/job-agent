# ATS terms on automated application submission, and bot checks (Greenhouse, Lever, Ashby, Workable, Recruitee)

Task t_ec2ae4c6. Checked 2026-10-17. Input for Phase 6 (PLAN 6 tiers, PLAN 10). Nothing is submitted in Phase 5.
Not legal advice; open questions for the owner are at the end.

## Answer (short)
- **No ATS's own terms say anything about a candidate (or a tool acting for one) filling or submitting the public apply form by automation.** The terms we could read bind the *employer customer* (MSA / customer ToS), not candidates. "Nothing found" is not "allowed": the closest clauses are circumvention / interference / fair-use clauses that would be triggered by getting past a bot check or hammering a host.
- **All five have a bot check or spam score on the hosted form** (Greenhouse reCAPTCHA Enterprise + possible email code; Lever hCaptcha; Ashby reCAPTCHA + score threshold; Workable Turnstile key in page; Recruitee invisible captcha, default on). Per AGENTS.md the filler stops on any of them. So "auto-submit" is not reachable without passing a CAPTCHA, which is forbidden.
- **The official submit APIs are employer-side** (key/token from the employer's admin), so a candidate cannot use them for another company's board. Recommendation for Phase 6: **semi-automated (prefill, human clicks submit) for all five; auto-submit not recommended anywhere.**

## 1. Terms read (what, where, date)

| ATS | Documents read | Automated candidate submission | Closest clauses |
|---|---|---|---|
| Greenhouse | `greenhouse.com/legal` hub (lists: privacy policy, bias audit, cookie notice, CCPA candidate notice, MSA, DPA, subprocessors; **no website terms of use / AUP / job-board terms linked**); MSA (last updated Feb 1 2026); CCPA candidate notice (effective Oct 17 2025); robots.txt | nothing found | MSA 4(c)(ix) customer will not "circumvent or attempt to circumvent any technological protective measures put in place to prevent or restrict access"; 4(d)(ii) API fair use: not "excessive, abusive, or negatively impacts, degrades, or impairs"; Greenhouse "monitors API usage". CCPA notice 4.9: "You may designate an authorized agent to make requests on your behalf" (privacy requests only, not applications) |
| Lever | `lever.co/terms-of-service/` (last updated Aug 25 2023); robots.txt | nothing found; page has no candidate rules and no AUP | 1.2 customer may not "use the Services for timesharing or service bureau purposes"; 9.2 use that "abuses, disrupts or poses a security risk" |
| Ashby | `ashbyhq.com/terms` (Customer ToS, last updated Sep 29 2025); robots.txt | nothing found | 5.1 customer may not "attempt to circumvent or disable any security or other technological features of the Service" or "interfere with, disrupt, negatively affect, or inhibit other users" |
| Workable | `workable.com/terms` (last updated Mar 2 2026); robots.txt | nothing found (no bot/scraping wording) | 4.5 "Do anything that could impair, interfere with, damage or cause harm to the operation of the Services"; 4.5.4 "Use the Services to circumvent Website limitations, including but not limited to fair usage limitations"; 5.1.1(c) "harvest Candidates for improper purposes" (aimed at recruiters) |
| Recruitee | `recruitee.com/terms-and-conditions` returned 404; search found only the help-centre article on careers-site terms and a customer-hosted privacy template. **Recruitee's own general ToS and candidate privacy statement were NOT read** | not assessed | (n/a) |

Notes:
- The MSA / customer terms define "the Service" as what the customer buys; a candidate on a public apply page is not a party. Whether the page's visitor is bound by anything is an unsettled legal point (open question 1).
- Each employer's own careers-site terms / privacy checkbox is a second layer we cannot generalise (Recruitee lets employers require accepting their terms before applying, help article 4729002).
- robots.txt (GET, 2026-10-17):
  - `boards.greenhouse.io`: `User-agent: *` / `Disallow: /embed/`. `job-boards.greenhouse.io`: no rules (comment only).
  - `jobs.lever.co`: `Allow: /`, `Crawl-delay: 1`.
  - `jobs.ashbyhq.com`: `Disallow: /meeting/`, `/b/`, `/api/` (no rule against the job pages).
  - `apply.workable.com`: `Disallow:` (empty) plus `Content-Signal: search=yes, ai-input=yes, ai-train=no`. `www.workable.com` disallows `/j/`, `/admin`.
  - `bunq.recruitee.com` redirects to the employer's custom domain (302), so there is no uniform Recruitee robots.txt for tenant careers sites; `recruitee.com` marketing robots.txt has nothing about apply pages.
  - robots.txt is about crawling, not form submission; none forbids the apply page.

## 2. Submission APIs (employer-side)

| ATS | Endpoint | Credential | Candidate use? |
|---|---|---|---|
| Greenhouse | Job Board API `POST /v1/boards/{board}/jobs/{id}` | "This method requires HTTP Basic Auth over SSL/TLS" with the board's Job Board API key; doc says the form action "MUST BE PROXIED ON YOUR SERVERS" because the key is secret. Doc: "we would encourage customers to make use of the Embedded Job Application", which "has built-in spam protection measures". Optional country code "enables fraud detection location checks" | No. Key belongs to the employer; using it would mean holding another company's secret. Not an option |
| Lever | Postings API `POST /v0/postings/{site}/{id}?key=APIKEY` | key a Super Admin generates. Limit: 429 above 2 application POSTs per second, "may also be changed without warning". README recommends "spam mitigations such as captchas and session or IP based rate limits" for custom forms; hosted form is "best practice" | No (employer key) |
| Ashby | `applicationForm.submit` | Basic auth API key with `candidatesWrite` permission | No (employer key). Captcha/spam/rate-limit not mentioned on that page (first 100k chars read) |
| Workable | `POST /jobs/:shortcode/candidates` (API v3) | token scope `w_candidates`, "Accessible with all token types"; `"sourced": false` makes it an applied candidate | No (account token) |
| Recruitee | Careers Site API `/offers/:offer_slug/candidates` ("Apply for the job offer (create candidate)"; method not shown in the text read) | auth not shown in the text read (links to an Authentication page). Help article: "Applications submitted through the job widget or public API don't trigger CAPTCHA" | **Unclear / gray**: the endpoint appears to be public (our adapter already reads `/api/offers/` unauthenticated), so it would bypass the captcha. Using it from a tool to skip a bot check we were not meant to skip is exactly the circumvention we should not do. Treat as forbidden until the owner decides (open question 2) |

None of these documents state that a candidate-side tool may or may not use them; they are simply meant for the employer's own site.

## 3. Bot checks on the hosted apply form, and how to recognise them

Page fetches were single plain GETs of one public page per ATS (no JS executed, no form interaction). Because the pages are JS-rendered, a static GET shows config and flags, not the final DOM; the filler must also check the live DOM.

| ATS | What we saw in the plain-GET HTML (2026-10-17) | Live-DOM / URL signatures for the filler to stop on |
|---|---|---|
| Greenhouse (`job-boards.greenhouse.io/gitlab/jobs/8860302002`) | Page config JSON contains `GOOGLE_RECAPTCHA_INVISIBLE_KEY` and `GOOGLE_RECAPTCHA_ENDPOINT":"https://www.recaptcha.net/recaptcha/enterprise` (reCAPTCHA **Enterprise**, invisible, loaded from `recaptcha.net`, not `google.com`). Greenhouse help: depending on spam sensitivity and score "a user may be asked to submit a code from their email" | script/iframe host `recaptcha.net` or `google.com/recaptcha/`; `iframe[src*="recaptcha"]`; `.grecaptcha-badge`; a "verify your email" / security-code input appearing before or after clicking submit (the code field was not in the static HTML; exact markup unknown, verify in a real session by the owner) |
| Lever (`jobs.lever.co/spotify/<id>/apply`) | `<script src="https://js.hcaptcha.com/1/secure-api.js?host=jobs.lever.co&onload=onLoad">`, `<div class="h-captcha" id="h-captcha">`, `data-sitekey`, hidden `#hcaptchaResponseInput` (name `h-captcha-response`), `#hcaptchaSubmitBtn`, JS calling `hcaptcha.execute(captchaId)` on submit and a `hcaptchaTokenExpired` handler (hCaptcha invisible/execute mode: challenge appears at submit when the score is poor) | `iframe[src*="hcaptcha.com"]`, `.h-captcha`, `textarea/input[name="h-captcha-response"]`, `#hcaptchaSubmitBtn`. Also `iframe[src*="hcaptcha.com/captcha"]` visible challenge |
| Ashby (`jobs.ashbyhq.com/ashby/<id>/application`) | Inline app-data JSON with feature flags `MigrateGoogleRecaptchaToEnterprise`, `MigrateGoogleRecaptchaAutomatedLegal`, `UseGoogleRecaptchaUniversalKey`; keys `recaptchaPublicSiteKey`, `recaptchaUniversalPublicSiteKey`; CSS `recaptcha-badge`. No standalone `<script src>` for it in the static HTML (injected at runtime). Plus server-side threshold: Strict / Permissive (recommended) / Less Permissive / No Protection (Ashby docs: "the threshold at which Ashby rejects applications") | `.grecaptcha-badge` / `recaptcha-badge`, `iframe[src*="recaptcha"]`, `script[src*="recaptcha"]`. A rejection happens **server-side after submit** (a low score can fail with no visible challenge), so the filler cannot detect it before submit; it is another reason never to submit |
| Workable (`apply.workable.com/huggingface/j/81B46579FE/apply/`) | Inline config `"recaptcha":false` and `"config":{"turnstileWidgetSiteKey":"0x4AAAAAAAVY8hH3nz6RxaK0"}`, flag `turnstile_captcha_enabled`; `wjb_acp_turnstile_captcha_enabled":true` (purpose of that flag not confirmed; could be account/page rather than apply form). We did not see the apply form itself render | Cloudflare Turnstile: `script[src*="challenges.cloudflare.com/turnstile"]`, `iframe[src*="challenges.cloudflare.com"]`, `.cf-turnstile`, `input[name="cf-turnstile-response"]` (these four are Cloudflare's documented names, general knowledge, not seen on this page) |
| Recruitee (`careers.bunq.com`, custom domain on Recruitee; plain GET of home page) | Nothing seen: static HTML is a Framer site with no captcha strings. Recruitee help article: invisible CAPTCHA "built into your careers site", **on by default**, modes Invisible (default) / Disabled, in CareersHub > Settings > General; "challenges only higher-risk applications"; provider not named | Unknown signature. Treat a challenge appearing at submit as the signal. Provider was not identified; do not assume reCAPTCHA. Needs a look at one Recruitee-hosted `*.recruitee.com/o/<slug>` page in a real browser (not possible with plain GET: it redirected) |

Other bot checks:
- **Rate limits**: Lever's API returns 429 above 2 POST/s (API only). Greenhouse monitors API usage. No hosted-form limits are published for any ATS. Applying is single-shot per posting, so the real constraint is not rate but not tripping a score.
- **Honeypot fields**: none confirmed. We did not find a honeypot input in the static HTML of the Lever page (grep for `honeypot`-style names returned nothing); the JS-rendered Greenhouse/Ashby/Workable forms were not inspected. Treat as unknown; the filler should only fill fields that are visible and labelled (skip `display:none`, `aria-hidden`, off-screen, `tabindex=-1` inputs).
- **Email verification code**: documented for Greenhouse (see above). Not documented for the others.
- **"Are you a robot" steps**: only the captcha widgets above.
- **Fraud/spam scoring after submit**: Ashby fraudulent-candidate detection; Greenhouse "fraud detection location checks" when a country code is supplied; Greenhouse spam blocklist for IPs/email domains (via Greenhouse's release/support pages, search summary). These can flag an application without any on-page challenge.

### Stop-signal list for the Phase 5 filler (D5/D7/D8)
Stop and hand to the human if any of these match in the live DOM or network list: `recaptcha` (any in `src`, `class`, `id`), `grecaptcha`, `hcaptcha` / `h-captcha`, `challenges.cloudflare.com`, `cf-turnstile`, `captcha` in any `class`/`id`/`name`, an input named `h-captcha-response` / `g-recaptcha-response` / `cf-turnstile-response`, a text box asking for an emailed verification code, or text such as "verify you are human". The filler may leave the page open for the owner but must never click through a challenge.

## 4. Employer-side settings that vary per company
- Greenhouse: spam sensitivity per job board (Configure > Job boards & posts > board > Spam protection). Stricter = higher score needed, more email-code prompts. Whether it can be turned off is not stated.
- Ashby: per brand, Admin > Job Boards > Theme > application spam protection: Strict / Permissive (default recommended) / Less Permissive / No Protection.
- Recruitee: CareersHub > Settings > General > Captcha: Invisible (default) / Disabled. Widget/public API applications skip it.
- Workable: nothing found on a toggle (search returned no Workable page); the static HTML has a Turnstile site key. Unknown whether employers can disable it.
- Lever: no employer setting found in the pages read (search returned no Lever help article).
- Also employer-specific, not ATS-wide: the employer's own privacy/terms consent checkbox, custom questions, and any "no agencies / no automated applications" text on the employer's page.

## 5. Risk summary for Phase 6

| ATS | Terms say | Bot check | Class | Recommendation |
|---|---|---|---|---|
| Greenhouse | Nothing on candidates; MSA bans customers circumventing protective measures | reCAPTCHA Enterprise invisible, optional email code, per-board sensitivity | gray | Semi-automated: prefill, owner solves any code and clicks submit |
| Lever | Nothing found | hCaptcha at submit | gray | Semi-automated (same) |
| Ashby | Nothing found | reCAPTCHA + server-side score; silent reject possible | gray, plus risk of silent reject | Semi-automated; owner submits so the score reflects a real browser session |
| Workable | Nothing found; fair-use and "circumvent limitations" clauses exist | Turnstile key present | gray | Semi-automated |
| Recruitee | Own ToS **not read** | invisible captcha default on; public API skips it | gray; API route forbidden until owner decides | Semi-automated via hosted form only. Do not use the public applications endpoint |

Overall: no ATS is "allowed" in an affirmative sense and none is "forbidden" by an explicit clause we found. Passing any of the captchas is forbidden by AGENTS.md, so fully automatic submit is out for all five. A bot-score check that runs silently (Ashby, Greenhouse) means even a no-challenge page may reject an automated session; one more reason for a human to press submit.

## Open questions for the owner
1. OWNER: Are you comfortable that a candidate-side tool filling fields in your own logged-in-free browser, with you clicking submit, is acceptable under each ATS's and each employer's terms? The ATS terms read are silent on candidates; the legal position of a visitor to a public apply page is not settled by the text.
2. OWNER: Recruitee's public candidate endpoint skips the captcha. Confirm we never use it (recommended: never).
3. Which fraud/spam checks (Greenhouse blocklist, Ashby fraud detection) could flag a prefilled-but-human-submitted application? Unknown; test only after Phase 6 approval.
4. Read Recruitee's own ToS and candidate privacy statement (the URL tried was 404; find the current link from a real Recruitee careers page footer).

## Sources (all checked 2026-10-17)
- https://www.greenhouse.com/legal ; https://www.greenhouse.com/master-subscription-agreement (updated 2026-02-01) ; https://www.greenhouse.com/ccpa-candidate
- https://docs.greenhouse.io/job-board.html (Submit application) ; https://support.greenhouse.io/hc/en-us/articles/115005448066 ("Invisible reCAPTCHA")
- https://www.lever.co/terms-of-service/ ; https://github.com/lever/postings-api
- https://www.ashbyhq.com/terms ; https://developers.ashbyhq.com/reference/applicationformsubmit ; https://docs.ashbyhq.com/job-board-application-spam-protection ; https://developers.ashbyhq.com/docs/public-job-posting-api
- https://www.workable.com/terms ; https://workable.readme.io/reference/job-candidates-create
- https://docs.recruitee.com/reference/careers-site-api ; https://support.recruitee.com/en/articles/6929909-add-captcha-to-your-application-forms ; https://support.recruitee.com/en/articles/4729002-terms-and-privacy-on-your-careers-site (via search snippet)
- robots.txt of boards.greenhouse.io, job-boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, apply.workable.com, www.workable.com, recruitee.com, bunq.recruitee.com (GET)
- Apply pages, one GET each: job-boards.greenhouse.io/gitlab/jobs/8860302002 ; jobs.lever.co/spotify/223f9722-3579-4ff2-b123-e4cc7b0c1a64/apply ; jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application ; apply.workable.com/huggingface/j/81B46579FE/apply/ ; careers.bunq.com/
- Summaries from a web search (not primary, lower weight): Greenhouse spam blocklist / identity verification; tostracker note that Greenhouse's ToS changed 2026-07-03 (content not seen).

## Confidence
- High: Lever hCaptcha, Greenhouse reCAPTCHA Enterprise (seen in page + Greenhouse help), Recruitee captcha default and public-API bypass (Recruitee help), employer-side keys for submit APIs.
- Medium: "nothing found" in terms (pages were read through a summarising fetcher, not verbatim full text; clause numbers came from it); Ashby reCAPTCHA (flags/keys seen, runtime widget not seen); Workable Turnstile (key seen, widget placement not seen).
- Low: Recruitee captcha provider and markup; honeypot fields; whether Greenhouse/Workable spam checks can be disabled.
- Would raise confidence: reading each ToS as raw text (curl to a file) and grepping for "automat|bot|scrap|robot"; one real-browser inspection (by the owner, DevTools Network/Elements tab, no submission) of an apply page per ATS, including a Recruitee-hosted one; asking each vendor's support.
