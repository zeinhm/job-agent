import type { BrowserContext } from "playwright";

/** Attempts the in-page guard reports. They never carry values. */
export const PAGE_ATTEMPT_KINDS = [
  "form_submit_call",
  "form_request_submit_call",
  "submit_event",
  "send_beacon",
  "websocket_construct",
] as const;
export type PageAttemptKind = (typeof PAGE_ATTEMPT_KINDS)[number];

/** Attempts that mean the page tried to send the application itself (they downgrade a "filled" run). */
export const SUBMIT_ATTEMPT_KINDS: ReadonlySet<PageAttemptKind> = new Set([
  "form_submit_call",
  "form_request_submit_call",
  "submit_event",
]);

export interface PageAttempt {
  kind: PageAttemptKind;
}

const BINDING = "__dryRunAttempt";

/**
 * Runs in every frame before any page script. `submit` / `requestSubmit` throw, a capture-phase `submit` listener
 * cancels and records the event (Enter in a field, a submit button), `sendBeacon` does not send and `WebSocket`
 * cannot be constructed. The request guard (request-guard.ts) is the second layer behind all of these.
 */
const INIT_SCRIPT = `(() => {
  const report = window.${BINDING};
  const note = (kind) => { try { report(kind); } catch (_) {} };
  const lock = (target, name, value) =>
    Object.defineProperty(target, name, { value, writable: false, configurable: false });
  lock(HTMLFormElement.prototype, "submit", function submit() {
    note("form_submit_call");
    throw new Error("dry run: form.submit() is blocked");
  });
  lock(HTMLFormElement.prototype, "requestSubmit", function requestSubmit() {
    note("form_request_submit_call");
    throw new Error("dry run: form.requestSubmit() is blocked");
  });
  window.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    note("submit_event");
  }, true);
  lock(Navigator.prototype, "sendBeacon", function sendBeacon() {
    note("send_beacon");
    return false;
  });
  lock(window, "WebSocket", function WebSocket() {
    note("websocket_construct");
    throw new Error("dry run: WebSocket is blocked");
  });
})();`;

/** Installs the in-page guard on a context. Call it before the context opens its first page. */
export async function installPageGuard(
  context: BrowserContext,
  onAttempt: (attempt: PageAttempt) => void,
): Promise<void> {
  await context.exposeFunction(BINDING, (kind: unknown) => {
    if (PAGE_ATTEMPT_KINDS.includes(kind as PageAttemptKind))
      onAttempt({ kind: kind as PageAttemptKind });
  });
  await context.addInitScript(INIT_SCRIPT);
}
