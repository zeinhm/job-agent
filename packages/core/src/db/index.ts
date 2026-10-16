import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";
import type {
  Analysis,
  ApplyLink,
  NewApplyLink,
  Company,
  FxRate,
  Intel,
  LlmCall,
  NewAnalysis,
  NewCompany,
  NewFxRate,
  NewIntel,
  NewLlmCall,
  NewPosting,
  NewSourceRun,
  Posting,
  SourceRun,
  AnswerBankRow,
  ChoiceMapping,
  DryRun,
  DryRunField,
  NewAnswerBankRow,
  NewChoiceMapping,
  NewDryRun,
  NewDryRunField,
  NewPostingQuestion,
  NewReview,
  NewUnknownQuestion,
  PostingQuestion,
  Review,
  UnknownQuestion,
} from "./schema.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function defaultDbPath(): string {
  return process.env["JOB_AGENT_DB"] ?? "data/job-agent.db";
}

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  if (path !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export type Db = ReturnType<typeof openDb>;

// Re-export inferred row types from schema
export type {
  Analysis,
  ApplyLink,
  NewApplyLink,
  Company,
  FxRate,
  Intel,
  LlmCall,
  NewAnalysis,
  NewCompany,
  NewFxRate,
  NewIntel,
  NewLlmCall,
  NewPosting,
  NewSourceRun,
  Posting,
  SourceRun,
  AnswerBankRow,
  ChoiceMapping,
  DryRun,
  DryRunField,
  NewAnswerBankRow,
  NewChoiceMapping,
  NewDryRun,
  NewDryRunField,
  NewPostingQuestion,
  NewReview,
  NewUnknownQuestion,
  PostingQuestion,
  Review,
  UnknownQuestion,
};
