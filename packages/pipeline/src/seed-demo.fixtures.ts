// Fake demo queue for `seed-demo` (phase-4 conventions section 10). Made-up companies, example.com domains,
// the fake persona only. Nothing here comes from config/ or data/.
import type { APPLY_TYPES } from "@job-agent/core";

type ApplyType = (typeof APPLY_TYPES)[number];
type Tier = "indonesia" | "regional" | "global_adjusted" | "global_flat";

export interface DemoCompany {
  name: string;
  slug: string;
  domain: string;
  ats?: "greenhouse" | "lever";
}

export interface DemoPosting {
  key: string;
  company: string;
  title: string;
  source: string;
  location: string;
  locationClass: "worldwide" | "apac_ok" | "restricted" | "unclear";
  flags: string[];
  salaryIdr?: [number, number];
  salaryText?: string;
  apply: {
    type: ApplyType;
    method: "ats_db" | "ats_board" | "careers_page" | "posting_text" | "source";
  };
  /** No intel row: not enriched yet. */
  intel:
    | {
        kind: "scored";
        fit: number;
        reasons: string[];
        tier: Tier;
        askUsdYear: number;
        scam?: [number, string];
      }
    | { kind: "waiting"; status: "pending" | "budget_wait" | "failed" | "fx_wait" }
    | { kind: "suspicious"; score: number; reasons: string[] }
    | { kind: "none" };
  questions?: { id: string; label: string; type: string; required: boolean; matchedKey?: string }[];
}

export const DEMO_COMPANIES: DemoCompany[] = [
  {
    name: "Northwind Demo Labs",
    slug: "northwind-demo",
    domain: "northwind-demo.example.com",
    ats: "greenhouse",
  },
  { name: "Lumen Demo Works", slug: "lumen-demo", domain: "lumen-demo.example.com", ats: "lever" },
  { name: "Cobalt Sample Co", slug: "cobalt-sample", domain: "cobalt-sample.example.com" },
  { name: "Quartz Example Studio", slug: "quartz-example", domain: "quartz-example.example.com" },
  { name: "Fjord Fake Systems", slug: "fjord-fake", domain: "fjord-fake.example.com" },
  { name: "Easy Money Demo Ltd", slug: "easy-money-demo", domain: "easy-money-demo.example.com" },
  { name: "Pending Sample Inc", slug: "pending-sample", domain: "pending-sample.example.com" },
];

export const DEMO_POSTINGS: DemoPosting[] = [
  {
    key: "top-ats",
    company: "Northwind Demo Labs",
    title: "Senior Backend Engineer",
    source: "greenhouse",
    location: "Remote, worldwide",
    locationClass: "worldwide",
    flags: [],
    salaryIdr: [60_000_000, 80_000_000],
    apply: { type: "ats", method: "ats_db" },
    intel: {
      kind: "scored",
      fit: 88,
      reasons: ["TypeScript and Node match the CV", "Remote worldwide", "Salary above the floor"],
      tier: "global_flat",
      askUsdYear: 66_000,
    },
    questions: [
      {
        id: "q_name",
        label: "Full name",
        type: "input_text",
        required: true,
        matchedKey: "identity.full_name",
      },
      {
        id: "q_notice",
        label: "Notice period",
        type: "input_text",
        required: true,
        matchedKey: "availability.notice",
      },
      {
        id: "q_why",
        label: "Why do you want to work at Northwind Demo Labs?",
        type: "textarea",
        required: true,
      },
    ],
  },
  {
    key: "top-form",
    company: "Lumen Demo Works",
    title: "Full-stack Developer",
    source: "lever",
    location: "APAC remote",
    locationClass: "apac_ok",
    flags: [],
    salaryText: "USD 4,000 - 5,000 / month",
    salaryIdr: [64_000_000, 80_000_000],
    apply: { type: "company_form", method: "careers_page" },
    intel: {
      kind: "scored",
      fit: 74,
      reasons: ["React and Postgres in the stack", "APAC timezone overlap"],
      tier: "regional",
      askUsdYear: 54_000,
      scam: [10, "company website is very new"],
    },
  },
  {
    key: "top-paid",
    company: "Cobalt Sample Co",
    title: "Platform Engineer",
    source: "remoteok",
    location: "Worldwide",
    locationClass: "worldwide",
    flags: [],
    apply: { type: "paid_aggregator", method: "source" },
    intel: {
      kind: "scored",
      fit: 67,
      reasons: ["Kubernetes experience listed", "Pay is not stated"],
      tier: "global_adjusted",
      askUsdYear: 48_000,
    },
  },
  {
    key: "top-unclear",
    company: "Quartz Example Studio",
    title: "Staff Software Engineer",
    source: "himalayas",
    location: "Remote (some regions)",
    locationClass: "unclear",
    flags: ["location_unclear"],
    apply: { type: "signup_required", method: "source" },
    intel: {
      kind: "scored",
      fit: 81,
      reasons: ["Strong stack match", "Location wording is unclear"],
      tier: "global_flat",
      askUsdYear: 72_000,
    },
  },
  {
    key: "not-a-fit",
    company: "Fjord Fake Systems",
    title: "Embedded Firmware Engineer",
    source: "remotive",
    location: "Remote",
    locationClass: "worldwide",
    flags: [],
    apply: { type: "unknown", method: "source" },
    intel: {
      kind: "scored",
      fit: 31,
      reasons: ["Embedded C is outside the CV"],
      tier: "global_flat",
      askUsdYear: 40_000,
    },
  },
  {
    key: "suspicious",
    company: "Easy Money Demo Ltd",
    title: "Data Entry Assistant (earn fast)",
    source: "remoteok",
    location: "Anywhere",
    locationClass: "worldwide",
    flags: [],
    apply: { type: "unknown", method: "source" },
    intel: {
      kind: "suspicious",
      score: 85,
      reasons: [
        "asks for a payment before hiring",
        "contact only through a chat app",
        "pay far above the role's market",
      ],
    },
  },
  {
    key: "waiting-budget",
    company: "Pending Sample Inc",
    title: "Backend Developer",
    source: "arbeitnow",
    location: "Remote",
    locationClass: "apac_ok",
    flags: [],
    apply: { type: "unknown", method: "source" },
    intel: { kind: "waiting", status: "budget_wait" },
  },
  {
    key: "waiting-unclear",
    company: "Pending Sample Inc",
    title: "Site Reliability Engineer",
    source: "weworkremotely",
    location: "Remote, timezone unclear",
    locationClass: "unclear",
    flags: ["location_unclear", "indonesia_unclear"],
    apply: { type: "unknown", method: "source" },
    intel: { kind: "none" },
  },
];

export const DEMO_ANSWERS = [
  {
    key: "identity.full_name",
    group: "identity",
    question: "Full name",
    answer: "Alex Example",
    type: "text" as const,
  },
  {
    key: "availability.notice",
    group: "availability",
    question: "Notice period",
    answer: "2 weeks",
    type: "text" as const,
  },
];

export interface DemoDryRun {
  /** Key of the DEMO_POSTINGS entry the run belongs to. */
  posting: string;
  ats: "greenhouse" | "lever";
  status: "filled" | "needs_input";
  stopReason: "uncovered_question" | null;
  fields: {
    label: string;
    type: string;
    required: boolean;
    source: "answer" | "none";
    key?: string;
    value?: string;
    note?: string;
  }[];
}

// Fake-persona runs with no screenshot file (screenshot_path stays null), so the dashboard tab can be built without a browser.
export const DEMO_DRY_RUNS: DemoDryRun[] = [
  {
    posting: "top-ats",
    ats: "greenhouse",
    status: "filled",
    stopReason: null,
    fields: [
      {
        label: "Full name",
        type: "input_text",
        required: true,
        source: "answer",
        key: "identity.full_name",
        value: "Alex Example",
      },
      {
        label: "Notice period",
        type: "input_text",
        required: true,
        source: "answer",
        key: "availability.notice",
        value: "2 weeks",
      },
    ],
  },
  {
    posting: "top-form",
    ats: "lever",
    status: "needs_input",
    stopReason: "uncovered_question",
    fields: [
      {
        label: "Full name",
        type: "input_text",
        required: true,
        source: "answer",
        key: "identity.full_name",
        value: "Alex Example",
      },
      {
        label: "Why do you want to work at Lumen Demo Works?",
        type: "textarea",
        required: true,
        source: "none",
        note: "needs input: no approved answer",
      },
    ],
  },
];
