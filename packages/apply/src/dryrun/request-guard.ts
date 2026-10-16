import type { BrowserContext } from "playwright";

/** The one host fixture mode talks to. Every other host is aborted in fixture mode. */
export const FIXTURE_HOST = "127.0.0.1";

export type GuardAts = "greenhouse" | "lever" | "ashby";

/**
 * Ashby read-only GraphQL operations (docs/research/t_d0698332-ats-form-structure.md, section 3, Ashby table and
 * samples/ashby-graphql-operations.json "query"). Only the five operations the research confirmed on the wire; the
 * consent / legal-text queries are "possible, not confirmed" there and stay off the list. Every `mutation` (including
 * the benign `ApiSetFormValue`) and every `ApiSubmit*` is aborted: a dry run must not persist anything server side.
 */
export const ASHBY_READ_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  "ApiOrganizationFromHostedJobsPageName",
  "ApiJobPosting",
  "ApiJobPostingForApplicationRequest",
  "ApiAutocompleteGeoLocation",
  "ApiSearchSchoolByCanonicalName",
]);

/** Where the Ashby GraphQL endpoint lives (R2: `POST /api/non-user-graphql?op=<operationName>`). */
const ASHBY_GRAPHQL_HOST = "jobs.ashbyhq.com";
const ASHBY_GRAPHQL_PATH = "/api/non-user-graphql";

export type AbortReason = "method" | "host" | "websocket";

/** What the guard keeps about a blocked attempt. Never the body, never the query string. */
export interface AbortedRequest {
  kind: "request" | "websocket";
  method: string;
  host: string;
  path: string;
  reason: AbortReason;
}

export interface RequestFacts {
  method: string;
  url: string;
  /** Request body as text, or null when there is none / it is binary. */
  body: string | null;
}

export interface GuardPolicy {
  ats: GuardAts;
  /** Fixture mode: every host other than 127.0.0.1 is aborted, whatever the method. */
  fixture: boolean;
}

export type Verdict = { allow: true } | { allow: false; reason: AbortReason };

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True when `body` is a GraphQL request (or batch) made only of allowlisted read-only queries for this `op`. */
function isReadOnlyAshbyBody(body: string | null, op: string): boolean {
  if (body === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return false;
  return items.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { operationName, query } = item as Record<string, unknown>;
    return (
      typeof operationName === "string" &&
      operationName === op &&
      ASHBY_READ_ONLY_OPERATIONS.has(operationName) &&
      typeof query === "string" &&
      !/mutation/i.test(query) &&
      !/submit/i.test(query)
    );
  });
}

function isAllowlisted(url: URL, facts: RequestFacts, policy: GuardPolicy): boolean {
  if (policy.ats !== "ashby") return false;
  const hostOk = policy.fixture
    ? url.hostname === FIXTURE_HOST
    : url.hostname === ASHBY_GRAPHQL_HOST;
  if (!hostOk || url.pathname !== ASHBY_GRAPHQL_PATH) return false;
  const op = url.searchParams.get("op");
  if (op === null || !ASHBY_READ_ONLY_OPERATIONS.has(op)) return false;
  return isReadOnlyAshbyBody(facts.body, op);
}

/** Pure decision for one request. Unknown or unparseable input is aborted. */
export function classifyRequest(facts: RequestFacts, policy: GuardPolicy): Verdict {
  const url = parseUrl(facts.url);
  if (url === null) return { allow: false, reason: "method" };
  const isLocal = url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:";
  if (policy.fixture && !isLocal && url.hostname !== FIXTURE_HOST) {
    return { allow: false, reason: "host" };
  }
  const method = facts.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return { allow: true };
  if (isAllowlisted(url, facts, policy)) return { allow: true };
  return { allow: false, reason: "method" };
}

export function describeRequest(
  kind: AbortedRequest["kind"],
  method: string,
  url: string,
  reason: AbortReason,
): AbortedRequest {
  const parsed = parseUrl(url);
  return {
    kind,
    method: method.toUpperCase(),
    host: parsed?.host ?? "",
    path: parsed?.pathname ?? "",
    reason,
  };
}

/**
 * Installs the request guard on a context. Call it before the context opens its first page.
 * Aborts every non-GET/HEAD request that is not on the per-ATS allowlist, and every WebSocket
 * (closed before it connects: the handler never calls `connectToServer`).
 */
export async function installRequestGuard(
  context: BrowserContext,
  policy: GuardPolicy,
  onAbort: (aborted: AbortedRequest) => void,
): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const verdict = classifyRequest(
      { method: request.method(), url: request.url(), body: request.postData() },
      policy,
    );
    if (verdict.allow) {
      await route.continue();
      return;
    }
    onAbort(describeRequest("request", request.method(), request.url(), verdict.reason));
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, async (ws) => {
    onAbort(describeRequest("websocket", "GET", ws.url(), "websocket"));
    await ws.close();
  });
}
