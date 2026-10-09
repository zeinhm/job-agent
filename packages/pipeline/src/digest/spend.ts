import { eq } from "drizzle-orm";
import { llm_calls, type Db } from "@job-agent/core";

/** "LLM spend" section: the day's cost against the cap, and calls per model. */
export function spendSection(db: Db, day: string, capUsd: number): string[] {
  const rows = db.select().from(llm_calls).where(eq(llm_calls.day, day)).all();
  const total = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  const lines = ["## LLM spend", "", `- ${day}: $${total.toFixed(4)} of $${capUsd.toFixed(2)} cap`];
  const models = [...new Set(rows.map((r) => r.model))].sort();
  if (models.length === 0) lines.push("- No LLM calls.");
  for (const m of models) {
    const mine = rows.filter((r) => r.model === m);
    const errors = mine.filter((r) => r.status === "error").length;
    const cost = mine.reduce((s, r) => s + Number(r.cost_usd), 0);
    lines.push(
      `- ${m}: ${mine.length} call${mine.length === 1 ? "" : "s"}, $${cost.toFixed(4)}` +
        (errors > 0 ? ` (${errors} failed)` : ""),
    );
  }
  return [...lines, ""];
}
