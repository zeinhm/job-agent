/**
 * `analysis.analyzed_at` of an analysis whose posting was edited after it was digested.
 * `discover` writes it (the row is kept so `digested_at` survives); `process` re-analyses such rows.
 */
export const STALE_ANALYZED_AT = "1970-01-01T00:00:00.000Z";
