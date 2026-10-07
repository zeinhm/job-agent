// Records one live web3.career response as a test fixture.
// Usage: WEB3_CAREER_TOKEN=... pnpm --filter @job-agent/sources record:web3career
// Makes ONE request, trims to 20 jobs, strips the token and replaces emails/phones.
import { httpGetJson } from "@job-agent/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildRequestUrl } from "../src/web3career/index.ts";

const MAX_JOBS = 20;
const OUT = new URL("../test/fixtures/web3career/recorded.json", import.meta.url);

const token = process.env.WEB3_CAREER_TOKEN;
if (!token) {
  process.stderr.write("WEB3_CAREER_TOKEN not set\n");
  process.exit(1);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;

function scrub(text: string): string {
  return text
    .split(token as string)
    .join("REDACTED")
    .split(encodeURIComponent(token as string))
    .join("REDACTED")
    .replace(EMAIL, "jobs@example.com")
    .replace(PHONE, "+10000000000");
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)]));
  }
  return value;
}

const body = await httpGetJson(buildRequestUrl(token));
if (!Array.isArray(body)) throw new Error("unexpected response: root is not an array");

// Keep the mixed root shape, trimming only the nested jobs array.
const trimmed = body.map((entry) => (Array.isArray(entry) ? entry.slice(0, MAX_JOBS) : entry));
const output = scrubValue(trimmed);

mkdirSync(new URL("./", OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`wrote ${OUT.pathname}\n`);
