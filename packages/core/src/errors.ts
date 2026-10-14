import type { RawPosting } from "./types.ts";

export class SourceError extends Error {
  readonly source: string;

  constructor(source: string, message: string, options?: { cause?: unknown }) {
    super(`[${source}] ${message}`, options);
    this.name = "SourceError";
    this.source = source;
  }
}

/** A source where some boards failed: carries the postings fetched from the boards that worked. */
export class PartialSourceError extends SourceError {
  readonly postings: RawPosting[];

  constructor(
    source: string,
    message: string,
    postings: RawPosting[],
    options?: { cause?: unknown },
  ) {
    super(source, message, options);
    this.name = "PartialSourceError";
    this.postings = postings;
  }
}

/**
 * A Tier 2 source refused us (HTTP 429 / 999, authwall / CAPTCHA page, scraper block exception).
 * `discover` records the run as `error` and skips the source for BLOCK_BACKOFF_HOURS. Never retried.
 * Carries whatever was fetched before the block.
 */
export class SourceBlockedError extends PartialSourceError {
  readonly kind = "blocked" as const;

  constructor(
    source: string,
    message: string,
    postings: RawPosting[] = [],
    options?: { cause?: unknown },
  ) {
    super(source, message, postings, options);
    this.name = "SourceBlockedError";
  }
}

/** The source cannot run on this machine (for example its worker is not installed): a `skipped` run, not an error. */
export class SourceSkippedError extends SourceError {
  readonly reason: string;

  constructor(source: string, reason: string) {
    super(source, reason);
    this.name = "SourceSkippedError";
    this.reason = reason;
  }
}
