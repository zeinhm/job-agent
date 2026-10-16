# Apply form structure of Greenhouse, Lever and Ashby (t_d0698332)

Checked 2026-10-17. Plain `GET` only, UA `job-agent-research/0.1`, logged out, no browser, no form interaction, nothing POSTed.
Pages read (2 per ATS at most): Greenhouse `job-boards.greenhouse.io/gitlab/jobs/8860302002` and `.../embed/job_app?for=gitlab&token=8860302002`;
Lever `jobs.lever.co/spotify/<id>/apply` and `jobs.lever.co/palantir/<id>/apply` (a first `leverdemo` URL from an older note returned 404); Ashby `jobs.ashbyhq.com/ashby/<id>/application` (one page; the form is not in its HTML).
Public JS read: Greenhouse `entry.client-*.js` (161 KB), Lever `parseResume.js`, `retrieveLocations.js`, `application.js`, `jobs.lever.co`'s inline scripts, Ashby `assets/index-*.js` (3.9 MB) + its vite manifest.
Hand-trimmed markup excerpts for the dev: `docs/research/t_d0698332-samples/` (no tokens, no personal data).

## Answer
- **Greenhouse**: server-rendered React page (Remix, hydrated); inputs carry only an `id` (no `name`) and that id **equals** the `fields[].name` of the JSON we already store (`first_name`, `question_<id>`). Submit = `fetch` **POST** JSON to `https://boards.greenhouse.io/<co>/jobs/<id>` (embed: `/embed/<co>/jobs/<id>`). Before submit the page also POSTs analytics (Snowplow) and GETs an email validator.
- **Lever**: plain server-rendered HTML `<form method=POST>` with real `name` attributes (`name`, `email`, `cards[<uuid>][field<n>]`). Submit = native form POST to its own `/apply` URL after hCaptcha. **Before submit the page POSTs `/parseResume` when a resume is attached** (a non-GET a harness will see).
- **Ashby**: JS app; every call is `POST /api/non-user-graphql?op=<operationName>` (the operation name is in the URL). Read-only ones are `query` operations; but **filling a field fires mutations too** (`ApiSetFormValue`, `ApiCreateFileUploadHandle`, `ApiAutofillApplicationFormWithUploadedResume`). Only `ApiSubmitSingleApplicationFormAction` (and `ApiSubmitMultipleFormsAction`) submit. A guard can tell them apart by the `op` query parameter, not by the `mutation` keyword.

**Consequence for the D2 harness ("abort every non-GET")**: it is correct as a *submit* guard only for Lever's own form POST. For Ashby it would break field filling (each value is persisted server side by a mutation), and for Greenhouse/Lever it kills benign POSTs (analytics, `/parseResume`). Recommend a per-ATS allowlist of harmless non-GETs plus a hard-block list for the submit request (table in section 3) instead of a blanket abort, or accept that filling is partially broken and fill the form from a fixture only (see section 4).

## 1. Where the hosted form is, and what we can store
| ATS | Hosted apply form URL | Rendering | Notes |
|---|---|---|---|
| Greenhouse | `https://job-boards.greenhouse.io/<co>/jobs/<id>` (current). `boards.greenhouse.io/<co>/jobs/<id>` **redirects** there (live: final URL `job-boards.greenhouse.io/gitlab/jobs/8860302002`, HTTP 200). Page = job description **and** the form below it (same document; "Apply" button scrolls). Embed: `https://job-boards.greenhouse.io/embed/job_app?for=<co>&token=<id>` (HTTP 200, `"embedded":true`; form only differs by `action` and submit path). EU: `boards.eu.greenhouse.io`. | SSR React (Remix), hydrated; full form HTML is in the first response (80 KB), plus the same data as JSON in `window.__remixContext` | Company-site embeds use `?gh_jid=<id>` on the company domain (loader script `boards.greenhouse.io/embed/job_board/js?for=<co>`, iframe `grnhse_iframe`); the iframe URL is the embed URL above. `robots.txt` of boards-api disallows `/embed/` (the research note t_5c4e4567 recorded it); reading it once as a page was done here for fixture research only. |
| Lever | `https://jobs.lever.co/<co>/<posting-uuid>/apply` (posting page `.../<uuid>` has an "Apply" link to it). EU: `jobs.eu.lever.co`. | Server-rendered HTML; jQuery for small behaviours | `applyUrl` of the Lever postings API is exactly this URL (t_e94c6eb7). |
| Ashby | `https://jobs.ashbyhq.com/<org>/<posting-uuid>/application` (`.../<uuid>` = posting page with an "Apply" tab). Embeds: `?ashby_jid=<uuid>` on the company domain. | JS app shell + inline `window.__appData` (org theme, `posting` description; **no form**) ; the form arrives through GraphQL after load | `applyUrl` of the Ashby posting API is exactly this URL (t_e94c6eb7). |

What `apply_url` / `apply_links` can hold: all of the above, plus company-domain URLs with `gh_jid` / `ashby_jid` (see t_5f31fe9d section on patterns). A filler must therefore **normalise to the canonical hosted URL** first: Greenhouse `job-boards.greenhouse.io/<co>/jobs/<id>` (needs board token + job id, both known from the adapter), Lever `.../apply` suffix, Ashby `.../application` suffix. Do not try to fill a company-domain page (its embed is a cross-origin iframe).

## 2. Field structure and selector maps
### Greenhouse (job-boards UI)
Facts from the live page: every question is `div.field-wrapper`; label `<label id="<name>-label" for="<name>">`; control `id="<name>"`; **no `name` attribute on any control**; required = `<span aria-hidden="true">*</span>` inside the label **and** `aria-required="true"` on the control (selects also carry a hidden `<input required tabindex="-1" aria-hidden="true">`). `<name>` = `fields[].name` from `?questions=true` = `question_id` we store (`question_38624170002`). The form is `<form id="application-form" method="get">` (the real submit is JS).

| Item | Selector | Type | Notes |
|---|---|---|---|
| First / last name, email | `#first_name`, `#last_name`, `#email` | `input type=text` (email is also `text`) | `autoComplete=given-name/family-name/email`, `maxLength=255` |
| Phone | `#phone` (`type=tel`) + country combobox `#country` | react-select combobox | country has no API field; keep blank or pick via combobox |
| Resume / cover letter | `input#resume[type=file]`, `input#cover_letter[type=file]` (visually hidden, `accept=.pdf,.doc,.docx,.txt,.rtf`); text alternative via button `[data-testid=resume-text]` / `[data-testid=cover_letter-text]` then textarea `#resume_text` / `#cover_letter_text` (rendered after clicking "Enter manually") | file / textarea | wrapper `div[role=group][aria-labelledby=upload-label-resume]` has `data-allow-s3="false"` on both pages seen |
| LinkedIn, website, "preferred name", free text | `#question_<id>` | `input type=text` | LinkedIn/website are **custom** questions, matched by label, not by id |
| Textarea question | `#question_<id>` (`textarea`) | textarea | not on the pages read; API type `textarea` (t_5c4e4567) |
| Single select (`multi_value_single_select`, incl. Yes/No and country) | `input#question_<id>[role=combobox]` inside `.select-shell` (react-select) | combobox | options are rendered only after opening the menu (not in the DOM before). The page JSON has them: `fields[].values[{label,value}]` |
| Multi select (`multi_value_multi_select`) | same combobox with multi value, or checkbox group when `multi_select_style:"checkbox"` | combobox / checkbox | not seen live; the page JSON carries `multi_select_style` per question (`checkbox` or `null`) |
| Location autocomplete | `location_questions[]` question | combobox backed by Pelias | only rendered when the board has a location question; none on the pages read. `window.ENV.LOCATION_CONTROL_BASE_URL` = `https://api-geocode-earth-proxy.greenhouse.io/` |
| Date | none seen | - | API docs list none for job-board questions; UNKNOWN |
| EEOC / voluntary self-identification | container `.eeoc__container`, wrappers `.eeoc__question__wrapper`, ids `#gender`, `#hispanic_ethnicity`, `#veteran_status` (the JSON `eeoc_sections` lists `gender`, `race`, `veteran_status` - the DOM splits race into a Hispanic question) | comboboxes | **never answer** (conventions); presence differs per board (`enable_eeoc`) |
| GDPR / consent | `data_compliance` in the JSON (`gdpr`, `requires_consent:false` here) | checkbox when `requires_consent` | not rendered on this board |
| Submit | `.application--submit button[type=submit]` ("Submit application") | button | **never click** |

Mapping to stored ids: DOM `id` == `question_id` for every field (first/last/email/phone/resume/cover_letter and `question_*`); the page's `__remixContext` → `routes/$url_token_.jobs_.$job_post_id.jobPost.questions` is the same structure as the API's `questions[]` (plus `allowed_filetypes`, `multi_select_style`), `eeoc_sections` replaces API `compliance`, and `data_compliance` is new. So the harness can validate "DOM ids == stored question ids" without extra requests.

### Lever
Real `name` attributes; labels wrap their input (`<label><div class="application-label">Text<span class="required">✱</span></div><div class="application-field"><input ...></div></label>`); required = `✱` span in the label **and** HTML `required` on the control. Custom question cards additionally ship a hidden JSON `cards[<card-uuid>][baseTemplate]` that describes the card (`fields[].type/text/required/options`), so the page is self-describing.

| Item | Selector | Type | Notes |
|---|---|---|---|
| Resume | `input#resume-upload-input[name=resume][type=file]` (hidden; visible `a.visible-resume-upload`) | file | selecting a file triggers `POST /parseResume` (below) |
| Name | `input[name=name]` (`data-qa=name-input`) | text, required | single "Full name" field (no first/last split) |
| Email | `input[name=email]` | `type=email`, required | |
| Phone | `input[name=phone]` | text | required on the Spotify page, optional elsewhere (per posting) |
| Location | `input#location-input[name=location]` + hidden `input#selected-location[name=selectedLocation]` | text with autocomplete | typing fires `GET /searchLocations?text=` (500 ms debounce); on blur without picking a suggestion **both inputs are cleared** (`retrieveLocations.js`) - the filler must click a suggestion |
| Current company | `input[name=org]` | text | |
| Links | `input[name="urls[LinkedIn]"]`, `urls[GitHub]`, `urls[Portfolio]`, `urls[Twitter]`, `urls[Other]` | text | the set varies per posting; the Spotify page had LinkedIn, GitHub, Portfolio, Other |
| Pronouns | `input[name=pronouns]` checkboxes (+ custom text) | checkbox | optional |
| Additional info / cover note | `textarea#additional-information[name=comments]` | textarea | seen on the Palantir page |
| Custom text | `input.card-field-input[name="cards[<card>][field<n>]"]` | text | `.application-label.text` |
| Custom textarea | `textarea.card-field-input[name="cards[<card>][field<n>]"]` | textarea | `.application-label.textarea` |
| Custom dropdown | `select[name="cards[<card>][field<n>]"]` | select | first option `value=""` "Select..." |
| Custom multiple-choice | `input[type=radio][name="cards[<card>][field<n>]"]` | radio | value = option text |
| Custom multiple-select | `input[type=checkbox][name="cards[<card>][field<n>]"]` | checkbox | **every box carries `required` until one is checked** (`application.js` toggles it) |
| EEO / demographic | `input[type=radio][name="surveysResponses[<survey>][responses][field<n>]"]`, hidden `surveysResponses[...][baseTemplate/surveyId]` | radio | several surveys per page for different locations; **never answer** |
| Hidden bookkeeping | `accountId`, `origin`, `referer`, `timezone`, `resumeStorageId`, `linkedInData`, `socialSource`, `consent[marketing]` | hidden | leave as is |
| Submit | visible `button#btn-submit[type=button][data-qa=btn-submit]` → hCaptcha execute → hidden real `button#hcaptchaSubmitBtn[type=submit]` | button | **never click** (also would launch the hCaptcha challenge) |

Field `<n>` is the index inside the card (`field0`, `field1`...), card uuid = the `id` in `baseTemplate`. There is no stable id like Greenhouse's `question_id`: for Lever the matching key is **card uuid + field index**, or the label text. t_5c4e4567 recorded no stored Lever questions, so there is nothing to map to yet.

### Ashby
Cannot be verified statically (no HTML, no POST allowed). Verified from the bundle: field entries are `FormFieldEntry { id, field(JSON), fieldValue, isRequired, descriptionHtml, isHidden }` inside `FormRender.sections[]`; standard field paths are `_systemfield_name`, `_systemfield_email`, `_systemfield_resume`, `_systemfield_location`, `_systemfield_education_history` (+ `_systemfield_texting_consent`, `_systemfield_whatsapp_consent`); custom fields use a uuid path. Documented CSS hooks (class names exported in the bundle for customer styling): `ashby-application-form-container`, `-field-entry`, `-question-title`, `-question-description`, `-section-container`, `-input-text`, `-input-textarea`, `-input-dropdown-select`, `-input-radio-group`, `-input-checkbox-group`, `-input-yesno`, `-input-date`, `-input-file`, `-input-file-dropzone`, `-input-autocomplete` (+ `-popup`), `-input-education-*`, `-submit-button`, `-success-container`. Field types that exist: text, textarea, dropdown, radio group, checkbox group, yes/no, date, file, autocomplete (location, school), education repeater.

| Item | Selector | Confidence |
|---|---|---|
| Container / entry / title | `.ashby-application-form-container`, `.ashby-application-form-field-entry`, `.ashby-application-form-question-title` | medium (class names verified in the bundle, whether the hook classes appear in the DOM or only as extra classes beside hashed CSS-module classes: unverified) |
| Name, email, resume | `#_systemfield_name`, `#_systemfield_email`, `input[type=file]` for `_systemfield_resume` | **low** (path names verified; DOM `id`/`name` equal to the path is from memory of the live site, not verified here) |
| Custom fields | field entry whose label text = question title; id = field path uuid | low |
| Submit | `.ashby-application-form-submit-button` | medium |
| Autofill from resume | `.ashby-application-form-autofill-input-*` (drop zone, "Autofill from resume") - triggers `ApiAutofillApplicationFormWithUploadedResume` | medium |

Recommendation: **do not build Ashby selectors from this note.** The first Ashby task needs a headed, owner-run recording (HAR + DOM dump of one dry run) to confirm ids; use label text + the class hooks above as the fallback. There is no stored Ashby question list (no public GET), so "form changed" detection (section 5) is unavailable for Ashby until the filler itself records the questions it sees.

## 3. Network before submit
### Greenhouse (from `entry.client-*.js`, line-level quotes in the evidence section)
| Request | When | Method | Harmless? |
|---|---|---|---|
| `GET job-boards.greenhouse.io/<co>/jobs/<id>` + CDN assets `job-boards.cdn.greenhouse.io/assets/*.js,css` | load | GET | yes |
| Snowplow event to `https://c.spl.greenhouse.io` (`SNOWPLOW_ENDPOINT`, `eventMethod:"post"`, `respectDoNotTrack:true`, `bufferSize:1`) | load / interactions | **POST** | yes, block or allow; the page works without it |
| `GET https://www.recaptcha.net/recaptcha/enterprise.js?render=<key>` (invisible reCAPTCHA Enterprise, `GOOGLE_RECAPTCHA_ENDPOINT`) | load (`init()` loads the script if not present) | GET, then Google's own beacons (not inspected) | allow GET; Google beacons may be POST |
| `GET https://email-address-validator.us.greenhouse.io/address/validate?address=<email>` | after the email is typed (`co(e)` helper) | GET | yes, **sends the typed email address to a third party**: a dry run with the real address leaks it to that host; use the fake persona or block it (fail-open: the helper returns `null` when the host is absent) |
| `GET <jben>/uncacheable_attributes/presigned_fields?fields[]=resume` then S3 `POST` (FormData `utf8=✓` + presigned fields) | file attach, **only when `data-allow-s3` is true** (it was `"false"` on both pages read; the board's `google_drive_enabled`/`enable_dropbox` are false too) | GET + **POST to S3** | the S3 POST is a real upload of the resume: block it; when `data-allow-s3="false"` the resume stays in the browser and is sent inside the submit |
| Location search to `LOCATION_CONTROL_BASE_URL` (Pelias via `api-geocode-earth-proxy.greenhouse.io`) | typing in a location question | GET | yes (only when such a question exists) |
| `GET /badges/<key>`, `POST /seek/send_signal` | Apply-with-Seek / trust badges | GET / POST | irrelevant; not triggered here |
| **Submit** | click on "Submit application" | `fetch(submitPath, {method:"POST", headers:{"Content-Type":"application/json"}, body: {job_application, fingerprint, [g-recaptcha-enterprise-token], [request_token], [captcha_retried]}})`; `submitPath` = `https://boards.greenhouse.io/<co>/jobs/<id>` (embed: `https://boards.greenhouse.io/embed/<co>/jobs/<id>`) | **block**: match POST to host `boards.greenhouse.io` (or `boards.eu.greenhouse.io`) with path `/(embed/)?<co>/jobs/<id>` |

The submit target is a different origin from the page (`job-boards.greenhouse.io` → `boards.greenhouse.io`), so a browser first sends a CORS preflight `OPTIONS` (inference; not observed). A guard that hooks the page's requests (e.g. Playwright route) may not see the preflight; one that blocks every `POST` is enough and one that also blocks `OPTIONS` to that host is safest.

### Lever
| Request | When | Method | Harmless? |
|---|---|---|---|
| `GET jobs.lever.co/<co>/<id>/apply` + `/js/{jquery-3.6.1.min,parseResume,application,retrieveLocations,debounce.min,hideAndShowSurveys,cookieconsent.min,bug-snag}.js` | load | GET | yes |
| `https://js.hcaptcha.com/1/secure-api.js` + hCaptcha widget (`#h-captcha`, rendered by `onLoad`) | load | GET (+ hCaptcha's own beacons) | the widget renders; **do not interact** (no CAPTCHA interaction rule). It only runs a challenge after `hcaptcha.execute()` which the submit path calls |
| `GET https://www.googletagmanager.com/gtag/js?id=<empty>` | load | GET | yes (id empty here) |
| **`POST /parseResume`** multipart (`resume`, `accountId`) → JSON profile; fills name/email/phone/links if the user did not touch them, and sets `resumeStorageId` | immediately on selecting a file in `#resume-upload-input` | **POST** | **uploads the CV to Lever on attach**; this is a real server side effect before submit. Block it: the page shows "upload failed" (`.resume-upload-failure`) but the file input keeps the file and the form can still be filled. Do not rely on the autofill |
| `GET /searchLocations?text=<q>` (XHR, 500 ms debounce) | typing in the location input | GET | yes |
| **Submit** | `#btn-submit` click → hCaptcha execute → `#hcaptchaSubmitBtn` click (also Enter in a text field via the form `submit` listener) | native multipart `POST` to the page's own URL (`<form method=POST>`, no `action`) → `/<co>/<id>/apply` | **block**: any non-GET navigation/request whose URL path ends with `/apply` on `jobs.lever.co` |

### Ashby (all POST; bundle `index-Dl8l1Lr-.js`, build `28c036de…`)
Link: `new HttpLink({uri: e => '/api/non-user-graphql?op=' + encodeURIComponent(e.operationName), fetch})` (Apollo default method POST for queries too; not observed on the wire). Complete operation list with query/mutation kind: `samples/ashby-graphql-operations.json`; relevant here:

| Operation (`?op=`) | Kind | When | Class |
|---|---|---|---|
| `ApiOrganizationFromHostedJobsPageName` | query | load | read-only |
| `ApiJobPosting`, `ApiJobPostingForApplicationRequest` | query | load (returns `applicationForm { FormRenderParts }`, `surveyForms`, `recaptchaAction`) | read-only |
| `ApiAutocompleteGeoLocation`, `ApiSearchSchoolByCanonicalName` | query | typing in location / school | read-only |
| `ApiAutomatedProcessingRecaptchaActions`, `ApiGetAutomatedProcessingLegalText`, `ApiGetConsent` | query | possible (consent / legal notices); not confirmed on this page | read-only |
| `ApiSetFormValue` (`organizationHostedJobsPageName, formRenderIdentifier, path, value`) | **mutation** | **every field change** (draft value saved server side under a `formRenderIdentifier`) | benign draft write; the page needs it to work |
| `ApiCreateFileUploadHandle` (`filename, contentType, contentLength`) → upload to the returned URL, then `ApiSetFormValueToFile` / `ApiAddManyFilesToFormValue` / `ApiRemoveFileFromFormValue` | mutation (+ file PUT/POST to storage) | attaching a resume | uploads the CV; block if the dry run must not upload |
| `ApiAutofillApplicationFormWithUploadedResume` | mutation | after the "Autofill from resume" drop zone gets a file | uploads the CV for parsing; avoid |
| `ApiRecordCookieConsent` | mutation | cookie banner | benign |
| **`ApiSubmitSingleApplicationFormAction`** (`organizationHostedJobsPageName, jobPostingId, formRenderIdentifier, formDefinitionIdentifier, actionIdentifier, recaptchaToken, sourceAttributionCode, viewedAutomatedProcessingLegalNoticeRuleId, …`) | **mutation** | submit click | **block** |
| `ApiSubmitMultipleFormsAction` | mutation | submit of multi-form flows (application + surveys) | **block** |
| `ApiSubmitCandidateTextingConsent`, `ApiSubmitCandidateWhatsAppConsent` | mutation | consent checkboxes sent at/after submit (inference) | block to be safe |
| other `ApiSubmit*` (`Availability`, `Registration`, `Sourcing`, `Survey`, `TakeHome`, `TextingRegistration`) | mutation | other pages (scheduling, surveys), not the apply page | n/a |

**Can a guard tell them apart?** Yes, by the `op` query parameter, which is set from the operation name and is visible without reading the body: block when `op` starts with `ApiSubmit`; treat other `op` values as non-submitting. The `mutation` keyword alone does **not** work (`ApiSetFormValue` is a mutation but not a submit), and it needs the body (`operationName`/`query` JSON), whereas `?op=` is in the URL. If a body check is also wanted: `operationName` equals the `op` value and the `query` text begins with `mutation ApiSubmit`. Caveat: `op` is client-supplied; this is a client-side convention seen in the bundle, not a documented contract. A defence in depth: also block when the body contains `submitApplicationFormAction`/`submitSingleApplicationFormAction` (the root fields seen next to the operation).

## 4. Fixture strategy
| ATS | Can a recorded page be served from 127.0.0.1 offline? | Recommendation |
|---|---|---|
| Greenhouse | **No for interaction, yes for structure.** The first response is complete (80 KB, fields, labels, `required`, ids) but inputs become usable only after hydration, which needs `https://job-boards.cdn.greenhouse.io/assets/*.js` (manifest, entry, vendor, root, route chunks) and the inline `__remixContext`. Re-hosting Greenhouse's JS in our public repo is a copyright/ToS question and an untested hydration; without it the react-select comboboxes never become interactive and the `<form method=get>` submit does a plain GET with no values. | **Synthetic fixture** that mimics the documented DOM (ids = `fields[].name`, `label[for]`, `aria-required`, react-select-like combobox with `role=combobox`, options listbox after opening, hidden `input[required]`) with a small vanilla JS shim that does `fetch(POST)` on submit to a path matching `boards.greenhouse.io/...` rewritten to `127.0.0.1`. Use the recorded SSR excerpt only for selector unit tests. |
| Lever | **Yes.** The page is plain HTML; only `jquery`, `parseResume.js`, `retrieveLocations.js`, `application.js`, `debounce.min.js` matter and are small (4–6 KB each besides jQuery). | Save one real page: strip hCaptcha script + `data-sitekey`, gtag/GA/Segment scripts, bugsnag, cookieconsent, `accountId` (a company UUID, fine to keep but not needed), inline CSS (751 KB of the 769 KB is CSS/survey JSON). Keep the form, the four local scripts (rewrite to relative paths), and stub `/parseResume`, `/searchLocations` in the fixture server. The Spotify page has no textarea/select; add one card of each type (see excerpt: types `text`, `textarea`, `dropdown`, `multiple-choice`, `multiple-select` seen on Palantir). |
| Ashby | **No.** The HTML is a shell (137 KB: theme, org, `posting` description, `recaptchaPublicSiteKey`, Datadog RUM client token); the 3.9 MB bundle and every form byte come over GraphQL POSTs. A static copy would show nothing. | **Synthetic fixture only**: a local page with the documented class hooks, `_systemfield_*` ids and a fake `/api/non-user-graphql?op=` endpoint that answers `ApiSetFormValue` (benign) and records `ApiSubmitSingleApplicationFormAction` (must never be reached). Build it only after the owner-run recording from section 2 confirms real ids. |

Strip from any recorded page (keep it public-repo safe):
- **Trackers/tokens**: Greenhouse `window.ENV` (Google Picker developer key + client id, Dropbox chooser key, reCAPTCHA site key, Rollbar post-client token, Snowplow endpoint) and the duplicated copy inside `__remixContext`; Lever hCaptcha `sitekey`, gtag id (empty), Segment properties, bugsnag script; Ashby `ddRumClientToken`, `ddRumApplicationId`, `recaptchaPublicSiteKey`, `recaptchaUniversalPublicSiteKey`. These are client-side public keys, but they are service credentials for third-party accounts: do not commit them.
- **Fine to keep** (public posting data): company name, job title/description, question labels and option lists, org logo URL. Prefer the shortest page and drop the description.
- **Personal data**: none in logged-out pages. Do not commit a page saved from a logged-in browser or a filled form.
- **Per-session values**: Greenhouse `fingerprint` (job post fingerprint, public), Lever hidden `timezone`/`origin`/`referer` empty; no CSRF token seen on either page (Greenhouse sends `csrfToken` from the loader only when present: `null` on the pages read).

## 5. What changes over time, and "form changed" detection
- **Greenhouse**: the old `boards.greenhouse.io` markup (server-rendered, jQuery, `<form id="application_form">` with `name="job_application[first_name]"` style names, from memory/not rechecked) was replaced by the **job-boards Remix UI** (class names like `application--form`, `field-wrapper`, react-select `select__*`). `boards.greenhouse.io/<co>/jobs/<id>` now redirects to it. Board-level configuration changes the form per company: EEOC block (`enable_eeoc`), `data_compliance`, location/education/employment sections (`education_config`: `hidden` here), custom CSS variables (`--custom-*`) and `outside_label`. The build id (`LOTUS_GIT_COMMIT`) is in `window.ENV`: log it with each run to correlate breakage with a deploy.
- **Lever**: server-rendered and stable; changes are per posting (cards, surveys, locations, pronouns). The scripts are versioned by source map comments only.
- **Ashby**: front-end build hash changes with every deploy (`cdn_assets/<sha>/`, `frontend_non_user/<sha>/`), form content per org (form definitions, hidden fields, surveys). Class hooks are advertised for customers' custom CSS, so they are more stable than generated names.
- **A/B form versions**: none documented for any of the three; Greenhouse question lists differ per job post, and the page data carries `hiring_plan_id`, `fingerprint`, `updated_at`-like fields only through the API.

Detecting "form changed" (compare page with stored questions):
| ATS | Method |
|---|---|
| Greenhouse | Collect all `[id]` of `form#application-form` controls (`input,textarea,[role=combobox]`) excluding react-select internals (`#country`, EEOC ids) and compare with the stored `posting_questions.question_id` set (+ standard ids). Extra DOM id → new question; missing id → removed; compare `aria-required` against the stored `required`; for selects open the listbox and compare option labels with stored `values[].label`. Cheaper: parse `__remixContext…jobPost.questions` from the same HTML (no browser) and diff it with the stored JSON (hash of `fields[].name+type+required`). Re-fetching `?questions=true` is the other source of truth. |
| Lever | No stored questions. Diff **DOM vs `baseTemplate` JSON** inside the same page (self-describing) and record per posting a hash of `[card-uuid, field index, type, required, options]` the first time the post is seen; flag a change on later visits. |
| Ashby | Nothing stored and no public GET. The filler must record the `ApiJobPosting*` response `applicationForm.sections[].fieldEntries[]` (field path, type, `isRequired`) on its first run and diff it later (needs the owner-run recording first). |

Generic "stop and ask" rules for the filler: unknown required control not in the stored set → stop; a stored required question with no control → stop; number of controls differs by more than the EEOC/standard set → stop; page returned a CAPTCHA, login wall or redirect to another host → stop.

## Risks / ToS notes
- Reading public apply pages with GET is what a browser does; nothing here was submitted. Greenhouse `robots.txt` of `boards-api` disallows `/embed/`; the embed URL was opened once as a page (for the form difference only) - the filler should prefer the non-embed URL.
- A filler **in the owner's browser** sends requests that are real for the ATS (`/parseResume` uploads the CV, Greenhouse S3 upload when enabled, Ashby `ApiSetFormValue` drafts and file handles, third-party email validation). The dry run is therefore not zero-effect on Lever and Ashby unless these are blocked; see allow/block table.
- Never touch hCaptcha / reCAPTCHA; do not click submit (PLAN guardrails). The Lever submit path starts an hCaptcha challenge, the Ashby/Greenhouse submit attaches a reCAPTCHA token: both are outside the dry run.
- Terms: previous notes cover ToS (t_ec2ae4c6). No new terms were read here.

## Evidence (all GET)
```
curl -s -L -A job-agent-research/0.1 https://boards.greenhouse.io/gitlab/jobs/8860302002      -> 200 80411 B, final URL job-boards.greenhouse.io/gitlab/jobs/8860302002
curl -s -L -A ... "https://job-boards.greenhouse.io/embed/job_app?for=gitlab&token=8860302002" -> 200 75554 B, "embedded":true, submitPath https://boards.greenhouse.io/embed/gitlab/jobs/8860302002
curl -s -A ... https://job-boards.cdn.greenhouse.io/assets/entry.client-ClhIqXFJ.js            -> 200 161137 B
curl -s -A ... https://jobs.lever.co/spotify/223f9722-3579-4ff2-b123-e4cc7b0c1a64/apply        -> 200 769456 B
curl -s -A ... https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply       -> 200 1938955 B
curl -s -A ... https://jobs.lever.co/leverdemo/681fbc53-1e34-4a46-8677-3a78118674eb/apply      -> 404 (stale id from t_e94c6eb7)
curl -s -A ... https://jobs.lever.co/js/{parseResume,retrieveLocations,application}.js         -> 200 6287 / 6469 / 4347 B
curl -s -A ... https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application -> 200 136965 B
curl -s -A ... https://cdn.ashbyprd.com/frontend_non_user/28c036de…/.vite/manifest.json        -> 200 1562 B
curl -s -A ... https://cdn.ashbyprd.com/frontend_non_user/28c036de…/assets/index-Dl8l1Lr-.js    -> 200 3918377 B
```
Key lines (trimmed):
```
GH  to({application,submitPath,...}) ... fetch(t,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...c,fingerprint:r})})
GH  fetchFields(t,n){... fetch(`${n}/uncacheable_attributes/presigned_fields?${r}`) ...}  ... l.open("POST",this.url) ... n.append("utf8","✓")
GH  co=async e=>{const{EMAIL_ADDRESS_VALIDATOR_HOST:t}=window.ENV; ... new URL(`https://${t}/address/validate`) ... searchParams.append("address",e)
GH  Qn(window.ENV.SNOWPLOW_NAMESPACE,window.ENV.SNOWPLOW_ENDPOINT,{... respectDoNotTrack:!0, bufferSize:1, eventMethod:"post" ...
LV  var POST_PATH = '/parseResume';  ... $('#resume-upload-input').on('change', ...  req.open('POST', POST_PATH, true)
LV  var searchLocationsUrl = "/searchLocations?text=" ... req_1.open('GET', ...)
LV  <form id="application-form" enctype="multipart/form-data" method="POST">  ...  <input id="hcaptchaResponseInput" type="hidden" name="h-captcha-response">
AB  link: hE.from([..., new Gxe({uri:e=>`/api/non-user-graphql?op=${encodeURIComponent(e.operationName)}`, fetch:lTe})])
AB  operation:`mutation`,name:{value:`ApiSubmitSingleApplicationFormAction`} ... {value:`ApiSetFormValue`} ... {value:`ApiCreateFileUploadHandle`}
```
Extraction commands: `grep -oE` over the saved files (kept outside git under `data/research-tmp/`, deleted after the run).

## Sources (checked 2026-10-17)
- Live pages and public bundles listed under Evidence.
- Greenhouse Job Board API (questions JSON): https://docs.greenhouse.io/job-board.html (via t_5c4e4567, 2026-10-15)
- Existing notes: `docs/research/t_5c4e4567-ats-application-questions.md`, `t_5f31fe9d-apply-routes.md` (URL patterns, `gh_jid`/`ashby_jid`), `t_e94c6eb7-ats-apis.md` (`applyUrl` values), `t_ec2ae4c6-ats-submission-terms.md`.

## Confidence
- High: Greenhouse DOM ids = stored `question_id`; Greenhouse submit request (method, JSON body, target URL); Lever DOM/`name` scheme and its non-GET calls (`/parseResume`, submit POST); Ashby `?op=` URL scheme and the operation list with kinds.
- Medium: which Ashby operations fire on load vs on field change (inferred from names and the `ApiSetFormValue` variables, not observed on the wire); Greenhouse S3 upload only when `data-allow-s3` is true; preflight `OPTIONS` behaviour; Ashby CSS hook classes present in the DOM.
- Low: Ashby input `id`/`name` values; old Greenhouse markup; whether Greenhouse hydration works from a local copy (not tried).
- Would raise it: one owner-run headed Playwright recording per ATS with `page.on('request')` logging (HAR) and a DOM dump of a dry run on a throwaway posting; a second Greenhouse board with location/education/date/multi-select questions; a Lever page with `urls[...]`, date and score cards; reading Ashby's `ApiJobPosting` response (needs a POST, out of scope here).
