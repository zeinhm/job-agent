import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";
import type {
  Analysis,
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
} from "./schema.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function defaultDbPath(): string {
  return process.env["JOB_AGENT_DB"] ?? "data/job-agent.db";
}

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export type Db = ReturnType<typeof openDb>;

// Re-export inferred row types from schema
export type {
  Analysis,
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
};
