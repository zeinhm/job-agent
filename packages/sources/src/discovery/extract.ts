import type { CompanyConfig } from "@job-agent/core";

export type AtsType = CompanyConfig["ats"];

export interface AtsSlug {
  ats: AtsType;
  slug: string;
}

// Regexes from docs/research/t_250e744a-search-api.md section 4. They only propose candidates;
// verifyBoard() decides whether a slug is real.
const PATTERNS: readonly { ats: AtsType; re: RegExp }[] = [
  {
    ats: "greenhouse",
    re: /^https:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?!embed(?:[/?#]|$))([A-Za-z0-9_-]+)(?:[/?#]|$)/,
  },
  { ats: "lever", re: /^https:\/\/jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9_-]+)(?:[/?#]|$)/ },
  { ats: "ashby", re: /^https:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/ },
  {
    ats: "smartrecruiters",
    re: /^https:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)(?:[/?#]|$)/,
  },
  {
    ats: "workable",
    re: /^https:\/\/apply\.workable\.com\/(?!api(?:[/?#]|$))([a-z0-9-]+)(?:[/?#]|$)/,
  },
  {
    ats: "recruitee",
    re: /^https:\/\/(?!(?:www|api|support|careers)\.)([a-z0-9-]+)\.recruitee\.com\//,
  },
];

const GREENHOUSE_EMBED_FOR =
  /^https:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/embed\/[^?#]*\?(?:[^#]*&)?for=([A-Za-z0-9_-]+)/;

/** Maps one search result URL to an ATS board slug, or null when it is not a recognised board URL. */
export function extractAtsSlug(url: string): AtsSlug | null {
  const embed = GREENHOUSE_EMBED_FOR.exec(url);
  if (embed?.[1]) return { ats: "greenhouse", slug: embed[1] };
  for (const { ats, re } of PATTERNS) {
    const raw = re.exec(url)?.[1];
    if (!raw) continue;
    let slug = raw;
    if (ats === "ashby") {
      try {
        slug = decodeURIComponent(raw);
      } catch {
        return null;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
    }
    return { ats, slug };
  }
  return null;
}
