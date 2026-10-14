import { UNKNOWN_COMPANY } from "@job-agent/sources";
import { normalizeCompanyName } from "../normalize/index.ts";

const PLACEHOLDER_KEY = normalizeCompanyName(UNKNOWN_COMPANY);

/** A company name that stands for "no company" (empty, or the sources' `(unknown)`): never probed, fetched or researched. */
export function isPlaceholderCompany(name: string | null | undefined): boolean {
  const key = normalizeCompanyName(name ?? "");
  return key === "" || key === PLACEHOLDER_KEY;
}
