export { main, type Io } from "./cli.ts";
export { dedupePending, dedupeHash, normalizeTitle } from "./dedupe/index.ts";
export {
  parseSalary,
  toIdrMonth,
  type IdrMonth,
  type ParsedSalary,
  type SalaryPeriod,
  type SalaryRange,
} from "./salary/index.ts";
