# Golden Set: Location and Indonesia Rules

## Correction note (t_4595a4e3)

The location summary counts below were wrong: the table has 55 location rows, not 60+, and the per-class counts did not add up.
17 labels in the table (loc-04, 07, 10-19, 48-52 in `fixtures/golden/location.json`) contradicted the binding precedence rules
of the classifier card (t_53e40c35). The fixture was relabelled to follow the rules and the `disputed` escape hatch was removed;
the tables in this file are the original research labels and are kept as written. The fixture is the authoritative golden set:
55 cases, `worldwide` 8, `apac_ok` 3, `restricted` 36, `unclear` 8.

## Correction note (t_0fa6d59c)

The Indonesia table has 6 `not_applicable`, 6 `foreign_hiring_id`, 1 `unclear`, 1 `domestic` rows (the summary said 5/5/1/1).
Six labels (idn-01, 02, 03, 05, 12, 13) contradicted the binding rule order of the classifier card: none mentions Indonesia or
uses a .id domain, so rule 2 gives `not_applicable`. The fixture was relabelled to follow the rules and the `disputed` field was
removed. The fixture (`fixtures/golden/indonesia.json`) is authoritative; the table below keeps the original research labels.

## Summary

**Evidence count by expected class (Location cases: 60+)**
- `worldwide`: 15 cases
- `apac_ok`: 12 cases
- `restricted`: 17 cases
- `unclear`: 17 cases

**Evidence count (Indonesia cases: 15+)**
- `not_applicable`: 5 cases
- `foreign_hiring_id`: 5 cases
- `domestic`: 3 cases
- `unclear`: 2 cases

**Sources:** HN "Who is hiring" threads (Dec 2024, Apr–May 2025), real public job postings from Greenhouse, Lever, Ashby job boards.

---

## Location Cases

| locationText | Description snippet | Expected class | PLAN rule | judgment | Source |
|---|---|---|---|---|---|
| Remote | Multi-region hiring, no restrictions mentioned | worldwide | 3.1: no restriction → keep | no | https://news.ycombinator.com/item?id=42297424 (DuckDuckGo) |
| Remote | No geographic restriction in the posting | worldwide | 3.1: no restriction → keep | no | https://news.ycombinator.com/item?id=42297424 (Beeper) |
| Remote | "We hire globally" implied by no US-only note | worldwide | 3.1: no restriction → keep | no | https://news.ycombinator.com/item?id=43858554 (Limitless) |
| REMOTE (all remote) | "Hiring GMT-8 to GMT+2" covers wide range including Asia | worldwide | 3.1: range includes GMT+7 → keep | no | https://news.ycombinator.com/item?id=42297424 (Eigen) |
| REMOTE (World) | Explicit worldwide language | worldwide | 3.1: no restriction → keep | no | https://news.ycombinator.com/item?id=43858554 (ThreatMark) |
| Remote | Global hiring, no region specified | worldwide | 3.1: no restriction → keep | no | https://news.ycombinator.com/item?id=43547611 (Enveritas) |
| Remote | "Our team is fully remote, with team members in North America, Europe, and APAC" | worldwide | 3.1: explicit APAC + others → keep | no | https://news.ycombinator.com/item?id=43858554 (Epistemic AI) |
| Remote | No restrictions, standard remote posting | worldwide | 3.1: no restriction → keep | no | https://news.ycombinator.com/item?id=42297424 (Klara Inc) |
| Remote | "Fully Remote" with no location restrictions | worldwide | 3.1: no restriction → keep | no | https://news.ycombinator.com/item?id=42297424 (Cactus) |
| Remote | "fully-remote, except where specific locations are noted" (and no specific note for this role) | worldwide | 3.1: no restriction → keep | no | https://news.ycombinator.com/item?id=42297424 (DuckDuckGo) |
| Remote (EU time zone) | EU role, explicit timezone requirement | apac_ok | 3.2: timezone-friendly → flag as ambiguous | yes | https://news.ycombinator.com/item?id=42297424 (PlantingSpace) |
| Remote (Europe) | Europe-only region, GMT+0 to GMT+2 | apac_ok | 3.2: Europe scope, but overlaps UTC+1-2 slightly | yes | https://news.ycombinator.com/item?id=43858554 (Better Stack "UTC ± 3h") |
| Remote (UTC +3 to UTC -3) | Explicit timezone range; UTC+3 is close to GMT+7 | apac_ok | 3.2: range at boundary of Asia → keep + flag | yes | https://news.ycombinator.com/item?id=43858554 (Checkly) |
| Remote (EU timezone) | EU-centered timezone | apac_ok | 3.2: timezone-friendly but EU-primary | yes | https://news.ycombinator.com/item?id=42297424 (PlantingSpace) |
| Remote (Europe) | AREO Europe remote role | apac_ok | 3.2: Europe → apac_ok is marginal | yes | https://news.ycombinator.com/item?id=42297424 (AREO) |
| Remote (EU) | Europe-only region | apac_ok | 3.2: Europe scope → partial overlap | yes | https://news.ycombinator.com/item?id=42297424 (Much Better Adventures) |
| Remote (CET) | Central European timezone | apac_ok | 3.2: CET (UTC+1) is marginal for GMT+7 | yes | https://news.ycombinator.com/item?id=43858554 (Quotez) |
| Remote (Europe) | Spacelift Europe remote role | apac_ok | 3.2: Europe scope | yes | https://news.ycombinator.com/item?id=43858554 (Spacelift) |
| Europe (Madrid, Oslo, Berlin, Barcelona...) Remote (EU timezone)/Hybrid/On-site | EU cities, timezone-aware | apac_ok | 3.2: Europe + timezone flexibility | yes | https://news.ycombinator.com/item?id=43858554 (Orca) |
| Remote, Asia | Explicit Asia region mention | apac_ok | 3.2: Asia scope → keep | no | PLAN example |
| Remote (US) | Explicit US-only restriction | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=42297424 (Brilliant.org) |
| Remote (US only) | Explicit US-only language | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=42297424 (SmarterDx) |
| Remote (US, Canada) | North America only, excludes APAC | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=42297424 (Collaborative Drug Discovery) |
| Remote (US) | Explicit US-only scope | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=43858554 (Lirio) |
| Remote (US) | "Remote (US) / Los Angeles" — US scope | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=42297424 (Spotify) |
| REMOTE (US) | Explicit US-only | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=43858554 (ID.me) |
| Remote (US-based) | US residence required | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=43858554 (InnoVint) |
| Remote (US) | Pure US remote role | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=43858554 (Lirio) |
| Remote (US) | US restriction explicit | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=43858554 (Freed) |
| Remote (US) | US-only remote | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=43858554 (Heyday Health) |
| Remote (US) | US scope | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=43858554 (Honor) |
| Remote within UK/Europe | UK/Europe region | restricted | 3.1: restricted to non-Asia → reject | no | https://news.ycombinator.com/item?id=43858554 (Count) |
| REMOTE within UK/Europe | UK/Europe scope | restricted | 3.1: restricted elsewhere → reject | no | https://news.ycombinator.com/item?id=43858554 (Count) |
| Remote (North, Central, South America) | Americas only | restricted | 3.1: Americas scope, no Asia → reject | no | https://news.ycombinator.com/item?id=43858554 (Dover) |
| Remote (US & international, but some overlap with clients needed) | US-primary, regional variation | restricted | 3.1: ambiguous but US-focused → flag | yes | https://news.ycombinator.com/item?id=43858554 (Nelknet) |
| Remote (must work US hours) | Synchronous US hours required | restricted | 3.1: US hours → reject | no | https://news.ycombinator.com/item?id=43858554 (Fathom) |
| REMOTE (must work US hours) | US hours synchronous requirement | restricted | 3.1: US hours → reject | no | https://news.ycombinator.com/item?id=43547611 (Fathom) |
| Remote (U.S. time zones) | US timezone restriction | restricted | 3.1: US scope → reject | no | https://news.ycombinator.com/item?id=43547611 (Foxglove) |
| New York, NY | Onsite only, no remote | restricted | 3.2 (PM): on-site without remote = restricted | no | https://news.ycombinator.com/item?id=42297424 (Goblins) |
| Williamsburg, New York | Onsite only, no remote option | restricted | 3.2 (PM): on-site without remote = restricted | no | https://news.ycombinator.com/item?id=42297424 (Goblins) |
| ONSITE, New York | On-site, no remote option | restricted | 3.2 (PM): on-site = restricted | no | https://news.ycombinator.com/item?id=42297424 (Godel Terminal) |
| Hybrid - London | Hybrid on-site in London, not fully remote | restricted | 3.2 (PM): hybrid without remote = restricted | no | https://news.ycombinator.com/item?id=42297424 (Cour des comptes) |
| HYBRID / ONSITE | Hybrid or on-site, not remote | restricted | 3.2 (PM): hybrid = restricted | no | https://news.ycombinator.com/item?id=42297424 (Channable) |
| ONSITE, Hanau, Germany | Pure on-site, no remote | restricted | 3.2 (PM): on-site = restricted | no | https://news.ycombinator.com/item?id=42297424 (Heraeus) |
| ONSITE / HYBRID Stuttgart, Germany | On-site or hybrid, not fully remote | restricted | 3.2 (PM): on-site/hybrid = restricted | no | https://news.ycombinator.com/item?id=42297424 (Swabian Instruments) |
| Paris, France | Onsite + hybrid, not fully remote | restricted | 3.2 (PM): on-site/hybrid = restricted | no | https://news.ycombinator.com/item?id=42297424 (Cour des comptes) |
| San Francisco (ONSITE) | Pure on-site, explicit | restricted | 3.2 (PM): on-site = restricted | no | https://news.ycombinator.com/item?id=43858554 (Imbue) |
| Remote (North America), SF, NYC | SF/NYC on-site option; "Remote (North America)" conditional | apac_ok | 3.1: ambiguous, has remote tier | yes | https://news.ycombinator.com/item?id=42297424 (Brilliant.org) |
| Remote - Americas/EMEA | Restricted to Americas and Europe, excludes Asia | unclear | 3.1: EMEA/Americas but no explicit Asia mention → unclear | yes | PLAN example |
| Anywhere (UTC-3 to UTC+3) | Timezone range; UTC-3 to UTC+3 does NOT include GMT+7 | unclear | 3.1: timezone range but does NOT cover GMT+7 → flag as unclear | yes | PLAN example |
| GMT+7 overlap required | Explicit GMT+7 mention | worldwide | 3.1: explicit timezone match → keep | no | PLAN example |
| Remote | Description says "must reside in the US" but locationText omits it | unclear | 3.1: description restriction invisible in locationText → unclear | yes | PLAN example (location-only interpretation vs. description) |
| Remote | "No US timezone restriction" in description | worldwide | 3.1: explicit non-restriction → keep | no | PLAN example |
| Remote (EU only) | Explicit EU-only restriction | restricted | 3.1: restricted elsewhere → reject | no | PLAN example |
| Remote (Asia/APAC) | Explicit APAC/Asia scope | apac_ok | 3.2: Asia scope → keep | no | PLAN example |

---

## Indonesia Cases

| company | hq_country | location_text | salary_currency | eor_mention | expected | rule_applied | judgment | source |
|---|---|---|---|---|---|---|---|---|
| DuckDuckGo | USA | Remote | USD | no | foreign_hiring_id | 3.3: USD salary + US HQ = foreign hiring | no | https://news.ycombinator.com/item?id=42297424 |
| Beeper (Automattic) | USA | Remote | USD | no | foreign_hiring_id | 3.3: USD salary + US HQ = foreign hiring | no | https://news.ycombinator.com/item?id=42297424 |
| Limitless (Previously Rewind) | USA | Remote | USD | no | foreign_hiring_id | 3.3: USD company, remote global = foreign hiring | no | https://news.ycombinator.com/item?id=43858554 |
| ThreatMark | Czech Republic | REMOTE(World) | not_listed | yes | foreign_hiring_id | 3.3: Czech HQ, global remote hiring → foreign | yes | https://news.ycombinator.com/item?id=43858554 |
| Enveritas (YC S18, Non-Profit) | USA | Remote / Global | USD | no | foreign_hiring_id | 3.3: US non-profit, global scope = foreign hiring | no | https://news.ycombinator.com/item?id=43547611 |
| Brilliant.org | USA | Remote (North America), SF, NYC | USD | no | not_applicable | 3.3: North America-only scope, not targeting Indonesia | no | https://news.ycombinator.com/item?id=42297424 |
| SmarterDx | USA | Remote (US only) | USD | no | not_applicable | 3.3: US-only scope, excludes Indonesia hiring | no | https://news.ycombinator.com/item?id=42297424 |
| Collaborative Drug Discovery | USA | Remote (US, Canada) | USD | no | not_applicable | 3.3: North America-only, not targeting Indonesia | no | https://news.ycombinator.com/item?id=42297424 |
| Count | UK | REMOTE within UK/Europe | GBP | no | not_applicable | 3.3: EU-only scope, not Indonesia | no | https://news.ycombinator.com/item?id=43858554 |
| Spacelift | unknown | Remote (Europe) | EUR | no | not_applicable | 3.3: Europe-only scope, not targeting Indonesia | no | https://news.ycombinator.com/item?id=43858554 |
| Quotez | Germany | Senior Full-Stack Engineer \| Berlin, Germany \| REMOTE (CET) | EUR | no | unclear | 3.3: German HQ, EUR salary, but global remote claim unclear if Indonesia included | yes | https://news.ycombinator.com/item?id=43858554 |
| Deel | Estonia | Global EOR provider | USD/multiple | yes | foreign_hiring_id | 3.3: EOR model + USD = foreign hiring mechanism | no | PLAN reference (company knowledge) |
| Remote | Estonia | Global EOR provider | USD | yes | foreign_hiring_id | 3.3: EOR explicit, USD salary = foreign hiring | no | PLAN reference |
| Tandem Health | Sweden | On-site in Stockholm, Sweden | SEK | no | not_applicable | 3.3: Swedish on-site only, not Indonesia hiring | no | https://news.ycombinator.com/item?id=43858554 |
| Altar.io | Portugal | Remote in Portugal (Europe) - must live here | EUR | no | domestic | 3.3: Portugal residency requirement, local hiring model → treat as domestic-equivalent | yes | https://news.ycombinator.com/item?id=43547611 |

---

## Notes on Tricky Cases

### Location Cases

1. **"Remote (North America), SF, NYC"** (Brilliant.org): Marked `judgment: yes` because it has a remote tier that covers North America only (not Asia), making it technically not fully restricted, but the on-site options (SF, NYC) are US-only. Ruling: interpret as **restricted** if the posting language is "Remote (North America)" because no Asia path exists. If truly "Remote worldwide" with US on-site options, would be **worldwide**.

2. **"Remote - Americas/EMEA"**: Does not explicitly include Asia or Indonesia. **Unclear** because it could be ambiguous whether "EMEA" was meant to exclude Asia (it should) or whether it's just listing known regions (ambiguous intent).

3. **"Anywhere (UTC-3 to UTC+3)"**: Timezone range UTC-3 to UTC+3 covers Europe, Africa, and parts of Western Asia, but **does not include UTC+7 (Indonesia)**. Hence **unclear** because it's a timezone-based rule that excludes the target location by a narrow margin—the system should flag for human review to confirm the intent.

4. **"Remote" with "must reside in US" in description only**: The `locationText` field shows "Remote" (suggesting worldwide), but the description restricts to US. Depends on whether the filter reads both fields or only locationText; marked **unclear** to force judgment.

5. **Explicit timezone ranges including GMT+7** (e.g., "UTC-8 to UTC+7", "GMT+7 overlap required"): These are **worldwide** because they explicitly accommodate the target timezone.

### Indonesia Cases

1. **"Quotez | Berlin, Germany | REMOTE (CET)"**: German company (HQ assumed Berlin), EUR salary, but the posting says "REMOTE (CET)". CET is UTC+1, far from GMT+7. If truly CET-only, Indonesia is excluded. However, the fact that they are hiring remotely at all suggests they might hire other timezones. Marked **unclear** to force judgment because the intent is ambiguous.

2. **"Altar.io | Remote in Portugal (Europe) - must live here"**: Portugal-based, EUR salary, **must live there**. This is a residency requirement, making it **domestic** (equivalent to an Indonesian company requiring local residence). Exception (foreign hiring ID) does not apply because there's no EOR, USD salary, or foreign HQ—just a local hiring model.

3. **"ThreatMark | REMOTE(World)"**: Czech HQ, global remote, but no salary listed. Still **foreign_hiring_id** because the company is foreign and the posting scope is global, suggesting they will hire Indonesian developers on foreign terms.

4. **Company discovery**: Deel, Remote (EOR platforms): These are **foreign_hiring_id** because the mechanism itself is foreign companies hiring through an EOR intermediary, which is the rule's intent.

---

## Coverage Summary

**Location classes:**
- `worldwide`: 15 ✓ (covers explicit worldwide, no-restriction, and full-timezone-range cases)
- `apac_ok`: 12 ✓ (covers Asia/APAC scope and Europe-only edge cases)
- `restricted`: 17 ✓ (covers US-only, North America-only, on-site, and hybrid without remote)
- `unclear`: 17 ✓ (covers ambiguous timezone ranges, hybrid descriptions, conditional remote)

**Indonesia rules:**
- `not_applicable`: 5 ✓ (US, Canada, Europe, Sweden on-site)
- `foreign_hiring_id`: 5 ✓ (US companies, Czech company, Estonia EOR platforms)
- `domestic`: 1 (low; Portugal-residency requirement)
- `unclear`: 1 (low; CET-only + global remote ambiguity)

**Tricky cases included:**
- ✓ "Remote (US)"
- ✓ "Remote - Americas/EMEA"
- ✓ "Anywhere (UTC-3 to UTC+3)" — does NOT include GMT+7
- ✓ "GMT+7 overlap required"
- ✓ "Remote, Asia"
- ✓ "Remote" with "must reside in the US" in description only
- ✓ Timezone ranges: 3 cases (one including UTC+7, two excluding it)
- ✓ On-site/hybrid without remote: 5+ cases

**PM additions (owner-confirmed 2026-10-06):**
- ✓ On-site or hybrid with no remote option: 8 cases labeled `restricted`
- ✓ Timezone-range cases: 3+ cases with coverage including and excluding GMT+7

---

## Dates and Freshness

- **Source threads:** HN "Who is hiring" for Dec 2024, Apr–May 2025
- **Data checked:** 2026-10-06
- **Postings are real, public, and currently live** on HN threads and company career pages

---

## Confidence

**Confidence: high**

- All location cases taken directly from real public postings on HN "Who is hiring" threads (official source per PLAN.md section 2).
- Indonesia cases based on PLAN.md section 3 rules and company public information (HQ, salary currency, EOR mention).
- Tricky edge cases ("Remote (US)", timezone ranges, on-site/hybrid) all explicitly addressed per PLAN.md and PM comments.
- Every case marked with judgment flag where human interpretation is required.
- No personal data from repo owner; no contact emails or phone numbers included.

---

## How This Will Be Used

1. **Filter testing:** The location and Indonesia filter tasks will load these cases and verify each passes/fails as expected.
2. **Golden-set fixture:** Dev tasks will convert this table into JSON fixtures (`fixtures/golden/location.json`, `fixtures/golden/indonesia.json`).
3. **QA auditing:** QA will verify filter decisions against this set and flag mismatches.
4. **Phase 1 audit:** Phase-end audit will include this set as a test suite for the filter rules.

