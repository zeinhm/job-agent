// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { ApiError, api } from "./api.ts";
import { ExternalLink } from "./components/ExternalLink.tsx";
import { isDay, jakartaDate } from "./day.ts";

const server = setupServer(
  http.get("http://localhost:3000/api/health", () => HttpResponse.json({ ok: true, db: "ok" })),
  http.get("http://localhost:3000/api/queue", () =>
    HttpResponse.json({
      date: "2026-10-16",
      sections: { top: [], needs_a_look: [], suspicious: [], waiting: [] },
    }),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function renderApp(now = () => new Date("2026-10-15T20:00:00Z")) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App now={now} />
    </QueryClientProvider>,
  );
}

describe("jakartaDate", () => {
  it("uses the Asia/Jakarta calendar day (UTC+7)", () => {
    expect(jakartaDate(new Date("2026-10-15T20:00:00Z"))).toBe("2026-10-16");
    expect(jakartaDate(new Date("2026-10-15T16:59:00Z"))).toBe("2026-10-15");
  });
  it("isDay rejects impossible dates", () => {
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("")).toBe(false);
  });
});

describe("App", () => {
  it("shows four tabs with empty states and switches between them", async () => {
    const user = userEvent.setup();
    renderApp();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Queue", "Answers", "Inbox", "Stats"]);
    expect(screen.getByRole("tab", { name: "Queue" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText(/No postings in the queue/)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Inbox" }));
    expect(screen.getByRole("tab", { name: "Inbox" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/No unknown questions/)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Stats" }));
    expect(screen.getByText(/No stats for this day/)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Answers" }));
    expect(screen.getByText(/No answers yet/)).toBeTruthy();
  });

  it("day picker starts on the Jakarta date, caps at today and changes the day", async () => {
    renderApp();
    const input = screen.getByLabelText<HTMLInputElement>("Day (Asia/Jakarta)");
    expect(input.value).toBe("2026-10-16");
    expect(input.max).toBe("2026-10-16");
    fireEvent.change(input, { target: { value: "2026-10-10" } });
    expect(input.value).toBe("2026-10-10");
    expect(await screen.findByText(/\(2026-10-10\)/)).toBeTruthy();
  });

  it("health indicator reports ok from /api/health", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Server: ok"));
  });

  it("health indicator reports down on a server error", async () => {
    server.use(
      http.get("http://localhost:3000/api/health", () => new HttpResponse(null, { status: 503 })),
    );
    renderApp();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Server: down"));
  });
});

describe("api client", () => {
  it("validates responses with the Zod schema", async () => {
    server.use(
      http.get("http://localhost:3000/api/health", () => HttpResponse.json({ ok: "yes" })),
    );
    await expect(api.health()).rejects.toThrow();
  });
  it("throws ApiError with the status and no body", async () => {
    server.use(
      http.get("http://localhost:3000/api/health", () =>
        HttpResponse.json({ secret: "row content" }, { status: 500 }),
      ),
    );
    const err = await api.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe("api /api/health 500");
  });
});

describe("ExternalLink", () => {
  it("links https and http URLs with noopener noreferrer", () => {
    render(<ExternalLink href="https://example.com/jobs/1">Apply</ExternalLink>);
    const a = screen.getByRole("link", { name: "Apply" });
    expect(a.getAttribute("href")).toBe("https://example.com/jobs/1");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  it.each([
    "javascript:alert(1)",
    "  JavaScript:alert(1)",
    "data:text/html,<b>x</b>",
    "vbscript:x",
    "file:///etc/passwd",
    "//example.com/x",
    "not a url",
  ])("renders %j as plain text, not a link", (href) => {
    const { container } = render(<ExternalLink href={href} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe(href);
  });
});
