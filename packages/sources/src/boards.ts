import { PartialSourceError, SourceError, type RawPosting } from "@job-agent/core";

export interface BoardResult {
  postings: RawPosting[];
  /** Human-readable, e.g. "1 board not found: acme". Empty when every board was fetched. */
  warnings: string[];
}

/**
 * Fetches every board, never stopping at the first failure.
 * `fetchOne` returns null for an unknown slug (404) and throws SourceError for any other failure.
 * - some boards unknown, rest fine: returns the successes plus a warning naming the slugs
 * - every board unknown: throws SourceError
 * - any other failure: throws PartialSourceError carrying the successes, after all boards were tried
 */
export async function fetchAllBoards<T extends { slug: string }>(
  source: string,
  boards: readonly T[],
  fetchOne: (board: T) => Promise<RawPosting[] | null>,
): Promise<BoardResult> {
  const postings: RawPosting[] = [];
  const notFound: string[] = [];
  const failures: SourceError[] = [];
  for (const board of boards) {
    try {
      const found = await fetchOne(board);
      if (found === null) notFound.push(board.slug);
      else postings.push(...found);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      failures.push(err);
    }
  }

  const notFoundText =
    notFound.length > 0
      ? `${notFound.length} board${notFound.length === 1 ? "" : "s"} not found: ${notFound.join(", ")}`
      : "";

  if (failures.length > 0) {
    const parts = [
      `${failures.length} of ${boards.length} boards failed: ${failures.map((f) => f.message).join("; ")}`,
      ...(notFoundText ? [notFoundText] : []),
    ];
    throw new PartialSourceError(source, parts.join("; "), postings, { cause: failures[0] });
  }
  if (boards.length > 0 && notFound.length === boards.length) {
    throw new SourceError(source, `all ${boards.length} boards not found: ${notFound.join(", ")}`);
  }
  return { postings, warnings: notFoundText ? [notFoundText] : [] };
}
