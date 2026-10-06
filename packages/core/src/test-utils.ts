import { setupServer } from "msw/node";
import { HttpHandler, http, HttpResponse } from "msw";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FixtureSource {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  fixture: string; // path to fixture file, relative to fixtures dir
}

/**
 * Create a fixture server for tests. Registers handlers from fixture files.
 * Unhandled requests fail the test.
 */
export function createFixtureServer(fixtures: FixtureSource[]): ReturnType<typeof setupServer> {
  const handlers: HttpHandler[] = [];

  for (const { url, method = "GET", fixture } of fixtures) {
    const fixtureDir = resolve(__dirname, "../test/fixtures");
    const fixtureFile = resolve(fixtureDir, fixture);

    if (!existsSync(fixtureFile)) {
      throw new Error(`Fixture file not found: ${fixtureFile}`);
    }

    const content = readFileSync(fixtureFile, "utf-8");

    // Determine response type based on fixture content
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(content);
    } catch {
      responseBody = content;
    }

    const requestMethod = method.toLowerCase() as "get" | "post" | "put" | "delete";
    handlers.push(
      http[requestMethod](url, () => {
        if (typeof responseBody === "string") {
          return HttpResponse.text(responseBody);
        }
        return HttpResponse.json(responseBody as Record<string, unknown>);
      }),
    );
  }

  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: "error" });

  return server;
}

export { setupServer, http, HttpResponse };
