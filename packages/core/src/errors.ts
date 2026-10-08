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
