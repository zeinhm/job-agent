export type ParsedFirstLine = {
  company: string;
  title: string;
  locationText?: string;
  salaryText?: string;
};

const MAX_TITLE_LENGTH = 120;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const ROLE_RE =
  /\b(engineer|engineers|engineering|developer|developers|dev|frontend|front-end|backend|back-end|full[- ]?stack|software|swe|sre|devops|programmer|architect|designer|scientist|analyst|manager|lead|cto|founder|founding)\b/i;

const LOCATION_RE =
  /\b(remote|onsite|on-site|hybrid|worldwide|global|anywhere|timezones?|us|usa|uk|eu|emea|apac|europe|asia|america|canada|germany|france|spain|india|japan|singapore|indonesia|australia|brazil|london|berlin|paris|amsterdam|toronto|vancouver|boston|seattle|austin|chicago|denver|nyc|sf|bay area|san francisco|new york|los angeles|portland|tokyo|sydney|dublin|zurich|munich|stockholm|lisbon|barcelona)\b|\b[A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+)*, (?:[A-Z]{2}|[A-Z][a-z]+)\b/i;

const SALARY_RE = /[$€£¥₹]|\b(usd|eur|gbp|cad|aud|sgd|idr|chf|inr|jpy)\b|\d\s?k\b/i;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** First line of an HN comment as plain text. HN separates paragraphs with `<p>`. */
export function firstLineOf(html: string): string {
  const raw = html.split(/<p>|\r?\n/i, 1)[0] ?? "";
  return decodeEntities(raw.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export const NO_ROLE_TITLE = "(no role title)";

/**
 * A segment that is only a link. Scheme-less links need a `www.` prefix or a path, so tech
 * names such as `Node.js` or `Vue.js` stay role segments.
 */
const URL_ONLY_RE =
  /^(?:https?:\/\/\S+|www\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}[/?#]\S*)$/i;

/** Link targets (`href`) in the first line of an HN comment, entities decoded, in order. */
export function firstLineLinks(html: string): string[] {
  const raw = html.split(/<p>|\r?\n/i, 1)[0] ?? "";
  return [...raw.matchAll(/href=\\?"([^"\\]+)\\?"/gi)]
    .map((m) => decodeEntities(m[1] ?? ""))
    .filter((u) => /^https?:\/\//i.test(u));
}

/** Never returns a bare URL as the title: a link-only comment has no role title. */
function unknownPosting(line: string): ParsedFirstLine {
  const title = URL_ONLY_RE.test(line) || line === "" ? NO_ROLE_TITLE : line;
  return { company: "unknown", title: title.slice(0, MAX_TITLE_LENGTH) };
}

/** Parses the "Company | Role | Location | Salary" convention of an HN "Who is hiring?" comment. */
export function parseFirstLine(html: string): ParsedFirstLine {
  const line = firstLineOf(html);
  const segments = line
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const company = segments[0];
  if (segments.length < 2 || company === undefined) return unknownPosting(line);

  const rest = segments.slice(1).filter((s) => !URL_ONLY_RE.test(s));
  if (rest.length === 0) return unknownPosting(line);
  const roleSegment =
    rest.find((s) => ROLE_RE.test(s)) ??
    rest.find((s) => !LOCATION_RE.test(s) && !SALARY_RE.test(s));
  const title = roleSegment ?? NO_ROLE_TITLE;
  const locations = rest.filter((s) => s !== roleSegment && LOCATION_RE.test(s));
  const salary = rest.find((s) => s !== roleSegment && SALARY_RE.test(s));

  return {
    company,
    title: title.slice(0, MAX_TITLE_LENGTH),
    ...(locations.length > 0 && { locationText: locations.join(" | ") }),
    ...(salary !== undefined && { salaryText: salary }),
  };
}
