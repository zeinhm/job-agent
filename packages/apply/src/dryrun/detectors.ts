import type { DRY_RUN_STOP_REASONS } from "@job-agent/core";
import type { Page } from "playwright";

export interface StopSignal {
  reason: (typeof DRY_RUN_STOP_REASONS)[number];
  /** Short fixed wording, never page text. */
  detail: string;
}

/**
 * CAPTCHA script / iframe signatures (R1 and R2): reCAPTCHA (incl. Enterprise, recaptcha.net), hCaptcha and
 * Cloudflare Turnstile. Matched on every script / iframe source and every request URL the page made.
 */
const CAPTCHA_URL =
  /(?:^|[/.])(?:google\.com|recaptcha\.net)\/recaptcha\b|gstatic\.com\/recaptcha\b|(?:^|[/.])hcaptcha\.com\b|challenges\.cloudflare\.com\b/i;

/** Widget containers, for pages whose script is inlined or served from elsewhere. */
const CAPTCHA_SELECTOR =
  ".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*='recaptcha' i], iframe[src*='hcaptcha' i]";

const LOGIN_PATH =
  /(?:^|[/\-_.])(?:sign[-_]?in|log[-_]?in|sso|oauth2?|authorize|auth)(?:$|[/\-_.?])/i;

export interface DetectInput {
  page: Page;
  requestedUrl: string;
  /** HTTP status of the main document, or null when the navigation produced no response. */
  mainStatus: number | null;
  /** Every URL the page requested while loading. */
  seenUrls: readonly string[];
}

interface DomFacts {
  sources: string[];
  widget: boolean;
  password: boolean;
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Page error, then CAPTCHA, then login wall, then a redirect away. The first hit wins. */
export async function detectStop(input: DetectInput): Promise<StopSignal | null> {
  const { page, requestedUrl, mainStatus, seenUrls } = input;
  if (mainStatus === null) return { reason: "page_error", detail: "no response" };
  if (mainStatus >= 400) return { reason: "page_error", detail: `http ${mainStatus}` };

  // A string expression: this package compiles without the DOM lib.
  const dom = await page.evaluate<DomFacts>(`(() => ({
    sources: [...document.querySelectorAll("script[src], iframe[src]")].map((el) => el.src),
    widget: document.querySelector(${JSON.stringify(CAPTCHA_SELECTOR)}) !== null,
    password: document.querySelector("input[type='password' i]") !== null,
  }))()`);
  const frames = page.frames().map((f) => f.url());
  const urls = [...dom.sources, ...frames, ...seenUrls];
  if (dom.widget || urls.some((u) => CAPTCHA_URL.test(u.replace(/^[a-z]+:\/\//i, "")))) {
    return { reason: "captcha", detail: "captcha script or widget on the page" };
  }

  if (dom.password) return { reason: "login_wall", detail: "password field on the page" };
  const final = safeUrl(page.url());
  const requested = safeUrl(requestedUrl);
  if (final && requested) {
    if (LOGIN_PATH.test(final.pathname) && !LOGIN_PATH.test(requested.pathname)) {
      return { reason: "login_wall", detail: "sign-in redirect" };
    }
    if (final.host !== requested.host) {
      return { reason: "other", detail: "redirected to another host" };
    }
  }
  return null;
}
