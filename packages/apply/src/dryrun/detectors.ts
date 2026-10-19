import type { DRY_RUN_STOP_REASONS } from "@job-agent/core";
import type { ElementHandle, Page } from "playwright";

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

/** Widget containers, for pages whose script is inlined or served from elsewhere (strict mode: any hit stops). */
const CAPTCHA_SELECTOR =
  ".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*='recaptcha' i], iframe[src*='hcaptcha' i]";

/**
 * Dry-run mode: everything that can be (part of) a CAPTCHA, found through Playwright (it pierces open shadow roots).
 * Each element is classified by `classifyElement` and its visibility decided with Playwright.
 */
const CAPTCHA_ELEMENTS = [
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
  ".grecaptcha-badge",
  "[data-sitekey]",
  "iframe[src*='recaptcha' i]",
  "iframe[src*='hcaptcha' i]",
  "iframe[src*='challenges.cloudflare.com' i]",
  "iframe[title*='captcha' i]",
  "iframe[title*='turnstile' i]",
].join(", ");

/**
 * Which CAPTCHA rule applies (decisions.md 2026-10-17 "Dry-run CAPTCHA rule"):
 * - `dry-run`: a passive CAPTCHA (script, badge, invisible widget, hidden frame) does not stop; a visible challenge, or
 *   a visible widget that asks the user to act, stops, at load and again after every fill.
 * - `strict`: any CAPTCHA script, iframe or widget stops. A submit path (Phase 6) must pass this mode, never `dry-run`.
 * There is no default: every caller names its mode.
 */
export type CaptchaMode = "dry-run" | "strict";

/** Fixed labels for a CAPTCHA that was present but did not stop a dry run (never a value, never page text). */
export type PassiveCaptcha =
  "script" | "badge" | "invisible-widget" | "hidden-frame" | "unrendered-container";

export interface CaptchaCheck {
  stop: StopSignal | null;
  /** Dry-run mode only: the passive signals seen (strict mode stops on any signal). */
  passive: PassiveCaptcha[];
}

export const CAPTCHA_DETAILS = {
  strict: "captcha script or widget on the page",
  visible: "visible captcha challenge on the page",
  failSafe: "captcha container in an unknown state",
  midRun: "visible captcha challenge appeared during the run",
  midRunFailSafe: "captcha container in an unknown state during the run",
} as const;

/**
 * Dry-run signal list (what each rule is based on; vendor behaviour from their public docs, R1 = t_ec2ae4c6, R2 = t_d0698332).
 *
 * Passive, never stops:
 * - a CAPTCHA `<script>` or any request to a CAPTCHA host (R1, R2: Greenhouse loads an invisible reCAPTCHA Enterprise
 *   script, Ashby loads reCAPTCHA, Lever an hCaptcha script);
 * - `.grecaptcha-badge` and every frame inside it (reCAPTCHA docs: the badge is the invisible widget's logo);
 * - `data-size="invisible"` on a widget container (reCAPTCHA and hCaptcha docs), a `g-recaptcha` button / submit input
 *   (reCAPTCHA invisible auto-binding), Turnstile `data-appearance="execute"` or `"interaction-only"` (Turnstile docs: hidden
 *   until a challenge needs the user, and then it shows a visible frame, which stops);
 * - frames that are invisible by URL: reCAPTCHA `anchor` with `size=invisible`, hCaptcha `frame=checkbox-invisible`;
 * - any CAPTCHA frame that is not visible: display none, visibility hidden, opacity 0 on it or an ancestor, a box under
 *   5px, or a box entirely above / left of the page (reCAPTCHA parks its challenge frame at top:-10000px until needed);
 * - a container with no frame and no size (the vendor script is aborted by the guard, so it never renders).
 *
 * Stops as `captcha`:
 * - a visible CAPTCHA frame: reCAPTCHA `bframe` (image challenge) or `anchor` with `size=normal|compact` (checkbox),
 *   hCaptcha `frame=challenge` or `frame=checkbox`, any Turnstile frame (managed / interactive widget);
 * - fail safe: a visible CAPTCHA frame whose kind is not recognised, and a visible-size container (non-zero box, not
 *   invisible by markup) with no frame, since the page may draw the widget at any moment.
 *
 * "Visible" = Playwright `isVisible()` and `boundingBox()` (at least 5x5px, not entirely above / left of the page), and no
 * ancestor with opacity 0. Below or right of the viewport still counts as visible (fail safe). Nothing is clicked,
 * focused, hovered, scrolled to or called: only `isVisible`, `boundingBox` and a read-only `evaluate` run on the elements.
 */
type FrameKind = "invisible" | "checkbox" | "challenge" | "turnstile" | "unknown";

export interface CaptchaElementFacts {
  tag: string;
  src: string;
  className: string;
  size: string;
  appearance: string;
  inBadge: boolean;
  hasFrameChild: boolean;
  opacityHidden: boolean;
  scrollX: number;
  scrollY: number;
}

export function frameKindOf(src: string): FrameKind {
  const s = src.toLowerCase();
  if (/challenges\.cloudflare\.com/.test(s)) return "turnstile";
  if (/hcaptcha\.com/.test(s)) {
    if (/frame=checkbox-invisible/.test(s)) return "invisible";
    if (/frame=challenge/.test(s)) return "challenge";
    if (/frame=checkbox/.test(s)) return "checkbox";
    return "unknown";
  }
  if (/recaptcha/.test(s)) {
    if (/\/bframe\b/.test(s)) return "challenge";
    if (/\/anchor\b/.test(s)) return /[?&#]size=invisible\b/.test(s) ? "invisible" : "checkbox";
    return "unknown";
  }
  return "unknown";
}

export type ElementVerdict =
  | { kind: "passive"; label: PassiveCaptcha }
  | { kind: "stop"; failSafe: boolean }
  | { kind: "none" };

/** Pure rule: what one CAPTCHA element means for a dry run, given whether Playwright found it visible. */
export function classifyElement(f: CaptchaElementFacts, visible: boolean): ElementVerdict {
  const cls = ` ${f.className.toLowerCase()} `;
  if (f.tag === "script") return { kind: "passive", label: "script" };
  if (cls.includes(" grecaptcha-badge ")) return { kind: "passive", label: "badge" };
  if (f.tag === "iframe") {
    if (!visible) return { kind: "passive", label: "hidden-frame" };
    if (f.inBadge) return { kind: "passive", label: "badge" };
    const kind = frameKindOf(f.src);
    if (kind === "invisible") return { kind: "passive", label: "invisible-widget" };
    return { kind: "stop", failSafe: kind === "unknown" };
  }
  // A container (div, button, ...).
  const size = f.size.toLowerCase();
  const appearance = f.appearance.toLowerCase();
  if (
    size === "invisible" ||
    appearance === "execute" ||
    appearance === "interaction-only" ||
    f.tag === "button" ||
    f.tag === "input"
  )
    return { kind: "passive", label: "invisible-widget" };
  if (f.hasFrameChild) return { kind: "none" }; // the frame inside decides
  if (!visible) return { kind: "passive", label: "unrendered-container" };
  return { kind: "stop", failSafe: true };
}

/** Read-only facts of one element, computed in the page. Never clicks, focuses, scrolls or calls anything of the CAPTCHA. */
interface PageElement {
  tagName: string;
  parentElement: PageElement | null;
  ownerDocument: {
    defaultView: {
      scrollX: number;
      scrollY: number;
      getComputedStyle(el: PageElement): { opacity: string };
    } | null;
  };
  getAttribute(name: string): string | null;
  closest(selector: string): unknown;
  querySelector(selector: string): unknown;
}
// Self-contained: it runs in the page (this package compiles without the DOM lib, hence the structural type).
function readElementFacts(el: PageElement): CaptchaElementFacts {
  const view = el.ownerDocument.defaultView;
  let opacityHidden = false;
  for (let n: PageElement | null = el; n !== null; n = n.parentElement) {
    if (view !== null && parseFloat(view.getComputedStyle(n).opacity) === 0) opacityHidden = true;
  }
  return {
    tag: el.tagName.toLowerCase(),
    src: el.getAttribute("src") ?? "",
    className: el.getAttribute("class") ?? "",
    size: el.getAttribute("data-size") ?? "",
    appearance: el.getAttribute("data-appearance") ?? "",
    inBadge: el.closest(".grecaptcha-badge") !== null,
    hasFrameChild: el.querySelector("iframe") !== null,
    opacityHidden,
    scrollX: view?.scrollX ?? 0,
    scrollY: view?.scrollY ?? 0,
  };
}

/** A box thinner than this is "zero size": an iframe with width=0 still measures 4px (its default border). */
const MIN_SIDE = 5;

async function isShown(el: ElementHandle, f: CaptchaElementFacts): Promise<boolean> {
  if (f.opacityHidden || !(await el.isVisible())) return false;
  const box = await el.boundingBox();
  if (box === null || box.width < MIN_SIDE || box.height < MIN_SIDE) return false;
  return box.x + f.scrollX + box.width > 0 && box.y + f.scrollY + box.height > 0;
}

interface DomFacts {
  sources: string[];
  widget: boolean;
}

/** The CAPTCHA part of the stop detectors, in the named mode. The strict branch is the original rule, unchanged. */
export async function detectCaptcha(
  page: Page,
  seenUrls: readonly string[],
  mode: CaptchaMode,
  phase: "load" | "run" = "load",
): Promise<CaptchaCheck> {
  const dom = await page.evaluate<DomFacts>(`(() => ({
    sources: [...document.querySelectorAll("script[src], iframe[src]")].map((el) => el.src),
    widget: document.querySelector(${JSON.stringify(CAPTCHA_SELECTOR)}) !== null,
  }))()`);
  const frames = page.frames().map((f) => f.url());
  const urls = [...dom.sources, ...frames, ...seenUrls];
  const anyUrl = urls.some((u) => CAPTCHA_URL.test(u.replace(/^[a-z]+:\/\//i, "")));
  if (mode === "strict") {
    return dom.widget || anyUrl
      ? { stop: { reason: "captcha", detail: CAPTCHA_DETAILS.strict }, passive: [] }
      : { stop: null, passive: [] };
  }

  const passive = new Set<PassiveCaptcha>();
  if (anyUrl) passive.add("script");
  const handles: { el: ElementHandle; srcOverride: string }[] = (
    await page.locator(CAPTCHA_ELEMENTS).elementHandles()
  ).map((el) => ({ el, srcOverride: "" }));
  const main = page.mainFrame();
  for (const f of page.frames()) {
    if (f === main || !CAPTCHA_URL.test(f.url().replace(/^[a-z]+:\/\//i, ""))) continue;
    const el = await f.frameElement().catch(() => null);
    if (el) handles.push({ el, srcOverride: f.url() });
  }
  let failSafe = false;
  let visibleChallenge = false;
  try {
    for (const { el, srcOverride } of handles) {
      const facts = await el.evaluate(
        readElementFacts as unknown as (node: unknown) => CaptchaElementFacts,
      );
      if (facts.src === "" && srcOverride !== "") facts.src = srcOverride;
      const verdict = classifyElement(facts, await isShown(el, facts));
      if (verdict.kind === "passive") passive.add(verdict.label);
      else if (verdict.kind === "stop") {
        if (verdict.failSafe) failSafe = true;
        else visibleChallenge = true;
      }
    }
  } finally {
    await Promise.all(handles.map(({ el }) => el.dispose().catch(() => undefined)));
  }
  const labels = [...passive];
  if (visibleChallenge || failSafe) {
    const detail = visibleChallenge
      ? phase === "load"
        ? CAPTCHA_DETAILS.visible
        : CAPTCHA_DETAILS.midRun
      : phase === "load"
        ? CAPTCHA_DETAILS.failSafe
        : CAPTCHA_DETAILS.midRunFailSafe;
    return { stop: { reason: "captcha", detail }, passive: labels };
  }
  return { stop: null, passive: labels };
}

const LOGIN_PATH =
  /(?:^|[/\-_.])(?:sign[-_]?in|log[-_]?in|sso|oauth2?|authorize|auth)(?:$|[/\-_.?])/i;

export interface DetectInput {
  page: Page;
  requestedUrl: string;
  /** HTTP status of the main document, or null when the navigation produced no response. */
  mainStatus: number | null;
  /** Why the navigation produced no response (see `describeNavFailure`); only read when `mainStatus` is null. */
  navCause?: string | undefined;
  /** Every URL the page requested while loading. */
  seenUrls: readonly string[];
  /** Required, no default: see `CaptchaMode`. */
  captchaMode: CaptchaMode;
}

export interface DetectResult {
  stop: StopSignal | null;
  passive: PassiveCaptcha[];
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * A short, value-free cause for a navigation that threw: a timeout, or Chromium's `net::ERR_*` code. The error text
 * itself carries the URL, so only these two shapes are kept.
 */
export function describeNavFailure(err: unknown): string {
  const text = err instanceof Error ? err.message : "";
  const net = /net::(ERR_[A-Z0-9_]+)/.exec(text);
  if (net) return `navigation failed (net::${net[1]})`;
  if (/timeout/i.test(text)) return "navigation timeout";
  return "navigation failed (other)";
}

/** Page error, then CAPTCHA, then login wall, then a redirect away. The first hit wins. */
export async function detectStop(input: DetectInput): Promise<DetectResult> {
  const { page, requestedUrl, mainStatus, seenUrls } = input;
  if (mainStatus === null)
    return {
      stop: {
        reason: "page_error",
        detail: `no response: ${input.navCause ?? "navigation returned no response"}`,
      },
      passive: [],
    };
  if (mainStatus >= 400)
    return { stop: { reason: "page_error", detail: `http ${mainStatus}` }, passive: [] };

  const captcha = await detectCaptcha(page, seenUrls, input.captchaMode);
  if (captcha.stop) return captcha;
  const passive = captcha.passive;

  const password = await page.evaluate<boolean>(
    `document.querySelector("input[type='password' i]") !== null`,
  );
  if (password)
    return { stop: { reason: "login_wall", detail: "password field on the page" }, passive };
  const final = safeUrl(page.url());
  const requested = safeUrl(requestedUrl);
  if (final && requested) {
    if (LOGIN_PATH.test(final.pathname) && !LOGIN_PATH.test(requested.pathname)) {
      return { stop: { reason: "login_wall", detail: "sign-in redirect" }, passive };
    }
    if (final.host !== requested.host) {
      return { stop: { reason: "other", detail: "redirected to another host" }, passive };
    }
  }
  return { stop: null, passive };
}
