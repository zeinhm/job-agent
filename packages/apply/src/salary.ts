/**
 * The one salary detector (phase-4 conventions section 7). Matching, the inbox list, the inbox answer / link guard and
 * the answer index all use it, so a pay wording is never covered by a bank answer. Plain code, no fuzzy matching.
 *
 * A false positive is safe (the question stays in review); a false negative is not. When in doubt a wording is salary.
 */

const ALTERNATIVES = [
  // Pay words (English).
  String.raw`salar(?:y|ies)`,
  String.raw`wages?`,
  String.raw`income`,
  String.raw`earn(?:s|ed|ing|ings)?`,
  String.raw`compensat\w*`,
  String.raw`remuneration`,
  String.raw`fees?`,
  String.raw`take home`,
  String.raw`gross`,
  String.raw`net (?:pay|salary|income|monthly|annual)`,
  String.raw`stipend`,
  String.raw`ctc`,
  String.raw`ote`,
  String.raw`pay`,
  String.raw`paid`,
  String.raw`paying`,
  String.raw`(?:expected|desired|target|current|total) comp`,
  String.raw`comp (?:expectations?|range)`,
  String.raw`financial expectations?`,
  String.raw`total (?:cash|rewards?|package)`,
  String.raw`(?:expected|desired|target|current|annual|salary|compensation|benefits) package`,
  // Base pay: "base" alone is too common ("base image"), so it needs a pay qualifier.
  String.raw`(?:expected|desired|target|preferred|minimum|current|annual|yearly|monthly) base`,
  String.raw`base (?:pay|salary|compensation|rate)`,
  String.raw`your base`,
  // Rates.
  String.raw`(?:hourly|daily|day|weekly|monthly|annual) rate`,
  String.raw`(?:expected|desired|target|minimum|preferred) rate`,
  String.raw`your rate`,
  String.raw`rate expectations?`,
  // Currency and period wording.
  String.raw`per (?:annum|month|year|hour)`,
  String.raw`(?:usd|idr|eur|gbp|sgd|aud|cad|inr|rupiah)`,
  // Indonesian.
  String.raw`gaji\w*`,
  String.raw`upah`,
  String.raw`penghasilan`,
  String.raw`pendapatan`,
  String.raw`kompensasi`,
  String.raw`remunerasi`,
  String.raw`tarif`,
  String.raw`nominal`,
  String.raw`imbalan`,
  String.raw`honor(?:arium)?`,
  String.raw`bayaran`,
  String.raw`(?:di)?bayar(?:kan)?`,
];

const SALARY = new RegExp(String.raw`\b(?:${ALTERNATIVES.join("|")})\b`, "u");

/** "How much do you expect / want / make ...": a pay question with no pay noun in it. */
const HOW_MUCH =
  /\bhow much\b.*\b(?:expect|want|looking|require|make|ask|need|like|receive|prefer|would|get)\b/u;

/** Indonesian "berapa ... diharapkan / diinginkan": a pay question with no pay noun in it. */
const BERAPA = /\bberapa\b.*\b(?:harap\w*|ingin\w*|diharapkan|diinginkan)\b/u;

/** Case, punctuation and whitespace do not matter; the label is normalized here so callers may pass either form. */
function normalize(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True for any wording that asks about pay. */
export function isSalaryWording(label: string): boolean {
  const n = normalize(label);
  return SALARY.test(n) || HOW_MUCH.test(n) || BERAPA.test(n);
}
