import {
  ATS_APPLY_HOSTS,
  SCAM_ANONYMOUS_EMPLOYER_PATTERNS,
  SCAM_CHAT_CONTACT_PATTERNS,
  SCAM_CHAT_INTERVIEW_PATTERNS,
  SCAM_CONCRETE_MARKERS,
  SCAM_ID_EARLY_EXCLUDE_PATTERNS,
  SCAM_ID_EARLY_PATTERNS,
  SCAM_INSTALL_REQUEST_PATTERNS,
  SCAM_NO_EXPERIENCE_PATTERNS,
  SCAM_PAID_TRIAL_PATTERNS,
  SCAM_PERSONAL_EMAIL_DOMAINS,
  SCAM_REPO_ASSESSMENT_PATTERNS,
  SCAM_SHORTENER_HOSTS,
  SCAM_TASK_ROLE_PATTERNS,
  SCAM_UPFRONT_PAYMENT_PATTERNS,
  SCAM_URGENCY_PATTERNS,
} from "../filters/keywords.ts";
import type { Extraction } from "./extract.ts";

/** Score at or above this is `suspicious` (R6, docs/phase-2-conventions.md). */
export const SCAM_THRESHOLD = 60;

/** Points per signal (R6 section 1). `ats_verified` is the largest discount, `new_domain_*` the age tiers. */
export const SCAM_WEIGHTS = {
  chat_contact: 30,
  personal_email: 25,
  chat_interview: 20,
  upfront_payment: 60,
  id_early: 35,
  task_scam_role: 40,
  no_experience_high_pay: 30,
  no_experience_no_pay: 10,
  vague: 10,
  urgency: 5,
  repo_assessment: 40,
  install_request: 40,
  paid_trial: 15,
  shortener_apply: 15,
  anonymous_employer: 5,
  new_domain_30d: 30,
  new_domain_90d: 20,
  new_domain_365d: 8,
  domain_mismatch: 15,
  lookalike: 30,
  ats_missing: 10,
  ats_verified: 40,
  placeholder_pay: 5,
} as const;
export type ScamWeights = Record<keyof typeof SCAM_WEIGHTS, number>;

/**
 * Verification offsets never cancel these: a fee, a task-scam role, a malicious assessment, or a contact,
 * ID or domain red flag stays. A scammer can clone a real listing's title and company, so "verified" must not
 * hide a changed contact path (decisions.md 2026-10-09, deviation from R6).
 */
const DECISIVE = new Set([
  "upfront_payment",
  "task_scam_role",
  "repo_assessment",
  "install_request",
  "chat_contact",
  "personal_email",
  "chat_interview",
  "id_early",
  "lookalike",
  "domain_mismatch",
]);

export type ScamVerification = "verified" | "missing" | "unknown";

export interface ScamInput {
  title: string;
  companyName: string;
  /** Company website domain from config or the posting, if known. */
  companyDomain?: string | null;
  descriptionText: string | null;
  applyUrl: string | null;
  /** Facts from the extraction stage; null if there is none. */
  extraction: Extraction | null;
  /** Domain the applicant is sent to and what the age lookup found; `days: null` = lookup failed or unsupported. */
  domainAge?: { domain: string; days: number | null } | null;
  verification: ScamVerification;
}

export interface ScamReason {
  signal: string;
  points: number;
  text: string;
}

export interface ScamResult {
  score: number;
  reasons: ScamReason[];
  suspicious: boolean;
}

/** `chat_contact +30: ...`. The signed number is the only part parsed back by `reasonPoints`. */
export function formatReason(r: ScamReason): string {
  return `${r.signal} ${r.points >= 0 ? "+" : "-"}${Math.abs(r.points)}: ${r.text}`;
}

export function reasonPoints(line: string): number {
  const m = /^\S+ ([+-]\d+):/.exec(line);
  if (!m?.[1]) throw new Error(`not a scam reason line: ${line}`);
  return Number(m[1]);
}

const compile = (sources: readonly string[]) => sources.map((s) => new RegExp(s, "i"));
const anyMatch = (res: RegExp[], text: string) => res.some((re) => re.test(text));

const CHAT_CONTACT = compile(SCAM_CHAT_CONTACT_PATTERNS);
const CHAT_INTERVIEW = compile(SCAM_CHAT_INTERVIEW_PATTERNS);
const UPFRONT = compile(SCAM_UPFRONT_PAYMENT_PATTERNS);
const ID_EARLY = compile(SCAM_ID_EARLY_PATTERNS);
const ID_EXCLUDE = compile(SCAM_ID_EARLY_EXCLUDE_PATTERNS);
const TASK_ROLE = compile(SCAM_TASK_ROLE_PATTERNS);
const NO_EXPERIENCE = compile(SCAM_NO_EXPERIENCE_PATTERNS);
const URGENCY = compile(SCAM_URGENCY_PATTERNS);
const REPO = compile(SCAM_REPO_ASSESSMENT_PATTERNS);
const INSTALL = compile(SCAM_INSTALL_REQUEST_PATTERNS);
const PAID_TRIAL = compile(SCAM_PAID_TRIAL_PATTERNS);
const ANONYMOUS = compile(SCAM_ANONYMOUS_EMPLOYER_PATTERNS);

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "or"]);

/** Host without `www.`, lowercase; null if not a URL. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Registrable domain, approximated: last two labels, three after a short second-level label (`co.id`). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const last = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  return (SECOND_LEVEL.has(second) && last.length === 2 ? labels.slice(-3) : labels.slice(-2)).join(
    ".",
  );
}

const hostIn = (host: string, list: readonly string[]) =>
  list.some((h) => host === h || host.endsWith(`.${h}`));

export function isAtsHost(host: string): boolean {
  return hostIn(host, ATS_APPLY_HOSTS);
}

function emailDomains(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return [...out];
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)>"']+/gi)].map((m) => m[0]);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The domain the applicant is sent to, for the age lookup: the apply URL host, else the first company-looking
 * e-mail domain. ATS, shortener, chat and personal-mail hosts and the company's own domain are skipped.
 */
export function pickContactDomain(input: {
  applyUrl: string | null;
  descriptionText: string | null;
  companyDomain?: string | null;
}): string | null {
  const own = input.companyDomain ? registrableDomain(input.companyDomain) : null;
  const usable = (host: string) => {
    const reg = registrableDomain(host);
    return (
      reg !== own &&
      !isAtsHost(host) &&
      !hostIn(host, SCAM_SHORTENER_HOSTS) &&
      !SCAM_PERSONAL_EMAIL_DOMAINS.includes(reg)
    );
  };
  const applyHost = input.applyUrl ? hostOf(input.applyUrl) : null;
  if (applyHost && usable(applyHost)) return registrableDomain(applyHost);
  for (const d of emailDomains(input.descriptionText ?? "")) {
    if (usable(d)) return registrableDomain(d);
  }
  return null;
}

function annualUsd(
  amount: number,
  period: "year" | "month" | "hour" | "week" | "day",
): number | null {
  switch (period) {
    case "year":
      return amount;
    case "month":
      return amount * 12;
    case "week":
      return amount * 52;
    case "day":
      return amount * 260;
    case "hour":
      return amount * 2080;
  }
}

const HIGH_PAY_USD_YEAR = 60_000;

/** Highest annualised USD figure the posting names, from the extraction or a `$N/period` phrase; null if none. */
function statedPayUsdYear(text: string, extraction: Extraction | null): number | null {
  const values: number[] = [];
  const s = extraction?.listedSalary;
  if (s && s.currency.toUpperCase() === "USD") {
    const top = s.max ?? s.min;
    if (top !== null) {
      const v = annualUsd(top, s.period);
      if (v !== null) values.push(v);
    }
  }
  for (const m of text.matchAll(
    /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:\/|per|a|each)\s*(day|week|month|year|yr|hour|hr)\b/gi,
  )) {
    const n = Number((m[1] ?? "").replace(/,/g, "")) * (m[2] ? 1000 : 1);
    const unit = (m[3] ?? "").toLowerCase();
    const period = unit === "yr" ? "year" : unit === "hr" ? "hour" : (unit as "day");
    const v = annualUsd(n, period);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * Pure scam score (R6): rule hits on the text plus extracted signals plus verification, 0-100.
 * Every point has a reason line; the reasons sum to the score (a cap is itself a reason).
 */
export function scoreScam(
  input: ScamInput,
  weights: ScamWeights = SCAM_WEIGHTS,
  threshold: number = SCAM_THRESHOLD,
): ScamResult {
  const text = `${input.title}\n${input.descriptionText ?? ""}`;
  const description = input.descriptionText ?? "";
  const x = input.extraction;
  const reasons: ScamReason[] = [];
  const add = (signal: string, points: number, why: string) => {
    reasons.push({ signal, points, text: why });
  };

  // --- contact -----------------------------------------------------------------------------------
  const applyHost = input.applyUrl ? hostOf(input.applyUrl) : null;
  const ownDomain = input.companyDomain ? registrableDomain(input.companyDomain) : null;
  const hasRealApplyLink =
    applyHost !== null &&
    (isAtsHost(applyHost) || (ownDomain !== null && registrableDomain(applyHost) === ownDomain));
  const chatByLlm =
    (x?.contactChannels ?? []).some((c) =>
      ["telegram", "whatsapp", "discord", "other_chat"].includes(c),
    ) && !(x?.contactChannels ?? []).some((c) => c === "ats" || c === "company_form");
  if (!hasRealApplyLink && (anyMatch(CHAT_CONTACT, text) || chatByLlm)) {
    add(
      "chat_contact",
      weights.chat_contact,
      anyMatch(CHAT_CONTACT, text)
        ? "applicants are told to make contact through a chat app"
        : "extraction: contact only through a chat app",
    );
  }

  const personalDomain = emailDomains(description).find((d) =>
    SCAM_PERSONAL_EMAIL_DOMAINS.includes(d),
  );
  if (personalDomain || x?.personalEmailDomain === true) {
    add(
      "personal_email",
      weights.personal_email,
      personalDomain
        ? `recruiter writes from a free mail domain (${personalDomain})`
        : "extraction: contact e-mail is on a free mail domain",
    );
  }

  if (anyMatch(CHAT_INTERVIEW, text)) {
    add("chat_interview", weights.chat_interview, "interview is held over chat or without video");
  }

  // --- money and identity ---------------------------------------------------------------------------
  if (anyMatch(UPFRONT, text)) {
    add("upfront_payment", weights.upfront_payment, "asks the applicant to pay or to move money");
  }

  const idByRule = anyMatch(ID_EARLY, text) && !anyMatch(ID_EXCLUDE, text);
  if (idByRule || x?.asksForPaymentOrId === true) {
    add(
      "id_early",
      weights.id_early,
      idByRule
        ? "asks for ID or bank details with the application"
        : "extraction: asks for payment, bank details or ID",
    );
  }

  // --- role and pay ---------------------------------------------------------------------------------
  if (anyMatch(TASK_ROLE, text)) {
    add(
      "task_scam_role",
      weights.task_scam_role,
      "role matches a task-scam pattern (data entry, boosting, reshipping)",
    );
  }

  if (anyMatch(NO_EXPERIENCE, text)) {
    const pay = statedPayUsdYear(text, x);
    if (pay === null) {
      add(
        "no_experience_no_pay",
        weights.no_experience_no_pay,
        '"no experience needed" and no pay figure',
      );
    } else if (pay >= HIGH_PAY_USD_YEAR) {
      add(
        "no_experience_high_pay",
        weights.no_experience_high_pay,
        `"no experience needed" with pay of about ${Math.round(pay)} USD a year`,
      );
    }
  }

  const salary = x?.listedSalary;
  if (salary && salary.min !== null && salary.max !== null) {
    if ((salary.min > 0 && salary.max / salary.min >= 8) || salary.max >= 900_000) {
      add("placeholder_pay", weights.placeholder_pay, "listed pay range looks like a placeholder");
    }
  }

  // --- text quality ---------------------------------------------------------------------------------
  const lowered = description.toLowerCase();
  const vagueByRule =
    description.trim().length < 300 || !SCAM_CONCRETE_MARKERS.some((m) => lowered.includes(m));
  if (vagueByRule || x?.vagueDescription === true) {
    add(
      "vague",
      weights.vague,
      vagueByRule
        ? "description is short or names no duties or requirements"
        : "extraction: description is vague",
    );
  }

  const urgencyHits = URGENCY.filter((re) => re.test(text)).length;
  const urgencyCount = Math.min(
    2,
    urgencyHits > 0 ? urgencyHits : x?.urgencyLanguage === true ? 1 : 0,
  );
  if (urgencyCount > 0) {
    add(
      "urgency",
      urgencyCount * weights.urgency,
      `${urgencyHits > 0 ? "" : "extraction: "}extreme urgency wording (${urgencyCount} hit${urgencyCount > 1 ? "s" : ""})`,
    );
  }

  if (anyMatch(REPO, text) || x?.repoAssessmentEarly === true) {
    add(
      "repo_assessment",
      weights.repo_assessment,
      anyMatch(REPO, text)
        ? "candidate is told to clone, install or run a repository"
        : "extraction: repository-based assessment early in the process",
    );
  }
  if (anyMatch(INSTALL, text)) {
    add("install_request", weights.install_request, "asks to install software for the interview");
  }
  if (anyMatch(PAID_TRIAL, text)) {
    add("paid_trial", weights.paid_trial, "paid trial tasks");
  }

  const links = [...(input.applyUrl ? [input.applyUrl] : []), ...urlsIn(description)];
  const shortener = links.map(hostOf).find((h) => h !== null && hostIn(h, SCAM_SHORTENER_HOSTS));
  if (shortener) {
    add("shortener_apply", weights.shortener_apply, `apply path goes through ${shortener}`);
  }

  const genericCompany = slug(input.companyName).length === 0;
  if (genericCompany || anyMatch(ANONYMOUS, text)) {
    add("anonymous_employer", weights.anonymous_employer, "employer is anonymous or unnamed");
  }

  // --- domains --------------------------------------------------------------------------------------
  const emails = emailDomains(description).filter((d) => !SCAM_PERSONAL_EMAIL_DOMAINS.includes(d));
  if (ownDomain) {
    const foreign = emails.find((d) => registrableDomain(d) !== ownDomain);
    if (foreign) {
      add(
        "domain_mismatch",
        weights.domain_mismatch,
        `contact e-mail domain ${foreign} is not the company's site ${ownDomain}`,
      );
    }
  }
  const candidates = [...emails, ...(applyHost && !isAtsHost(applyHost) ? [applyHost] : [])]
    .map(registrableDomain)
    .filter((d) => d !== ownDomain);
  const companyKeys = [
    ...new Set([ownDomain?.split(".")[0] ?? "", slug(input.companyName)]),
  ].filter((k) => k.length >= 4);
  const lookalike = candidates.find((d) => {
    const label = d.split(".")[0] ?? "";
    return companyKeys.some((k) => {
      if (
        label.startsWith(k) &&
        /^-?(careers?|jobs?|hiring|recruit\w*|hr)$/.test(label.slice(k.length))
      )
        return true;
      return k.length >= 5 && label.length >= 5 && editDistance(label, k) <= 2;
    });
  });
  if (lookalike) {
    add("lookalike", weights.lookalike, `${lookalike} imitates the company's domain`);
  }

  if (input.domainAge) {
    const { domain, days } = input.domainAge;
    if (days === null) {
      add("domain_age_unknown", 0, "domain age unknown");
    } else if (days < 30) {
      add("new_domain", weights.new_domain_30d, `${domain} was registered ${days} days ago`);
    } else if (days < 90) {
      add("new_domain", weights.new_domain_90d, `${domain} was registered ${days} days ago`);
    } else if (days < 365) {
      add("new_domain", weights.new_domain_365d, `${domain} was registered ${days} days ago`);
    }
  }

  // --- verification ---------------------------------------------------------------------------------
  if (input.verification === "verified") {
    const offsettable = reasons
      .filter((r) => r.points > 0 && !DECISIVE.has(r.signal))
      .reduce((sum, r) => sum + r.points, 0);
    const discount = Math.min(weights.ats_verified, offsettable);
    if (discount > 0)
      add(
        "ats_verified",
        -discount,
        discount === weights.ats_verified
          ? "posting comes from, or matches a role on, the company's own ATS"
          : "posting comes from, or matches a role on, the company's own ATS (offsets only non-decisive points)",
      );
  } else if (input.verification === "missing") {
    add(
      "ats_missing",
      weights.ats_missing,
      "role not found on the company's own ATS board fetched today",
    );
  }

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  if (raw > 100) add("score_cap", 100 - raw, "score is capped at 100");
  const score = Math.max(0, Math.min(100, raw));
  return { score, reasons, suspicious: score >= threshold };
}
