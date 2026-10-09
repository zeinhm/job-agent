import { SALARY_BONUS, UNCLEAR_FLAG_PENALTY, salaryBonusApplies } from "./rank.ts";

export interface WhyInput {
  fitScore: number;
  fitReasons: string[];
  /** Stored resolve reasons; only the role line is shown. */
  resolvedReasons?: string[];
  tier: string | null;
  askLabel: string | null;
  remainingUnclearFlags: string[];
  listedMaxIdrMonth: number | null;
  askIdrMonth: number | null;
  scamScore: number | null;
}

const oneLine = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;]+$/, "");

/** One line built only from stored facts: the fit reasons first, then what moved the rank. */
export function buildWhy(i: WhyInput): string {
  const parts = [`fit ${i.fitScore}`];
  const reasons = i.fitReasons.map(oneLine).filter((r) => r !== "");
  parts.push(reasons.length > 0 ? reasons.slice(0, 3).join("; ") : "no reasons recorded");
  const role = (i.resolvedReasons ?? []).map(oneLine).find((r) => r.startsWith("Role:"));
  if (role !== undefined) parts.push(role);
  if (i.tier !== null && i.askLabel !== null) parts.push(`tier ${i.tier}, ask ${i.askLabel}`);
  if (salaryBonusApplies(i.listedMaxIdrMonth, i.askIdrMonth))
    parts.push(`listed max covers the ask (+${SALARY_BONUS})`);
  if (i.remainingUnclearFlags.length > 0)
    parts.push(
      `${i.remainingUnclearFlags.join(", ")} still open (-${UNCLEAR_FLAG_PENALTY * i.remainingUnclearFlags.length})`,
    );
  if (i.scamScore !== null && i.scamScore > 0) parts.push(`scam score ${i.scamScore}`);
  return parts.join(" — ");
}
