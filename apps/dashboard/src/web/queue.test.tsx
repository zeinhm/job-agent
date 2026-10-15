// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import type { PostingDetail, QueueItem, ReviewBody } from "./api.ts";

const BASE = "http://localhost:3000";
const NOW = () => new Date("2026-10-15T08:00:00Z"); // Jakarta 2026-10-15

const OPEN = { status: "open", reason: null, reviewedAt: null, processed: false } as const;

function item(over: Partial<QueueItem> & { postingId: string; title: string }): QueueItem {
  return {
    kind: "top",
    company: "Example Co",
    locations: ["Remote"],
    locationClass: "global",
    fitScore: 70,
    fitReasons: [],
    flags: [],
    tier: "global_flat",
    ask: null,
    askText: null,
    listedSalary: "not listed",
    scamScore: null,
    scamReason: null,
    applyUrl: "https://example.com/jobs/1",
    applyType: "ats",
    review: OPEN,
    ...over,
  };
}

let items: Record<string, QueueItem>;
let sections: Record<"top" | "needs_a_look" | "suspicious" | "waiting", string[]>;
let history: Record<string, PostingDetail["history"]>;
let posted: ReviewBody[];
let failNext: boolean;

beforeEach(() => {
  items = {
    p1: item({
      postingId: "p1",
      title: "Backend Engineer",
      fitScore: 60,
      flags: ["location_unclear"],
    }),
    p2: item({
      postingId: "p2",
      title: "Platform Engineer",
      fitScore: 90,
      tier: "indonesia",
      ask: "IDR 40,000,000 / month",
      askText: "Because the range is wide",
    }),
    p3: item({ postingId: "p3", title: "Sketchy Role", kind: "suspicious", fitScore: null }),
    p4: item({ postingId: "p4", title: "Unscored Role", kind: "waiting", fitScore: null }),
  };
  sections = { top: ["p1", "p2"], needs_a_look: ["p1"], suspicious: ["p3"], waiting: ["p4"] };
  history = {};
  posted = [];
  failNext = false;
});

function get(id: string): QueueItem {
  const found = items[id];
  if (found === undefined) throw new Error(`no test posting ${id}`);
  return found;
}

function detail(id: string): PostingDetail {
  return {
    ...get(id),
    descriptionText: "<b>Build</b> things",
    reasons: {
      fit: ["Strong TypeScript match"],
      scam: ["Asks for a fee"],
      resolved: [],
      rules: [],
    },
    history: history[id] ?? [],
  };
}

const server = setupServer(
  http.get(`${BASE}/api/health`, () => HttpResponse.json({ ok: true, db: "ok" })),
  http.get(`${BASE}/api/queue`, () =>
    HttpResponse.json({
      date: "2026-10-15",
      sections: Object.fromEntries(
        Object.entries(sections).map(([k, ids]) => [k, ids.map((id) => items[id])]),
      ),
    }),
  ),
  http.get(`${BASE}/api/postings/:id`, ({ params }) => {
    const id = String(params.id);
    return items[id] === undefined
      ? HttpResponse.json({ error: "not found" }, { status: 404 })
      : HttpResponse.json(detail(id));
  }),
  http.post(`${BASE}/api/reviews`, async ({ request }) => {
    const body = (await request.json()) as ReviewBody;
    if (failNext) return HttpResponse.json({ error: "internal error" }, { status: 500 });
    posted.push(body);
    const prev = get(body.posting_id);
    const statusActions = ["interested", "applied_manually", "not_interested", "later"];
    const review = statusActions.includes(body.action)
      ? {
          status: body.action as QueueItem["review"]["status"],
          reason: body.reason ?? null,
          reviewedAt: "2026-10-15T08:00:00.000Z",
          processed: body.action !== "later",
        }
      : prev.review;
    items[body.posting_id] = { ...prev, review };
    history[body.posting_id] = [
      {
        id: `r${posted.length}`,
        action: body.action,
        reason: body.reason ?? null,
        note: body.note ?? null,
        apply_url: body.apply_url ?? null,
        pay_policy: body.pay_policy ?? null,
        reviewed_at: "2026-10-15T08:00:00.000Z",
      },
      ...(history[body.posting_id] ?? []),
    ];
    return HttpResponse.json({ review: {}, state: review }, { status: 201 });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App now={NOW} />
    </QueryClientProvider>,
  );
}

const section = (name: string) => screen.getByRole("region", { name });
const rowAt = (name: string, index: number): HTMLElement => {
  const row = within(section(name)).getAllByRole("row")[index];
  if (row === undefined) throw new Error(`no row ${index} in ${name}`);
  return row;
};
const titles = (name: string) =>
  within(section(name))
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[1]?.textContent);

async function openPosting(user: ReturnType<typeof userEvent.setup>, title: string) {
  await screen.findByRole("region", { name: "Top matches" });
  await user.click(within(section("Top matches")).getByRole("button", { name: title }));
  return await screen.findByRole("complementary", { name: "Posting detail" });
}

describe("queue sections", () => {
  it("renders each section as its own table, Top matches first, with the columns", async () => {
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    const names = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual(["Top matches", "Needs a look", "Suspicious", "Waiting for scoring"]);
    const headers = within(section("Top matches"))
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.replace(/ [▲▼]$/, ""));
    expect(headers).toEqual([
      "Rank",
      "Title",
      "Company",
      "Fit",
      "Tier / ask",
      "Salary",
      "Apply",
      "Flags",
      "Review",
    ]);
    expect(titles("Top matches")).toEqual(["Backend Engineer", "Platform Engineer"]);
    expect(titles("Needs a look")).toEqual(["Backend Engineer"]);
    expect(titles("Suspicious")).toEqual(["Sketchy Role"]);
    expect(titles("Waiting for scoring")).toEqual(["Unscored Role"]);
    expect(rowAt("Top matches", 2).textContent).toContain("indonesia / IDR 40,000,000 / month");
    expect(rowAt("Top matches", 1).textContent).toContain("location_unclear");
  });

  it("sorts by rank and by fit", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    const top = section("Top matches");
    expect(titles("Top matches")).toEqual(["Backend Engineer", "Platform Engineer"]);
    await user.click(within(top).getByRole("button", { name: /^Fit/ }));
    expect(titles("Top matches")).toEqual(["Platform Engineer", "Backend Engineer"]); // fit 90, 60
    await user.click(within(top).getByRole("button", { name: /^Fit/ }));
    expect(titles("Top matches")).toEqual(["Backend Engineer", "Platform Engineer"]); // fit 60, 90
    await user.click(within(top).getByRole("button", { name: /^Rank/ }));
    expect(titles("Top matches")).toEqual(["Platform Engineer", "Backend Engineer"]); // rank 2, 1
    await user.click(within(top).getByRole("button", { name: /^Rank/ }));
    expect(titles("Top matches")).toEqual(["Backend Engineer", "Platform Engineer"]); // rank 1, 2
  });

  it("shows an empty state when the day has no postings", async () => {
    sections = { top: [], needs_a_look: [], suspicious: [], waiting: [] };
    renderApp();
    expect(await screen.findByText(/No postings in the queue/)).toBeTruthy();
    expect(screen.getByRole("status", { name: "Progress" }).textContent).toBe("0 of 0 processed");
  });

  it("filters to open postings by default and can show processed ones", async () => {
    items.p2 = { ...get("p2"), review: { ...OPEN, status: "interested", processed: true } };
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    const box = screen.getByRole<HTMLInputElement>("checkbox", { name: "Open only" });
    expect(box.checked).toBe(true);
    expect(titles("Top matches")).toEqual(["Backend Engineer"]);
    await user.click(box);
    expect(titles("Top matches")).toEqual(["Backend Engineer", "Platform Engineer"]);
    expect(within(section("Top matches")).getByText("interested")).toBeTruthy();
  });

  it("keeps `later` postings in the open list", async () => {
    items.p1 = { ...get("p1"), review: { ...OPEN, status: "later", processed: false } };
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    expect(titles("Top matches")).toContain("Backend Engineer");
  });
});

describe("progress line", () => {
  it("counts processed of matches (Top and Suspicious, without duplicates or waiting)", async () => {
    items.p2 = { ...get("p2"), review: { ...OPEN, status: "applied_manually", processed: true } };
    items.p4 = { ...get("p4"), review: { ...OPEN, status: "interested", processed: true } };
    renderApp();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Progress" }).textContent).toBe("1 of 3 processed"),
    );
  });
});

describe("detail panel", () => {
  it("shows reasons, location, ask reason, apply link, description as text and history", async () => {
    history.p2 = [
      {
        id: "h1",
        action: "later",
        reason: null,
        note: "check Friday",
        apply_url: null,
        pay_policy: null,
        reviewed_at: "2026-10-14T08:00:00.000Z",
      },
    ];
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Platform Engineer"));
    await panel.findByText("Strong TypeScript match");
    expect(panel.getByText("Asks for a fee")).toBeTruthy();
    expect(panel.getByText(/Location: Remote/)).toBeTruthy();
    expect(panel.getByText(/Because the range is wide/)).toBeTruthy();
    const link = panel.getByRole("link", { name: "https://example.com/jobs/1" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    // Description is text: the tag is shown, not rendered.
    expect(panel.getByText("<b>Build</b> things")).toBeTruthy();
    expect(panel.getByText(/later: check Friday/)).toBeTruthy();
  });

  it("does not link a non-http apply URL", async () => {
    items.p1 = { ...get("p1"), applyUrl: "javascript:alert(1)" };
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Backend Engineer"));
    await panel.findByText("javascript:alert(1)");
    expect(panel.queryByRole("link")).toBeNull();
  });

  it("shows ask checks only when the posting has an ask", async () => {
    const user = userEvent.setup();
    renderApp();
    let panel = within(await openPosting(user, "Backend Engineer"));
    await panel.findByText("Actions");
    expect(panel.queryByRole("button", { name: "ask ok" })).toBeNull();
    panel = within(await openPosting(user, "Platform Engineer"));
    await waitFor(() => expect(panel.getByRole("button", { name: "ask ok" })).toBeTruthy());
    expect(panel.getByRole("button", { name: "ask too high" })).toBeTruthy();
    expect(panel.getByRole("button", { name: "ask too low" })).toBeTruthy();
  });
});

describe("actions", () => {
  it.each([
    ["interested", "interested"],
    ["applied manually", "applied_manually"],
    ["later", "later"],
    ["scam", "scam"],
    ["not scam", "not_scam"],
    ["ask ok", "ask_ok"],
    ["ask too high", "ask_too_high"],
    ["ask too low", "ask_too_low"],
  ])("button %j posts action %s", async (name, action) => {
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Platform Engineer"));
    await user.click(await panel.findByRole("button", { name }));
    await waitFor(() => expect(posted).toEqual([{ posting_id: "p2", action }]));
  });

  it("not interested requires a reason from the fixed list", async () => {
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Backend Engineer"));
    await user.click(await panel.findByRole("button", { name: "not interested" }));
    const options = within(panel.getByRole("combobox", { name: /Reason/ }))
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual([
      "",
      "location",
      "timezone",
      "role",
      "seniority",
      "stack",
      "salary",
      "company",
      "domestic_company",
      "language",
      "duplicate",
      "expired",
      "scam_suspected",
      "other",
    ]);
    await user.click(panel.getByRole("button", { name: "Confirm not interested" }));
    expect(panel.getByRole("alert").textContent).toBe("Pick a reason.");
    expect(posted).toEqual([]);
    await user.selectOptions(panel.getByRole("combobox", { name: /Reason/ }), "stack");
    await user.click(panel.getByRole("button", { name: "Confirm not interested" }));
    await waitFor(() =>
      expect(posted).toEqual([{ posting_id: "p1", action: "not_interested", reason: "stack" }]),
    );
  });

  it("the reason `other` needs a note", async () => {
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Backend Engineer"));
    await user.click(await panel.findByRole("button", { name: "not interested" }));
    await user.selectOptions(panel.getByRole("combobox", { name: /Reason/ }), "other");
    await user.click(panel.getByRole("button", { name: "Confirm not interested" }));
    expect(panel.getByRole("alert").textContent).toBe("A note is required for other.");
    await user.type(panel.getByRole("textbox", { name: /Note/ }), "   ");
    await user.click(panel.getByRole("button", { name: "Confirm not interested" }));
    expect(posted).toEqual([]);
    await user.type(panel.getByRole("textbox", { name: /Note/ }), "Needs relocation");
    await user.click(panel.getByRole("button", { name: "Confirm not interested" }));
    await waitFor(() =>
      expect(posted).toEqual([
        { posting_id: "p1", action: "not_interested", reason: "other", note: "Needs relocation" },
      ]),
    );
  });

  it("wrong apply link takes an optional URL", async () => {
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Backend Engineer"));
    await user.click(await panel.findByRole("button", { name: "wrong apply link" }));
    await user.type(panel.getByRole("textbox", { name: /Corrected apply URL/ }), "ftp://x.example");
    await user.click(panel.getByRole("button", { name: "Confirm wrong apply link" }));
    expect(panel.getByRole("alert").textContent).toMatch(/http or https/);
    expect(posted).toEqual([]);
    await user.clear(panel.getByRole("textbox", { name: /Corrected apply URL/ }));
    await user.type(
      panel.getByRole("textbox", { name: /Corrected apply URL/ }),
      "https://example.com/careers/9",
    );
    await user.click(panel.getByRole("button", { name: "Confirm wrong apply link" }));
    await waitFor(() =>
      expect(posted).toEqual([
        {
          posting_id: "p1",
          action: "wrong_apply_link",
          apply_url: "https://example.com/careers/9",
        },
      ]),
    );
    // Without a URL the body carries no apply_url.
    await user.click(await panel.findByRole("button", { name: "wrong apply link" }));
    await user.click(panel.getByRole("button", { name: "Confirm wrong apply link" }));
    await waitFor(() =>
      expect(posted[1]).toEqual({ posting_id: "p1", action: "wrong_apply_link" }),
    );
  });

  it.each(["location_agnostic", "location_adjusted"])("pay policy %s", async (policy) => {
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Backend Engineer"));
    await user.click(await panel.findByRole("button", { name: "pay policy" }));
    const group = within(panel.getByRole("group", { name: "Pay policy" }));
    expect(group.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "location agnostic",
      "location adjusted",
    ]);
    await user.click(group.getByRole("button", { name: policy.replace("_", " ") }));
    await waitFor(() =>
      expect(posted).toEqual([{ posting_id: "p1", action: "pay_policy", pay_policy: policy }]),
    );
  });

  it("the row shows its new state after an action, without a reload, and progress updates", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Progress" }).textContent).toBe("0 of 3 processed"),
    );
    await user.click(screen.getByRole("checkbox", { name: "Open only" })); // keep processed rows visible
    const panel = within(await openPosting(user, "Platform Engineer"));
    await user.click(await panel.findByRole("button", { name: "interested" }));
    await waitFor(() => expect(rowAt("Top matches", 2).textContent).toContain("interested"));
    expect(screen.getByRole("status", { name: "Progress" }).textContent).toBe("1 of 3 processed");
    // Detail panel history refreshed too.
    expect(await panel.findByText(/2026-10-15T08:00:00.000Z: interested/)).toBeTruthy();
  });

  it("a processed row leaves the list while open only is on", async () => {
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Platform Engineer"));
    await user.click(await panel.findByRole("button", { name: "applied manually" }));
    await waitFor(() => expect(titles("Top matches")).toEqual(["Backend Engineer"]));
  });

  it("reports a failed save and records nothing", async () => {
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Backend Engineer"));
    const button = await panel.findByRole("button", { name: "interested" });
    failNext = true;
    await user.click(button);
    expect((await panel.findByRole("alert")).textContent).toBe(
      "Saving failed. Nothing was recorded.",
    );
    expect(posted).toEqual([]);
  });
});
