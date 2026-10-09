import { log } from "./log.ts";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Get repository URL from root package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "../../..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { repository?: string };
const repoUrl = packageJson.repository ?? "https://github.com/example/job-agent";

const USER_AGENT = `job-agent/0.1 (+${repoUrl})`;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MIN_INTERVAL_MS = 2000;
const MIN_ALLOWED_INTERVAL_MS = 1000;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 60;

// Injectable time functions for testing
type TimeFn = () => Date;
type SleepFn = (ms: number) => Promise<void>;

let currentTime: TimeFn = () => new Date();
let currentSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export function setTimeAndSleep(time: TimeFn, sleep: SleepFn): void {
  currentTime = time;
  currentSleep = sleep;
}

export class HttpError extends Error {
  constructor(
    public url: string,
    public status: number | null,
    public originalUrl?: string,
  ) {
    super(`HTTP ${status ?? "network error"}: ${redactUrl(url)}`);
    this.name = "HttpError";
  }
}

/** Redact sensitive query parameters from a URL */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const sensitive = ["token", "key", "api_key", "access_token"];
    // Iterate through searchParams and check keys case-insensitively
    const sensitiveSet = new Set(sensitive.map((s) => s.toLowerCase()));
    for (const [key] of parsed.searchParams.entries()) {
      if (sensitiveSet.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "REDACTED");
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Extract the hostname from a URL */
function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/** Extract Retry-After header value (seconds, max 60 s) */
function parseRetryAfter(headers: Headers): number | null {
  const retryAfter = headers.get("Retry-After");
  if (!retryAfter) return null;

  // Try parsing as seconds
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000;
  }

  // Try parsing as HTTP date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - currentTime().getTime();
    return Math.min(Math.max(0, delayMs), MAX_RETRY_AFTER_SECONDS * 1000);
  }

  return null;
}

interface RateLimitState {
  lastRequestTime: number;
  queue: Array<{
    fn: () => Promise<unknown>;
    minIntervalMs: number;
    resolve: (result: unknown) => void;
    reject: (error: unknown) => void;
  }>;
  processing: boolean;
}

/** Per-host rate limiting and queueing */
const rateLimitByHost = new Map<string, RateLimitState>();

/** Process queued requests for a host, respecting the min interval */
async function processQueue(hostname: string): Promise<void> {
  const state = rateLimitByHost.get(hostname);
  if (!state) return;

  state.processing = true;
  try {
    while (state.queue.length > 0) {
      const item = state.queue.shift();
      if (!item) break;
      const now = currentTime().getTime();
      const timeUntilNextRequest = state.lastRequestTime + item.minIntervalMs - now;

      if (timeUntilNextRequest > 0) {
        await currentSleep(timeUntilNextRequest);
      }

      state.lastRequestTime = currentTime().getTime();
      try {
        const result = await item.fn();
        item.resolve(result);
      } catch (e) {
        item.reject(e);
      }
    }
  } finally {
    state.processing = false;
  }
}

/** Queue a request for a host, respecting rate limits */
async function withRateLimit<T>(
  url: string,
  minIntervalMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hostname = getHostname(url);

  if (!rateLimitByHost.has(hostname)) {
    rateLimitByHost.set(hostname, {
      lastRequestTime: -Infinity, // Start at negative infinity so first request is immediate
      queue: [],
      processing: false,
    });
  }

  const state = rateLimitByHost.get(hostname);
  if (!state) {
    throw new Error(`Rate limit state not found for ${hostname}`);
  }

  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      fn,
      minIntervalMs,
      resolve: resolve as (result: unknown) => void,
      reject,
    });

    if (!state.processing) {
      processQueue(hostname).catch((e) => {
        log.error("Rate limit processing error", { url, error: String(e) });
      });
    }
  });
}

interface HttpGetOptions {
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Extra request headers (e.g. an API key). Never put them in the URL. */
  headers?: Record<string, string>;
  /**
   * When set, redirects are followed manually and a hop is only requested if this returns true.
   * A refused hop is never fetched and makes the call throw HttpError.
   */
  allowRedirectTo?: (url: string) => boolean;
  /** false: redirects are not followed; the 3xx response is returned (and httpGet throws HttpError with its status). */
  followRedirects?: boolean;
}

const MAX_REDIRECTS = 5;

async function fetchGuarded(
  url: string,
  init: RequestInit,
  allow: (url: string) => boolean,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) {
      if (current !== url) Object.defineProperty(res, "url", { value: current });
      return res;
    }
    const next = new URL(location, current).toString();
    if (!allow(next)) throw new HttpError(url, null, url);
    current = next;
  }
  throw new HttpError(url, null, url);
}

/** Perform an HTTP GET request with retries, rate limiting, and redaction */
async function httpGetInternal(url: string, options: HttpGetOptions = {}): Promise<Response> {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (minIntervalMs < MIN_ALLOWED_INTERVAL_MS) {
    throw new Error(
      `minIntervalMs must be at least ${MIN_ALLOWED_INTERVAL_MS} ms, got ${minIntervalMs}`,
    );
  }

  return withRateLimit(url, minIntervalMs, async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let response: Response;
        try {
          const init: RequestInit = {
            headers: { "User-Agent": USER_AGENT, ...options.headers },
            signal: controller.signal,
          };
          response = options.allowRedirectTo
            ? await fetchGuarded(url, init, options.allowRedirectTo)
            : await fetch(
                url,
                options.followRedirects === false ? { ...init, redirect: "manual" } : init,
              );
        } finally {
          clearTimeout(timeoutId);
        }

        const redacted = redactUrl(url);

        // Retry on 429, 5xx, or network errors
        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers);
          if (attempt < MAX_RETRIES) {
            const waitMs = retryAfter ?? 2 ** attempt * 1000;
            log.warn("HTTP 429, retrying", {
              url: redacted,
              attempt: attempt + 1,
              waitMs,
            });
            await currentSleep(waitMs);
            continue;
          }
        }

        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const waitMs = 2 ** attempt * 1000;
          log.warn("HTTP 5xx, retrying", {
            url: redacted,
            status: response.status,
            attempt: attempt + 1,
            waitMs,
          });
          await currentSleep(waitMs);
          continue;
        }

        return response;
      } catch (e) {
        const redacted = redactUrl(url);
        // Network errors are retriable
        if (attempt < MAX_RETRIES && !(e instanceof Error && e.name === "AbortError")) {
          const waitMs = 2 ** attempt * 1000;
          log.warn("Network error, retrying", {
            url: redacted,
            error: String(e),
            attempt: attempt + 1,
            waitMs,
          });
          await currentSleep(waitMs);
          continue;
        }

        // Final network error (including timeout)
        throw new HttpError(url, null, url);
      }
    }

    // Should not reach here
    throw new HttpError(url, null, url);
  });
}

export async function httpGet(url: string, options?: HttpGetOptions): Promise<Response> {
  const response = await httpGetInternal(url, options);

  if (!response.ok) {
    throw new HttpError(url, response.status, url);
  }

  return response;
}

export async function httpGetJson<T = unknown>(url: string, options?: HttpGetOptions): Promise<T> {
  const response = await httpGet(url, options);
  return (await response.json()) as T;
}

export async function httpGetText(url: string, options?: HttpGetOptions): Promise<string> {
  const response = await httpGet(url, options);
  return response.text();
}

export { setTimeAndSleep as __testInjectTimeAndSleep };
