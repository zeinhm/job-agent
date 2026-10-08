import { eq } from "drizzle-orm";
import { companies, type Db, type Posting } from "@job-agent/core";
import { ExtractionSchema, type Extraction } from "./extract.ts";
import type { DomainAgeLookup } from "./rdap.ts";
import { formatReason, pickContactDomain, scoreScam } from "./scam.ts";
import { verifyAgainstAts } from "./verify.ts";

export interface ScamStageOutput {
  scam_score: number;
  scam_reasons: string;
  /** Only set when suspicious: the stages after this one must not run. */
  suspicious: boolean;
}

/**
 * The enrich stage around `scoreScam`: loads the extraction, looks up the contact domain's age (RDAP, a failure
 * is "unknown") and ATS verification (DB rows only), scores, and returns the `intel` columns to store.
 */
export async function runScamStage(
  db: Db,
  posting: Posting,
  extractionJson: string | null | undefined,
  lookupDomainAge: DomainAgeLookup,
  now: Date,
): Promise<ScamStageOutput> {
  const extraction: Extraction | null = extractionJson
    ? ExtractionSchema.parse(JSON.parse(extractionJson))
    : null;
  const company = posting.company_id
    ? db.select().from(companies).where(eq(companies.id, posting.company_id)).get()
    : undefined;
  const companyDomain = company?.domain ?? null;

  const contactDomain = pickContactDomain({
    applyUrl: posting.apply_url,
    descriptionText: posting.description_text,
    companyDomain,
  });
  const domainAge = contactDomain
    ? { domain: contactDomain, days: await lookupDomainAge(contactDomain) }
    : null;

  const result = scoreScam({
    title: posting.title,
    companyName: posting.company_name,
    companyDomain,
    descriptionText: posting.description_text,
    applyUrl: posting.apply_url,
    extraction,
    domainAge,
    verification: verifyAgainstAts(db, posting, now),
  });
  return {
    scam_score: result.score,
    scam_reasons: JSON.stringify(result.reasons.map(formatReason)),
    suspicious: result.suspicious,
  };
}
