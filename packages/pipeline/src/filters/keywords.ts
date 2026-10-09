/**
 * Keyword lists for the rule-based filters, all in one module (owner decision 2026-10-06).
 * Phrases are matched case-insensitively on word boundaries, except those in CASE_SENSITIVE_PHRASES.
 * Timezone ranges are not listed here: they are parsed in location.ts.
 */
import { ATS_TYPES } from "@job-agent/core";

/** Phrases that only count when written exactly like this (short tokens that are also ordinary words). */
export const CASE_SENSITIVE_PHRASES: readonly string[] = ["SEA"];

/** APAC signals: location text, tags, or (lower precedence) description. */
export const APAC_PHRASES: readonly string[] = [
  "APAC",
  "Asia",
  "Asia-Pacific",
  "Asia Pacific",
  "Southeast Asia",
  "South East Asia",
  "SEA",
  "Indonesia",
  "Jakarta",
  "Bandung",
  "Surabaya",
  "Yogyakarta",
  "Bali",
  "Denpasar",
  "Medan",
  "Semarang",
  "WIB",
];

/** Geographic or eligibility restrictions that exclude an Indonesia-based candidate. */
export const RESTRICTION_PHRASES: readonly string[] = [
  "US only",
  "U.S. only",
  "Remote (US",
  "Remote (U.S.",
  "US-based",
  "U.S.-based",
  "US time zones",
  "U.S. time zones",
  "US hours",
  "must reside in",
  "must be located in",
  "authorized to work in the US",
  "authorized to work in the U.S.",
  "authorized to work in the UK",
  "authorized to work in the EU",
  "EU only",
  "UK only",
  "Canada only",
  "within UK",
  "within the UK",
  "within Europe",
  "within the EU",
  "North America",
  "South America",
  "Americas",
  "EMEA",
  "LATAM",
];

/**
 * Country names (and common abbreviations) that make a "Countries: ...", "Remote, <country>" or
 * "<country> (Remote)" location a restriction. Indonesia and the APAC region words are deliberately absent:
 * they are APAC signals and win first. Matched as whole list items, case-insensitively.
 */
export const RESTRICTED_COUNTRY_NAMES: readonly string[] = [
  "United States",
  "United States of America",
  "USA",
  "US",
  "U.S.",
  "U.S.A.",
  "United Kingdom",
  "UK",
  "U.K.",
  "Canada",
  "Mexico",
  "Brazil",
  "Argentina",
  "Chile",
  "Colombia",
  "Peru",
  "Uruguay",
  "Costa Rica",
  "Germany",
  "France",
  "Spain",
  "Portugal",
  "Italy",
  "Netherlands",
  "Belgium",
  "Switzerland",
  "Austria",
  "Ireland",
  "Poland",
  "Czech Republic",
  "Czechia",
  "Romania",
  "Bulgaria",
  "Hungary",
  "Greece",
  "Sweden",
  "Norway",
  "Denmark",
  "Finland",
  "Estonia",
  "Latvia",
  "Lithuania",
  "Ukraine",
  "Serbia",
  "Croatia",
  "Slovenia",
  "Slovakia",
  "Turkey",
  "Israel",
  "United Arab Emirates",
  "UAE",
  "Saudi Arabia",
  "Egypt",
  "Nigeria",
  "Kenya",
  "Ghana",
  "South Africa",
  "Morocco",
  "Pakistan",
  "Bangladesh",
  "Sri Lanka",
  "Nepal",
  "India",
  "Philippines",
  "Vietnam",
  "Thailand",
  "Malaysia",
  "Singapore",
  "Cambodia",
  "Japan",
  "South Korea",
  "Taiwan",
  "Hong Kong",
  "China",
  "Australia",
  "New Zealand",
];

/** On-site or hybrid wording in the location text. Restricts unless a remote option is stated. */
export const ONSITE_PHRASES: readonly string[] = [
  "on-site",
  "onsite",
  "on site",
  "hybrid",
  "in-office",
  "in office",
];

/**
 * Whitelist for the step 5 onsite rule: a location is only rejected as onsite when it contains one of these
 * places (or an ONSITE_PHRASES word). Unknown text stays `unclear`. Matched whole-word, accent- and
 * case-insensitive (see location.ts). Do not add remote wording or placeholders here.
 */
export const KNOWN_PLACES: readonly string[] = [
  // Germany, Austria, Switzerland
  "Germany",
  "Deutschland",
  "Allemagne",
  "Berlin",
  "Munich",
  "München",
  "Muenchen",
  "Hamburg",
  "Cologne",
  "Köln",
  "Koeln",
  "Frankfurt",
  "Stuttgart",
  "Düsseldorf",
  "Duesseldorf",
  "Dortmund",
  "Essen",
  "Leipzig",
  "Dresden",
  "Hannover",
  "Hanover",
  "Nuremberg",
  "Nürnberg",
  "Nuernberg",
  "Bremen",
  "Bonn",
  "Mannheim",
  "Karlsruhe",
  "Heidelberg",
  "Freiburg",
  "Münster",
  "Muenster",
  "Mainz",
  "Wiesbaden",
  "Darmstadt",
  "Hanau",
  "Kiel",
  "Bavaria",
  "Bayern",
  "Bavière",
  "Austria",
  "Österreich",
  "Oesterreich",
  "Autriche",
  "Vienna",
  "Wien",
  "Vienne",
  "Graz",
  "Linz",
  "Salzburg",
  "Innsbruck",
  "Switzerland",
  "Schweiz",
  "Suisse",
  "Zurich",
  "Zürich",
  "Zuerich",
  "Geneva",
  "Genf",
  "Genève",
  "Basel",
  "Bern",
  "Lausanne",
  // France, Benelux
  "France",
  "Frankreich",
  "Paris",
  "Lyon",
  "Marseille",
  "Toulouse",
  "Bordeaux",
  "Lille",
  "Nantes",
  "Strasbourg",
  "Straßburg",
  "Montpellier",
  "Belgium",
  "Belgien",
  "Belgique",
  "Brussels",
  "Brüssel",
  "Bruxelles",
  "Antwerp",
  "Netherlands",
  "Niederlande",
  "Pays-Bas",
  "Holland",
  "Amsterdam",
  "Rotterdam",
  "Utrecht",
  "Eindhoven",
  "The Hague",
  "Luxembourg",
  "Luxemburg",
  // UK, Ireland, Nordics
  "United Kingdom",
  "UK",
  "Britain",
  "England",
  "Scotland",
  "Wales",
  "London",
  "Manchester",
  "Birmingham",
  "Edinburgh",
  "Glasgow",
  "Bristol",
  "Leeds",
  "Cambridge",
  "Oxford",
  "Ireland",
  "Irland",
  "Irlande",
  "Dublin",
  "Cork",
  "Sweden",
  "Schweden",
  "Suède",
  "Stockholm",
  "Gothenburg",
  "Malmö",
  "Norway",
  "Norwegen",
  "Norvège",
  "Oslo",
  "Denmark",
  "Dänemark",
  "Danemark",
  "Copenhagen",
  "Kopenhagen",
  "Finland",
  "Finnland",
  "Finlande",
  "Helsinki",
  // Southern and Eastern Europe
  "Spain",
  "Spanien",
  "Espagne",
  "Madrid",
  "Barcelona",
  "Valencia",
  "Seville",
  "Portugal",
  "Lisbon",
  "Lissabon",
  "Lisbonne",
  "Porto",
  "Italy",
  "Italien",
  "Italie",
  "Rome",
  "Rom",
  "Milan",
  "Mailand",
  "Milano",
  "Turin",
  "Greece",
  "Griechenland",
  "Grèce",
  "Athens",
  "Athen",
  "Poland",
  "Polen",
  "Pologne",
  "Warsaw",
  "Warschau",
  "Varsovie",
  "Krakow",
  "Kraków",
  "Wroclaw",
  "Gdansk",
  "Czechia",
  "Czech Republic",
  "Tschechien",
  "Prague",
  "Prag",
  "Hungary",
  "Ungarn",
  "Budapest",
  "Romania",
  "Rumänien",
  "Bucharest",
  "Bulgaria",
  "Sofia",
  "Ukraine",
  "Kyiv",
  "Kiev",
  "Turkey",
  "Türkiye",
  "Istanbul",
  "Croatia",
  "Zagreb",
  // Americas
  "United States",
  "USA",
  "U.S.",
  "U.S.A.",
  "America",
  "Amerika",
  "États-Unis",
  "Etats-Unis",
  "New York",
  "NYC",
  "Brooklyn",
  "Williamsburg",
  "San Francisco",
  "Los Angeles",
  "Seattle",
  "Boston",
  "Chicago",
  "Austin",
  "Denver",
  "Atlanta",
  "Miami",
  "Washington",
  "Portland",
  "San Diego",
  "San Jose",
  "Palo Alto",
  "Mountain View",
  "Dallas",
  "Houston",
  "California",
  "Texas",
  "Florida",
  "Canada",
  "Kanada",
  "Toronto",
  "Vancouver",
  "Montreal",
  "Montréal",
  "Ottawa",
  "Mexico",
  "Mexiko",
  "Mexique",
  "Brazil",
  "Brasilien",
  "Brésil",
  "São Paulo",
  "Rio de Janeiro",
  "Argentina",
  "Argentinien",
  "Buenos Aires",
  "Colombia",
  "Bogota",
  "Chile",
  "Santiago",
  // Asia, Pacific, Middle East, Africa
  "Singapore",
  "Singapur",
  "Singapour",
  "Indonesia",
  "Jakarta",
  "Bali",
  "Bandung",
  "Surabaya",
  "Malaysia",
  "Kuala Lumpur",
  "Thailand",
  "Bangkok",
  "Vietnam",
  "Hanoi",
  "Ho Chi Minh",
  "Philippines",
  "Manila",
  "India",
  "Indien",
  "Inde",
  "Bangalore",
  "Bengaluru",
  "Mumbai",
  "Delhi",
  "Hyderabad",
  "Pune",
  "Chennai",
  "Japan",
  "Japon",
  "Tokyo",
  "Osaka",
  "China",
  "Chine",
  "Beijing",
  "Peking",
  "Shanghai",
  "Shenzhen",
  "Hong Kong",
  "Taiwan",
  "Taipei",
  "South Korea",
  "Südkorea",
  "Seoul",
  "Australia",
  "Australien",
  "Australie",
  "Sydney",
  "Melbourne",
  "Brisbane",
  "Perth",
  "New Zealand",
  "Neuseeland",
  "Auckland",
  "Israel",
  "Tel Aviv",
  "Dubai",
  "UAE",
  "Saudi Arabia",
  "Riyadh",
  "Egypt",
  "Cairo",
  "Nigeria",
  "Lagos",
  "Kenya",
  "Nairobi",
  "South Africa",
  "Südafrika",
  "Cape Town",
  "Johannesburg",
  "Morocco",
  "Casablanca",
];

/** The location text or tags offer a remote option. */
export const REMOTE_PHRASES: readonly string[] = [
  "remote",
  "work from home",
  "WFH",
  "work at home",
  "home office",
  "home-based",
  "telecommute",
  "telecommuting",
  "teleworking",
  "distributed",
  "virtual",
  "online",
  "remotely",
  "telework",
  "home-office",
  "homeoffice",
  "remoto",
  "télétravail",
  "teletrabajo",
  "telearbeit",
  "fernarbeit",
  "mobiles arbeiten",
  "ortsunabhängig",
  "digital nomad",
];

/** Multi-place wording: not one concrete place, so a location of this kind is unclear, not onsite. */
export const MULTI_PLACE_PHRASES: readonly string[] = [
  "multiple locations",
  "multiple cities",
  "various",
  "several locations",
  "flexible",
  "negotiable",
  "multi-location",
  "nationwide",
];

/** Wording that says there is no remote option (location, tags or description). */
export const NO_REMOTE_PHRASES: readonly string[] = [
  "no remote",
  "not remote",
  "not fully remote",
  "not a remote",
  "on-site only",
  "onsite only",
  "on site only",
  "in-office only",
];

/** Worldwide wording in the location text or tags. */
export const WORLDWIDE_LOCATION_PHRASES: readonly string[] = [
  "worldwide",
  "world wide",
  "anywhere",
  "everywhere",
  "global",
  "globally",
  "(world)",
  "work from anywhere",
  "remote - anywhere",
];

/** Worldwide wording in the description. More specific than the location list: "global" alone is marketing copy there. */
export const WORLDWIDE_DESCRIPTION_PHRASES: readonly string[] = [
  "worldwide",
  "work from anywhere",
  "remote - anywhere",
  "anywhere in the world",
  "hire globally",
  "hiring globally",
  "global hiring",
  "no geographic restriction",
  "no geographic restrictions",
  "no location restriction",
  "no location restrictions",
  "no timezone restriction",
  "no us timezone restriction",
  "no restrictions",
];

/** Indonesia mention in the location text or description (cities, country, demonym, timezone). */
export const INDONESIA_PHRASES: readonly string[] = [
  "Indonesia",
  "Indonesian",
  "Jakarta",
  "Bandung",
  "Surabaya",
  "Yogyakarta",
  "Bali",
  "Denpasar",
  "Medan",
  "Semarang",
  "WIB",
];

/** Employer-of-record signals. The bare word "remote" is not one; only the provider "Remote.com" is. */
export const EOR_PHRASES: readonly string[] = [
  "employer of record",
  "EOR",
  "Deel",
  "Remote.com",
  "Oyster",
  "Papaya Global",
  "Multiplier",
  "Velocity Global",
  "Globalization Partners",
  "G-P",
  "Omnipresent",
];

/** Junior, intern and graduate wording in the title: rejected before anything else (owner decision 2026-10-08). */
export const ROLE_JUNIOR_PHRASES: readonly string[] = [
  "junior",
  "jr",
  "intern",
  "internship",
  "graduate",
  "new grad",
  "trainee",
  "apprentice",
  "entry level",
  "entry-level",
  // German / French student, intern and apprentice titles (owner live run 2026-10-09). "Stage" is not here: it is
  // ambiguous in English ("Early-Stage") and has its own title-position rule in role.ts.
  "Werkstudent",
  "Werkstudentin",
  "Praktikant",
  "Praktikantin",
  "Praktikum",
  "Pflichtpraktikum",
  "Ausbildung",
  "Auszubildende",
  "Auszubildender",
  "Azubi",
  "Studentische Hilfskraft",
  "Duales Studium",
  "Dualer Student",
  "Stagiaire",
  "Alternance",
  "Alternant",
  "Alternante",
  "Apprenti",
  "Apprentie",
];

/** Target-role skills in the title. A hit keeps the posting, even next to a backend or data word ("Full-Stack (React/Node)"). */
export const ROLE_TARGET_PHRASES: readonly string[] = [
  "frontend",
  "front-end",
  "front end",
  "full-stack",
  "full stack",
  "fullstack",
  "react",
  "typescript",
  "javascript",
  "next.js",
  "nextjs",
  "next js",
  "web3",
  "dapp",
  "ui engineer",
  "web engineer",
  "web developer",
];

/** Mobile-framework phrases: a title containing one is rejected even next to "Front-End" or "React". */
export const ROLE_TARGET_EXCLUDED_PHRASES: readonly string[] = ["react native", "flutter"];

/**
 * Non-engineering roles: rejected before the target-skill check, so "Technical Recruiter - React Engineers"
 * and "Account Executive, Web3" do not keep on a skill word (decision 2026-10-09).
 */
export const ROLE_NON_ENGINEERING_PHRASES: readonly string[] = [
  "attorney",
  "lawyer",
  "counsel",
  "paralegal",
  "physician",
  "nurse",
  "pharmacist",
  "account executive",
  "account manager",
  "business development",
  "copywriter",
  "content writer",
  "technical writer",
  "service desk",
  "help desk",
  "helpdesk",
  "psychotherapist",
  "therapist",
  "recruiter",
  "talent acquisition",
  "support specialist",
  "support engineer",
  "solutions engineer",
  "customer engineer",
  "accountant",
  "bookkeeper",
  "operations manager",
  "office manager",
  "executive assistant",
  "product manager",
  "project manager",
  "program manager",
  "community manager",
  "developer advocate",
  "developer relations",
  "data entry",
  "head of operations",
  "operations lead",
  "crm manager",
  "marketing manager",
  "sales manager",
  "sales representative",
  "sales development",
  "finance manager",
  "hr manager",
  "hr business partner",
  "partnerships manager",
  "compliance officer",
  "compliance manager",
  "legal counsel",
  "social media manager",
  "customer success manager",
  "marketing specialist",
  // French (owner live run 2026-10-09)
  "Technicien",
  "Technicienne",
  "Comptable",
  "Chargé de clientèle",
  "Chargée de clientèle",
  "Chargé(e) de clientèle",
  "Assistant de direction",
  "Assistante de direction",
  "Assistant(e) de direction",
  "Responsable commercial",
  "Responsable commerciale",
];

/**
 * German non-engineering terms (owner live run 2026-10-09). Matched inside compounds as well, as head or start
 * ("Finanzbuchhalterin", "Vertriebsleiter", "IT-Berater"); see compoundPattern in phrases.ts.
 */
export const ROLE_NON_ENGINEERING_GERMAN_TERMS: readonly string[] = [
  "Buchhalter",
  "Berater",
  "Verkäufer",
  "Sachbearbeiter",
  "Kaufmann",
  "Kauffrau",
  "Personalreferent",
  "Steuerberater",
];

/**
 * German domain words (sales, project lead): like the English domain words below they reject a non-engineering title
 * but not an engineering one ("Software Engineer - Vertrieb Tools", "Softwareentwickler Vertriebssysteme").
 * Matched inside compounds; only apply when the title has no engineer/developer noun (see ROLE_GERMAN_ENGINEER_NOUNS).
 */
export const ROLE_NON_ENGINEERING_GERMAN_DOMAIN_TERMS: readonly string[] = [
  "Vertrieb",
  "Projektleiter",
  "Projektmanager",
];

/** German engineer/developer nouns, matched inside compounds ("Softwareentwickler", "Entwicklerin", "Wirtschaftsingenieur"). */
export const ROLE_GERMAN_ENGINEER_NOUNS: readonly string[] = ["entwickler", "ingenieur"];

/**
 * Domain words (product areas such as finance, HR, compliance, partnerships, support, social media, design, sales) that reject a non-engineering title but not an engineering one: "Backend Engineer, Talent Platform"
 * keeps, "Talent Partner" rejects. They only apply when the title has no engineer/developer noun.
 */
export const ROLE_NON_ENGINEERING_DOMAIN_PHRASES: readonly string[] = [
  "legal",
  "medical",
  "clinical",
  "sales",
  "marketing",
  "seo",
  "writer",
  "human resources",
  "hr",
  "people operations",
  "customer success",
  "customer support",
  "finance",
  "social media",
  "compliance",
  "partnerships",
  "designer",
  "product designer",
  "ux designer",
  "ui designer",
  "graphic designer",
  "website designer",
  "recruiting",
  "talent",
  "content",
  "gtm",
  "go-to-market",
  "customer care",
  // French "Commercial(e)" is also an English adjective ("Commercial Platform Engineer"): engineer nouns exempt it.
  "commercial",
  "commerciale",
];

/** Role nouns that make a title an engineering role (used to exempt domain words). */
export const ROLE_ENGINEER_NOUNS: readonly string[] = [
  "engineer",
  "engineers",
  "developer",
  "developers",
];

/** Engineering roles outside the target: rejected unless the title has a target skill. */
export const ROLE_OUT_OF_TARGET_PHRASES: readonly string[] = [
  "backend",
  "back-end",
  "back end",
  "mobile",
  "react native",
  "ios",
  "android",
  "flutter",
  "data engineer",
  "data engineering",
  "data platform",
  "data scientist",
  "data analyst",
  "analytics engineer",
  "machine learning",
  "ml",
  "devops",
  "sre",
  "site reliability",
  "infrastructure engineer",
  "cloud engineer",
  "qa",
  "quality assurance",
  "test engineer",
  "shopify",
  "security software",
  "test automation",
  "research engineer",
  "research scientist",
  "database",
  "platform engineer",
  "sdet",
  "embedded",
  "firmware",
  "golang",
  "python",
  "java",
  "php",
  "ruby",
  "rust",
  "c++",
  ".net",
  "scala",
  "kotlin",
];

/** Engineering and frontend leadership titles: kept without a flag (owner decision 2026-10-08). */
export const ROLE_LEADERSHIP_PHRASES: readonly string[] = [
  "engineering manager",
  "head of engineering",
  "vp of engineering",
  "vp engineering",
  "director of engineering",
  "tech lead",
  "technical lead",
  "cto",
];

/** Seniority words dropped before comparing a title with ROLE_GENERIC_TITLES. */
export const ROLE_SENIORITY_WORDS: readonly string[] = [
  "senior",
  "sr",
  "staff",
  "principal",
  "lead",
  "mid-level",
  "mid level",
  "remote",
];

/** Engineering titles with no skill in them: kept with the `role_unclear` flag, never rejected (owner decision 2026-10-08). */
export const ROLE_GENERIC_TITLES: readonly string[] = [
  "engineer",
  "software engineer",
  "software developer",
  "developer",
  "product engineer",
  "founding engineer",
  "member of technical staff",
  "mts",
  "design engineer",
];

/*
 * Scam signals (R6, docs/research/t_080347c5-scam-signals.md). The *_PATTERNS lists hold regular-expression
 * sources, matched case-insensitively against the posting text. `[^.!?\n]` keeps a match inside one sentence.
 * Bare "Web3", "crypto", "token", "airdrop" and "join our Discord community" are deliberately not signals.
 */

/** Contact (or applying) happens in a chat app. */
export const SCAM_CHAT_CONTACT_PATTERNS: readonly string[] = [
  String.raw`\b(contact|message|dm|ping|text|reach|apply|reply|write)\b[^.!?\n]{0,60}\b(telegram|whats ?app|wa\.me|t\.me|wechat|discord|signal (app|messenger))`,
  String.raw`\bjoin\b[^.!?\n]{0,60}\b(telegram|whats ?app|discord)\b[^.!?\n]{0,60}\b(interview|apply|application|hiring|onboarding|start)\b`,
  String.raw`\b(telegram|whats ?app|discord)\b[^.!?\n]{0,40}\b(for|to) (the |your )?(interview|application|apply)\b`,
];

/** Interview held entirely over chat. */
export const SCAM_CHAT_INTERVIEW_PATTERNS: readonly string[] = [
  String.raw`interview[^.!?\n]{0,40}\b(via|on|through|over|by)\b[^.!?\n]{0,15}\b(telegram|whats ?app|skype|chat|text|discord)\b`,
  String.raw`\b(text|chat)[- ]based interview`,
  String.raw`\bno (video|camera)\b`,
  String.raw`\bcamera not required\b`,
];

/** The applicant is asked to pay, or to move money. */
export const SCAM_UPFRONT_PAYMENT_PATTERNS: readonly string[] = [
  String.raw`\b(registration|training|equipment|processing|security|onboarding|starter[- ]kit|application) fee\b`,
  String.raw`\bpay (for|to get) (the )?(training|equipment|software|job)`,
  String.raw`\bdeposit (a |the )?check`,
  String.raw`\bcheck to deposit\b`,
  String.raw`\bsend (back|on) part of\b`,
  String.raw`\b(buy|purchase) (your own )?(laptop|equipment|software)`,
  String.raw`\b(usdt|trc-?20|bitcoin)\b[^.!?\n]{0,40}\b(deposit|unlock|activate)`,
  String.raw`\b(deposit|unlock|activate)\b[^.!?\n]{0,40}\b(usdt|trc-?20|bitcoin)\b`,
];

/** ID or bank details requested before an offer. */
export const SCAM_ID_EARLY_PATTERNS: readonly string[] = [
  String.raw`\b(send|attach|provide|upload)\b[^.!?\n]{0,60}(passport|national id|id card|ssn|social security|bank (account|details)|routing number)[^.!?\n]{0,60}(with your application|before (the )?interview|to apply)`,
];

/** Wording that makes an ID request normal (after an offer): suppresses `id_early`. */
export const SCAM_ID_EARLY_EXCLUDE_PATTERNS: readonly string[] = [
  String.raw`\b(after|once|upon)\b[^.!?\n]{0,30}\b(offer|hired|background check)\b`,
  String.raw`\bbackground check\b`,
];

/** Task-scam style roles (FTC "task scams", data entry, reshipping). */
export const SCAM_TASK_ROLE_PATTERNS: readonly string[] = [
  String.raw`\bdata entry\b`,
  String.raw`\b(typist|click(ing)? (ads|links)|like (and|&) (share|subscribe)|(rate|review) products|product boosting|app optimi[sz]ation|order optimi[sz]ation|task[- ]based (job|work)|mystery shopp|re-?ship|package forwarding|payment processing agent|crypto (assistant|trader assistant)|(vip|bonus) tasks?)`,
];

/** "No experience" wording; high pay is checked separately. */
export const SCAM_NO_EXPERIENCE_PATTERNS: readonly string[] = [
  String.raw`\bno (prior )?(experience|skills?) (is |are )?(needed|required|necessary)\b`,
  String.raw`\b(experience|skills?) (is |are )?not (needed|required|necessary)\b`,
];

/** Extreme urgency. Each distinct pattern that matches adds the weight, at most twice. Plain "apply now" is not one. */
export const SCAM_URGENCY_PATTERNS: readonly string[] = [
  String.raw`\burgent(ly)?\b`,
  String.raw`\b(immediate(ly)? (start|hiring|joining)|hiring immediately|start (immediately|today|tomorrow))\b`,
  String.raw`\blimited (spots|slots|positions)\b`,
  String.raw`\basap\b`,
];

/** Candidate is told to clone, install or run a repository. */
export const SCAM_REPO_ASSESSMENT_PATTERNS: readonly string[] = [
  String.raw`\b(clone|fork|download)\b[^.!?\n]{0,30}\b(our|the|this)\b[^.!?\n]{0,15}\b(repo|repository|github|bitbucket|gitlab)\b`,
  String.raw`\b(run|execute|then|first|next|start with)\b[^.!?\n]{0,20}\b(npm|yarn|pnpm) (install|i)\b`,
  String.raw`\brun (it|the (project|app|code|demo)) locally\b`,
  String.raw`\b(coding|technical) (assessment|challenge|test|task)[^.!?\n]{0,80}(github\.com|zip|attached)`,
];

/** Fake interview platform that asks for a download. */
export const SCAM_INSTALL_REQUEST_PATTERNS: readonly string[] = [
  String.raw`\b(install|download)\b[^.!?\n]{0,40}\b(driver|plugin|extension|update|app|software)\b[^.!?\n]{0,40}\b(interview|camera|video|meeting|microphone)`,
  String.raw`\b(camera|microphone)\b[^.!?\n]{0,30}\b(not working|issue)\b[^.!?\n]{0,60}\b(install|download)\b`,
];

/** "Paid trial tasks". */
export const SCAM_PAID_TRIAL_PATTERNS: readonly string[] = [
  String.raw`\bpaid (trial|test|probation)( (task|project|day|period))?s?\b`,
  String.raw`\btrial (task|period|week)[^.!?\n]{0,40}(paid|\$|usdt)`,
];

/** Employer cannot be identified. */
export const SCAM_ANONYMOUS_EMPLOYER_PATTERNS: readonly string[] = [
  String.raw`\b(our client|confidential (company|client)|stealth (startup|company)|undisclosed)\b`,
];

/** A description with none of these (or under 300 characters) counts as vague. */
export const SCAM_CONCRETE_MARKERS: readonly string[] = [
  "responsibilit",
  "requirement",
  "you will",
  "we are looking",
  "experience with",
  "stack",
];

/** Free mail domains: a recruiter writing from one of these is a signal. */
export const SCAM_PERSONAL_EMAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
  "icloud.com",
  "qq.com",
  "163.com",
  "mail.com",
  "gmx.com",
];

/** Apply links that are not an employer's own page (forms, shorteners, chat links). */
export const SCAM_SHORTENER_HOSTS: readonly string[] = [
  "bit.ly",
  "tinyurl.com",
  "t.ly",
  "forms.gle",
  "docs.google.com",
  "typeform.com",
  "linktr.ee",
  "carrd.co",
  "notion.site",
  "wa.me",
  "t.me",
];

/** Hosts of the ATS boards the adapters read. Anyone can open a board here, so a host alone verifies nothing. */
export const ATS_APPLY_HOSTS: readonly string[] = [
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "jobs.smartrecruiters.com",
  "apply.workable.com",
  "recruitee.com",
];

/** Source names that come straight from a company's ATS board (derived from the config enum, never copied). */
export const ATS_SOURCE_NAMES: readonly string[] = ATS_TYPES;

/**
 * Language rule (owner live run 2026-10-09): the owner works in English and Indonesian only. English and Indonesian /
 * Bahasa are deliberately absent from every list below.
 */
export const LANGUAGE_NAMES: readonly string[] = [
  "German",
  "French",
  "Dutch",
  "Spanish",
  "Portuguese",
  "Italian",
  "Polish",
  "Swedish",
  "Danish",
  "Norwegian",
  "Finnish",
  "Czech",
  "Japanese",
  "Korean",
  "Mandarin",
  "Chinese",
];

/** German / French job words in a title, matched inside compounds ("Softwareentwickler", "Fachinformatiker"). */
export const LANGUAGE_TITLE_TERMS: readonly string[] = [
  "entwickler",
  "ingenieur",
  "ingénieur",
  "informatiker",
  "mitarbeiter",
  "leiter",
  "développeur",
  "développeuse",
  "developpeur",
  "developpeuse",
  "concepteur",
  "conceptrice",
  "responsable",
];

/** Multi-word French title phrases. */
export const LANGUAGE_TITLE_PHRASES: readonly string[] = ["Chef de projet", "Cheffe de projet"];

/** Title words meaning "German/French speaking" (matched inside compounds). */
export const LANGUAGE_TITLE_SPEAKING_TERMS: readonly string[] = [
  "deutschsprachig",
  "französischsprachig",
  "francophone",
];

/** A clause containing one of these says the language is optional, so it is not a requirement. */
export const LANGUAGE_OPTIONAL_PHRASES: readonly string[] = [
  "a plus",
  "plus",
  "nice to have",
  "nice-to-have",
  "bonus",
  "an advantage",
  "advantage",
  "beneficial",
  "preferred",
  "helpful",
  "not required",
  "optional",
  "desirable",
  "von Vorteil",
  "wünschenswert",
  "ein Plus",
  "nicht erforderlich",
  "un plus",
  "un atout",
  "apprécié",
  "souhaité",
  "serait un plus",
];

/** German / French requirement forms in the description (the language is part of the phrase). */
export const LANGUAGE_NATIVE_REQUIREMENT_PATTERNS: readonly string[] = [
  "(?:deutsch|französisch|spanisch|niederländisch|italienisch|polnisch)kenntnisse",
  "flie(?:ß|ss)end(?:es|e|er)?\\s+(?:deutsch|französisch|spanisch)",
  "verhandlungssicher(?:es|e|er)?\\s+(?:deutsch|französisch)",
  "deutsch\\s*[(:]?\\s*(?:c1|c2|muttersprache|muttersprachlich)",
  "fran[cç]ais\\s+courant",
  "ma[iî]trise\\s+(?:du|de la langue)\\s+fran[cç]ais",
];
