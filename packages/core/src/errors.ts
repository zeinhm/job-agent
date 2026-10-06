export class SourceError extends Error {
  readonly source: string;

  constructor(source: string, message: string, options?: { cause?: unknown }) {
    super(`[${source}] ${message}`, options);
    this.name = "SourceError";
    this.source = source;
  }
}
