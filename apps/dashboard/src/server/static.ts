import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { NotFoundHandler } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// Shown until the web card's build exists in dist/web. No inline script or style: the CSP forbids both.
export const PLACEHOLDER_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>job-agent dashboard</title></head>' +
  "<body><h1>job-agent dashboard</h1><p>The web app is not built yet.</p></body></html>";

async function readFileIfExists(path: string): Promise<Buffer | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

// Static files from webDir with an SPA fallback to index.html. Never serves /api paths or anything outside webDir.
export function staticHandler(webDir: string): NotFoundHandler {
  const root = resolve(webDir);
  return async (c) => {
    const path = c.req.path;
    if (
      (c.req.method !== "GET" && c.req.method !== "HEAD") ||
      path === "/api" ||
      path.startsWith("/api/")
    ) {
      return c.json({ error: "not found" }, 404);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    const file = resolve(join(root, decoded));
    if (decoded.includes("\0") || (file !== root && !file.startsWith(root + sep))) {
      return c.json({ error: "not found" }, 404);
    }
    const hit = extname(decoded) === "" ? undefined : await readFileIfExists(file);
    if (hit !== undefined) {
      return c.body(new Uint8Array(hit), 200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      });
    }
    // A path with an extension that does not exist is a missing asset, not an SPA route.
    if (extname(decoded) !== "") return c.json({ error: "not found" }, 404);
    const index = await readFileIfExists(join(root, "index.html"));
    return c.body(index === undefined ? PLACEHOLDER_HTML : new Uint8Array(index), 200, {
      "Content-Type": TYPES[".html"] as string,
    });
  };
}
