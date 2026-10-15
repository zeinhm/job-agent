import type { MiddlewareHandler } from "hono";

export const LOOPBACK = "127.0.0.1";

// Resolves lazily so the self-check and tests can bind port 0 and learn the port after listen().
export type PortSource = number | (() => number);

export function currentPort(port: PortSource): number {
  return typeof port === "function" ? port() : port;
}

function ownHosts(port: PortSource): string[] {
  const p = currentPort(port);
  return [`${LOOPBACK}:${p}`, `localhost:${p}`];
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
};

// DNS rebinding: a browser tab on evil.example that resolves to 127.0.0.1 still sends Host: evil.example.
export function hostGuard(port: PortSource): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host");
    if (host === undefined || !ownHosts(port).includes(host.toLowerCase())) {
      return c.json({ error: "bad host" }, 421);
    }
    await next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return /^application\/json\s*(;|$)/i.test(contentType.trim());
}

// CSRF: every method other than GET/HEAD needs a JSON content type (so a plain HTML form cannot send it)
// and a same-origin signal. No CORS headers are ever sent, so browsers refuse cross-origin reads too.
export function mutationGuard(port: PortSource): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (!isJson(c.req.header("content-type"))) return c.json({ error: "json required" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const own = ownHosts(port).map((h) => `http://${h}`);
      if (!own.includes(origin.toLowerCase())) return c.json({ error: "bad origin" }, 403);
    } else if (c.req.header("sec-fetch-site") !== "same-origin") {
      return c.json({ error: "bad origin" }, 403);
    }
    await next();
  };
}
