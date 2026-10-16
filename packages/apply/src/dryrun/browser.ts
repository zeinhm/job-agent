import { chromium, type Browser, type BrowserContext } from "playwright";
import { installPageGuard, type PageAttempt } from "./page-guard.ts";
import { installRequestGuard, type AbortedRequest, type GuardPolicy } from "./request-guard.ts";

/** The one command that installs the browser binary (root package.json script, documented in docs/running.md). */
export const BROWSER_INSTALL_COMMAND = "pnpm playwright:install";

export class BrowserMissingError extends Error {
  constructor() {
    super(`Chromium for Playwright is not installed. Run: ${BROWSER_INSTALL_COMMAND}`);
    this.name = "BrowserMissingError";
  }
}

/** Launches Chromium. A missing binary fails with the install command in the message (never a skip). */
export async function launchChromium(options: { headless: boolean }): Promise<Browser> {
  try {
    return await chromium.launch({ headless: options.headless });
  } catch (err) {
    if (err instanceof Error && /Executable doesn't exist|playwright install/i.test(err.message)) {
      throw new BrowserMissingError();
    }
    throw err;
  }
}

export interface GuardSinks {
  onAbort: (aborted: AbortedRequest) => void;
  onAttempt: (attempt: PageAttempt) => void;
}

/**
 * The only way the harness makes a browser context: service workers blocked, downloads off, request guard and
 * in-page guard installed before the context can open a page. There is no option to skip any of it.
 */
export async function newGuardedContext(
  browser: Browser,
  policy: GuardPolicy,
  sinks: GuardSinks,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: false,
    viewport: { width: 1280, height: 900 },
  });
  await installRequestGuard(context, policy, sinks.onAbort);
  await installPageGuard(context, sinks.onAttempt);
  return context;
}
