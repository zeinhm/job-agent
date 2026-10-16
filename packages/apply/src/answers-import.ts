import { randomUUID } from "node:crypto";
import { answer_bank, type Db } from "@job-agent/core";
import { eq } from "drizzle-orm";
import { clearMappingApprovals } from "./answers-store.ts";
import type { AnswerEntry } from "./answers.ts";
import { validateTypedAnswer } from "./typed-answer.ts";

export interface ImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  kept: number;
}

const json = (v: string[] | null): string | null => (v === null ? null : JSON.stringify(v));

/**
 * Upserts config entries into `answer_bank` as `source = config`. A row last edited in the dashboard is never
 * overwritten (its key goes to `out` as `kept dashboard version: <key>`). An unchanged entry is not touched, so a
 * re-run is a no-op. Entries missing from the file are left alone. Never writes answer text anywhere. Every entry
 * must fit its type (validateTypedAnswer) or the import throws before writing anything; the message names
 * `<key>.<field>` and the rule, never a value.
 */
export function importAnswers(
  db: Db,
  entries: AnswerEntry[],
  out: (line: string) => void,
  now: Date = new Date(),
): ImportSummary {
  for (const e of entries) {
    const r = validateTypedAnswer(e);
    if (!r.ok) throw new Error(`Answer ${e.key} is invalid: ${e.key}.${r.field}: ${r.rule}`);
  }
  const summary: ImportSummary = { added: 0, updated: 0, unchanged: 0, kept: 0 };
  const stamp = now.toISOString();
  db.transaction((tx) => {
    for (const e of entries) {
      const fields = {
        group: e.group,
        question: e.question,
        answer: e.answer,
        type: e.type,
        choices: json(e.choices),
        alternatives: json(e.alternatives),
        approved: e.approved,
      };
      const row = tx.select().from(answer_bank).where(eq(answer_bank.key, e.key)).get();
      if (row === undefined) {
        tx.insert(answer_bank)
          .values({
            id: randomUUID(),
            key: e.key,
            ...fields,
            approved_at: e.approved ? stamp : null,
            source: "config",
            updated_at: stamp,
          })
          .run();
        summary.added += 1;
      } else if (row.source === "dashboard") {
        out(`kept dashboard version: ${e.key}`);
        summary.kept += 1;
      } else if (
        (Object.keys(fields) as (keyof typeof fields)[]).every((k) => row[k] === fields[k])
      ) {
        summary.unchanged += 1;
      } else {
        // Same F3 rule as a dashboard edit: an answer that loses approval takes its mappings' approval with it.
        if (row.approved && !e.approved) clearMappingApprovals(tx, e.key, stamp);
        tx.update(answer_bank)
          .set({
            ...fields,
            approved_at: !e.approved ? null : row.approved ? row.approved_at : stamp,
            updated_at: stamp,
          })
          .where(eq(answer_bank.id, row.id))
          .run();
        summary.updated += 1;
      }
    }
  });
  out(
    `answers import: ${summary.added} added, ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.kept} kept`,
  );
  return summary;
}
