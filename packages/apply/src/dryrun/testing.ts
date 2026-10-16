/**
 * Test-only support for the dry-run harness. Not exported from the package index.
 * `openPartiallyGuardedPage` is the "guard deliberately removed" factory: production code has no such path
 * (`newGuardedContext` always installs both layers), so only tests can build an unguarded context.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright";
import { installPageGuard, type PageAttempt } from "./page-guard.ts";
import { installRequestGuard, type AbortedRequest, type GuardPolicy } from "./request-guard.ts";
import { internals, type DryRunSession } from "./session.ts";

export function pageOf(session: DryRunSession): Page {
  const page = internals.pages.get(session);
  if (!page) throw new Error("unknown session");
  return page;
}

export function resetRunLimit(): void {
  internals.resetRunLimit();
}

export interface PartialGuards {
  /** Install the request guard with this policy, or leave the context without one. */
  requestGuard?: GuardPolicy;
  /** Install the in-page guard (init script). */
  pageGuard?: boolean;
}

export interface PartiallyGuarded {
  context: BrowserContext;
  page: Page;
  aborted: AbortedRequest[];
  attempts: PageAttempt[];
}

export async function openPartiallyGuardedPage(
  browser: Browser,
  guards: PartialGuards,
): Promise<PartiallyGuarded> {
  const aborted: AbortedRequest[] = [];
  const attempts: PageAttempt[] = [];
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  if (guards.requestGuard)
    await installRequestGuard(context, guards.requestGuard, (a) => aborted.push(a));
  if (guards.pageGuard) await installPageGuard(context, (a) => attempts.push(a));
  const page = await context.newPage();
  return { context, page, aborted, attempts };
}

/** Lets in-flight page requests finish. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
}

export interface SeenRequest {
  method: string;
  path: string;
}

export interface FixtureServer {
  origin: string;
  port: number;
  requests: SeenRequest[];
  upgrades: number;
  /** Everything the server saw that was not GET or HEAD. */
  nonGet: () => SeenRequest[];
  close: () => Promise<void>;
}

const FORM_PAGE = `<!doctype html><html><body>
<form id="f" method="POST" action="/apply">
  <label for="name">Full name</label><input id="name" name="name" type="text">
  <label for="pick">Pick</label><select id="pick" name="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <label for="agree">Agree</label><input id="agree" name="agree" type="checkbox">
  <label for="cv">Resume</label><input id="cv" name="cv" type="file">
  <label for="pw-none">Other</label><div role="button"><input id="in-role" type="text"></div>
  <button type="submit" id="go">Go</button>
  <input type="submit" id="go2" value="Go">
  <button type="button" id="btn-submit">Fake submit</button>
</form>
<script>
  const post = (path) => fetch(path, { method: "POST", body: "x" }).catch(() => {});
  const form = document.getElementById("f");
  post("/hit/load-fetch");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/hit/load-xhr");
  xhr.onerror = () => {};
  xhr.send("x");
  navigator.sendBeacon("/hit/load-beacon", "x");
  window.callSubmit = () => {
    try { form.submit(); } catch (e) {}
    try { form.requestSubmit(); } catch (e) {}
  };
  document.getElementById("name").addEventListener("change", () => {
    post("/hit/change-fetch");
    navigator.sendBeacon("/hit/change-beacon", "x");
  });
  form.addEventListener("submit", () => post("/hit/submit-fetch"));
</script></body></html>`;

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

const PAGES: Record<string, string> = {
  "/form": FORM_PAGE,
  "/captcha-google": page(
    `<form><input id="a" type="text"></form><script src="https://www.google.com/recaptcha/enterprise.js?render=x"></script>`,
  ),
  "/captcha-hcaptcha": page(
    `<form><input id="a" type="text"></form><script src="https://js.hcaptcha.com/1/secure-api.js"></script>`,
  ),
  "/captcha-turnstile": page(
    `<form><input id="a" type="text"></form><div class="cf-turnstile"></div>`,
  ),
  "/login": page(`<form><input id="u" type="text"><input id="p" type="password"></form>`),
  "/plain": page(`<form><input id="a" type="text"></form>`),
  "/ashby": page(`<form><input id="a" type="text"></form><script>
    const gql = (op, query) => fetch("/api/non-user-graphql?op=" + op, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: op, variables: {}, query }),
    }).catch(() => {});
    gql("ApiJobPosting", "query ApiJobPosting { jobPosting { id } }");
    gql("ApiSetFormValue", "mutation ApiSetFormValue { setFormValue { ok } }");
    gql("ApiSubmitSingleApplicationFormAction", "mutation ApiSubmitSingleApplicationFormAction { submit { ok } }");
    gql("ApiJobPosting", "mutation ApiJobPosting { sneaky { ok } }");
  </script>`),
  "/ws": page(
    `<script>try { new WebSocket("ws://" + location.host + "/socket"); } catch (e) {}</script>`,
  ),
  "/sw": page(`<script>navigator.serviceWorker.register("/sw.js")
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, 300)))
    .then(() => navigator.serviceWorker.getRegistrations())
    .then((regs) => { document.title = "registrations:" + regs.length; });</script>`),
  "/outside": page(
    `<script>fetch("http://localhost:" + location.port + "/outside-hit").catch(() => {});</script>`,
  ),
};

/** A local server on 127.0.0.1 that records every request it receives. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: SeenRequest[] = [];
  const state = { upgrades: 0 };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method ?? "", path: url.pathname });
    req.resume();
    if (url.pathname === "/sw.js") {
      res
        .writeHead(200, { "content-type": "text/javascript" })
        .end("self.addEventListener('fetch', () => {});");
    } else if (url.pathname === "/redirect-apply") {
      res.writeHead(302, { location: "/signin" }).end();
    } else if (url.pathname === "/signin") {
      res.writeHead(200, { "content-type": "text/html" }).end(page("<p>Sign in</p>"));
    } else if (url.pathname === "/missing") {
      res.writeHead(404, { "content-type": "text/html" }).end(page("<p>Not found</p>"));
    } else if (PAGES[url.pathname] !== undefined) {
      res.writeHead(200, { "content-type": "text/html" }).end(PAGES[url.pathname]);
    } else {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    }
  });
  server.on("upgrade", (_req, socket) => {
    state.upgrades += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    get upgrades() {
      return state.upgrades;
    },
    nonGet: () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD"),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
