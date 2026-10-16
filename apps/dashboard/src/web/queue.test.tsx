// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { BulkBody, PostingDetail, QueueItem, ReviewBody } from "./api.ts";

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
    questions: { total: 0, covered: 0, unknown: 0, salary: 0 },
    ...over,
  };
}

let items: Record<string, QueueItem>;
let sections: Record<"top" | "needs_a_look" | "suspicious" | "waiting", string[]>;
let history: Record<string, PostingDetail["history"]>;
let posted: ReviewBody[];
let failNext: boolean;
let firstReviewAt: string | null;
let bulkPosted: BulkBody[];
let undone: string[][];
let prior: Record<string, QueueItem["review"]>;

beforeEach(() => {
  firstReviewAt = null;
  bulkPosted = [];
  undone = [];
  prior = {};
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

/** Sets a posting's status the way the server would, remembering the state before for undo. */
function applyStatus(id: string, action: string, reason?: string): QueueItem["review"] {
  const prev = get(id);
  prior[id] = prev.review;
  const review = {
    status: action as QueueItem["review"]["status"],
    reason: reason ?? null,
    reviewedAt: "2026-10-15T08:00:00.000Z",
    processed: action !== "later",
  };
  items[id] = { ...prev, review };
  return review;
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
      firstReviewAt,
    }),
  ),
  http.post(`${BASE}/api/reviews/bulk`, async ({ request }) => {
    const body = (await request.json()) as BulkBody;
    if (failNext) return HttpResponse.json({ error: "internal error" }, { status: 500 });
    bulkPosted.push(body);
    for (const id of body.posting_ids) applyStatus(id, body.action, body.reason);
    return HttpResponse.json({ recorded: [] }, { status: 201 });
  }),
  http.post(`${BASE}/api/reviews/undo`, async ({ request }) => {
    const body = (await request.json()) as { posting_ids: string[] };
    if (failNext) return HttpResponse.json({ error: "undo_expired" }, { status: 409 });
    undone.push(body.posting_ids);
    for (const id of body.posting_ids) items[id] = { ...get(id), review: prior[id] ?? OPEN };
    return HttpResponse.json({ recorded: [] }, { status: 201 });
  }),
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
      ? applyStatus(body.posting_id, body.action, body.reason)
      : prev.review;
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
      "Questions",
      "Flags",
      "Review",
    ]);
    expect(titles("Top matches")).toEqual(["Backend Engineer", "Platform Engineer"]);
    expect(titles("Needs a look")).toEqual(["Backend Engineer"]);
    expect(titles("Suspicious")).toEqual(["Sketchy Role"]);
    expect(titles("Waiting for scoring")).toEqual(["Unscored Role"]);
    // Short form in the table (tier plus the money figure); the full ask is the cell's title and in the detail panel.
    const askCell = within(rowAt("Top matches", 2)).getAllByRole("cell")[4];
    expect(askCell?.textContent).toBe("indonesia / IDR 40,000,000");
    expect(askCell?.getAttribute("title")).toBe("indonesia / IDR 40,000,000 / month");
    expect(rowAt("Top matches", 2).textContent).not.toContain("Because the range is wide");
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

  it("shows covered/total questions per posting, a dash when none are stored", async () => {
    items.p1 = { ...get("p1"), questions: { total: 5, covered: 3, unknown: 1, salary: 1 } };
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    const rows = within(section("Top matches")).getAllByRole("row");
    const cell = (title: string): string | undefined => {
      const row = rows.find((r) => r.textContent?.includes(title));
      return within(row as HTMLElement).getAllByRole("cell")[7]?.textContent ?? undefined;
    };
    expect(cell("Backend Engineer")).toBe("3/5");
    expect(cell("Platform Engineer")).toBe("-");
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
    expect(panel.getByText("Text answer: Because the range is wide.")).toBeTruthy();
    expect(panel.getByText("Ask: IDR 40,000,000 / month")).toBeTruthy();
    expect(panel.queryByText(/Ask reason/)).toBeNull();
    const link = panel.getByRole("link", { name: "https://example.com/jobs/1" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    // Description is text: the tag is shown, not rendered.
    expect(panel.getByText("<b>Build</b> things")).toBeTruthy();
    expect(panel.getByText(/later: check Friday/)).toBeTruthy();
  });

  it("shows a text-only ask as 'text' in the table and keeps the full answer in the title and the panel", async () => {
    items.p2 = {
      ...get("p2"),
      tier: "regional",
      ask: "text answer: Open to talk.",
      askText: "Open to talk",
      title: "A very long platform engineering title that the table has to cut",
    };
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    const cells = within(rowAt("Top matches", 2)).getAllByRole("cell");
    expect(cells[4]?.textContent).toBe("regional / text");
    expect(cells[4]?.getAttribute("title")).toBe("regional / text answer: Open to talk.");
    expect(cells[1]?.getAttribute("title")).toBe(get("p2").title);
    await user.click(within(cells[1] as HTMLElement).getByRole("button"));
    const panel = within(await screen.findByRole("complementary", { name: "Posting detail" }));
    expect(await panel.findByText("Text answer: Open to talk.")).toBeTruthy();
  });

  it.each([
    ["Open to talk.", "Text answer: Open to talk."],
    ["Open to talk!", "Text answer: Open to talk!"],
    ["Open to talk?", "Text answer: Open to talk?"],
    ["Open to talk...", "Text answer: Open to talk..."],
    ["Open to talk", "Text answer: Open to talk."],
    ["Open to talk.  ", "Text answer: Open to talk."],
  ])("shows the text answer %j with exactly one ending mark", async (askText, shown) => {
    items.p2 = { ...get("p2"), askText };
    const user = userEvent.setup();
    renderApp();
    const panel = within(await openPosting(user, "Platform Engineer"));
    expect(await panel.findByText(shown)).toBeTruthy();
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

describe("keyboard shortcuts", () => {
  const selectedTitle = async () =>
    (
      await within(await screen.findByRole("complementary", { name: "Posting detail" })).findByRole(
        "heading",
        { level: 3 },
      )
    ).textContent;

  async function ready() {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    return user;
  }

  it("j and k move through the postings in queue order", async () => {
    const user = await ready();
    await user.keyboard("j");
    expect(await selectedTitle()).toContain("Backend Engineer");
    await user.keyboard("j");
    await waitFor(async () => expect(await selectedTitle()).toContain("Platform Engineer"));
    await user.keyboard("jj");
    await waitFor(async () => expect(await selectedTitle()).toContain("Unscored Role"));
    await user.keyboard("j"); // stays on the last row
    await user.keyboard("k");
    await waitFor(async () => expect(await selectedTitle()).toContain("Sketchy Role"));
  });

  it("o opens the apply link in a new tab, only for http(s)", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    items.p2 = { ...get("p2"), applyUrl: "javascript:alert(1)" };
    const user = await ready();
    await user.keyboard("o"); // nothing selected
    await user.keyboard("j");
    await user.keyboard("o");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://example.com/jobs/1",
      "_blank",
      "noopener,noreferrer",
    );
    await user.keyboard("j");
    await user.keyboard("o");
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it.each([
    ["i", "interested"],
    ["a", "applied_manually"],
    ["l", "later"],
  ])("%s records %s for the selected posting", async (key, action) => {
    const user = await ready();
    await user.keyboard("j");
    await selectedTitle();
    await user.keyboard(key);
    await waitFor(() => expect(posted).toEqual([{ posting_id: "p1", action }]));
  });

  it("x then a number key records not interested with that reason", async () => {
    const user = await ready();
    await user.keyboard("j");
    await selectedTitle();
    await user.keyboard("x");
    expect(screen.getByRole("status", { name: "Not interested reason" }).textContent).toContain(
      "5 stack",
    );
    await user.keyboard("5");
    await waitFor(() =>
      expect(posted).toEqual([{ posting_id: "p1", action: "not_interested", reason: "stack" }]),
    );
    expect(screen.queryByRole("status", { name: "Not interested reason" })).toBeNull();
  });

  it.each([
    ["1", "location"],
    ["2", "timezone"],
    ["3", "role"],
    ["4", "seniority"],
    ["6", "salary"],
    ["7", "company"],
    ["8", "domestic_company"],
    ["9", "language"],
    ["0", "expired"],
  ])("x then %s is %s", async (key, reason) => {
    const user = await ready();
    await user.keyboard("j");
    await selectedTitle();
    await user.keyboard(`x${key}`);
    await waitFor(() => expect(posted[0]?.reason).toBe(reason));
  });

  it("x then another key cancels and records nothing", async () => {
    const user = await ready();
    await user.keyboard("j");
    await selectedTitle();
    await user.keyboard("xq");
    await user.keyboard("5"); // not in x mode any more
    expect(posted).toEqual([]);
    expect(screen.queryByRole("status", { name: "Not interested reason" })).toBeNull();
  });

  it("s records scam without moving the selection", async () => {
    const user = await ready();
    await user.keyboard("j");
    await selectedTitle();
    await user.keyboard("s");
    await waitFor(() => expect(posted).toEqual([{ posting_id: "p1", action: "scam" }]));
    expect(await selectedTitle()).toContain("Backend Engineer");
  });

  it("? shows the shortcut list and Escape closes it", async () => {
    const user = await ready();
    expect(screen.queryByRole("region", { name: "Keyboard shortcuts" })).toBeNull();
    await user.keyboard("?");
    const list = within(screen.getByRole("region", { name: "Keyboard shortcuts" }));
    for (const keys of ["j / k", "o", "i", "a", "l", "x, then 1-9 or 0", "s", "u", "?"])
      expect(list.getByText(keys)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("ignores keys while typing in an input", async () => {
    const user = await ready();
    await user.keyboard("j");
    const panel = within(await screen.findByRole("complementary", { name: "Posting detail" }));
    await user.click(await panel.findByRole("button", { name: "not interested" }));
    const note = panel.getByRole("textbox", { name: /Note/ });
    await user.type(note, "jilxs?o");
    expect((note as HTMLTextAreaElement).value).toBe("jilxs?o");
    expect(posted).toEqual([]);
    expect(screen.queryByRole("region", { name: "Keyboard shortcuts" })).toBeNull();
    expect(await selectedTitle()).toContain("Backend Engineer");
  });

  it("ignores keys with ctrl, meta or alt held", async () => {
    const user = await ready();
    await user.keyboard("j");
    await selectedTitle();
    await user.keyboard("{Control>}i{/Control}{Meta>}a{/Meta}");
    expect(posted).toEqual([]);
  });

  it("does nothing for an action key when no posting is selected", async () => {
    const user = await ready();
    await user.keyboard("ial");
    expect(posted).toEqual([]);
  });
});

describe("auto-advance", () => {
  const heading = (panel: HTMLElement) => within(panel).getByRole("heading", { level: 3 });

  it("moves the selection to the next open row after a status action", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.keyboard("ji");
    await waitFor(() => expect(posted).toHaveLength(1));
    const panel = await screen.findByRole("complementary", { name: "Posting detail" });
    await waitFor(() => expect(heading(panel).textContent).toContain("Platform Engineer"));
    await user.keyboard("l"); // later stays open but still moves on
    await waitFor(() => expect(posted).toHaveLength(2));
    await waitFor(() => expect(heading(panel).textContent).toContain("Sketchy Role"));
    expect(posted.map((p) => p.posting_id)).toEqual(["p1", "p2"]);
  });

  it("skips processed rows and wraps to an earlier open row", async () => {
    items.p3 = { ...get("p3"), review: { ...OPEN, status: "interested", processed: true } };
    items.p4 = { ...get("p4"), review: { ...OPEN, status: "interested", processed: true } };
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.click(screen.getByRole("checkbox", { name: "Open only" })); // show processed rows too
    await user.keyboard("jj"); // p2
    await user.keyboard("i");
    await waitFor(() => expect(posted).toEqual([{ posting_id: "p2", action: "interested" }]));
    const panel = await screen.findByRole("complementary", { name: "Posting detail" });
    await waitFor(() => expect(heading(panel).textContent).toContain("Backend Engineer"));
  });

  it("closes the panel when no open row is left", async () => {
    sections = { top: ["p1"], needs_a_look: [], suspicious: [], waiting: [] };
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.keyboard("ji");
    await waitFor(() => expect(posted).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Posting detail" })).toBeNull(),
    );
  });
});

describe("bulk not interested", () => {
  beforeEach(() => {
    items.p5 = item({ postingId: "p5", title: "Third Role" });
    sections.top = ["p1", "p2", "p5"];
  });
  const box = (title: string) =>
    within(section("Top matches")).getByRole<HTMLInputElement>("checkbox", {
      name: `Select ${title}`,
    });
  const bulk = () => screen.getByRole("group", { name: "Bulk actions" });

  it("applies one reason to every ticked posting with one request", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    expect(screen.queryByRole("group", { name: "Bulk actions" })).toBeNull();
    await user.click(box("Backend Engineer"));
    await user.click(box("Third Role"));
    expect(within(bulk()).getByText("2 selected")).toBeTruthy();
    await user.selectOptions(within(bulk()).getByRole("combobox", { name: /Reason/ }), "salary");
    await user.click(within(bulk()).getByRole("button", { name: "Not interested (2)" }));
    await waitFor(() =>
      expect(bulkPosted).toEqual([
        { posting_ids: ["p1", "p5"], action: "not_interested", reason: "salary" },
      ]),
    );
    expect(posted).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Bulk actions" })).toBeNull());
    await waitFor(() => expect(titles("Top matches")).toEqual(["Platform Engineer"]));
  });

  it("shift-click ticks the range between two checkboxes in the shown order", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.click(box("Backend Engineer"));
    await user.keyboard("{Shift>}");
    await user.click(box("Third Role"));
    await user.keyboard("{/Shift}");
    expect(within(bulk()).getByText("3 selected")).toBeTruthy();
    for (const t of ["Backend Engineer", "Platform Engineer", "Third Role"])
      expect(box(t).checked).toBe(true);
    await user.click(within(bulk()).getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("group", { name: "Bulk actions" })).toBeNull();
  });

  it("needs a reason, and a note for other", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.click(box("Backend Engineer"));
    await user.click(within(bulk()).getByRole("button", { name: "Not interested (1)" }));
    expect(screen.getByRole("alert").textContent).toBe("Pick a reason.");
    await user.selectOptions(within(bulk()).getByRole("combobox", { name: /Reason/ }), "other");
    await user.click(within(bulk()).getByRole("button", { name: "Not interested (1)" }));
    expect(screen.getByRole("alert").textContent).toBe("A note is required for other.");
    expect(bulkPosted).toEqual([]);
    await user.type(within(bulk()).getByRole("textbox", { name: /Note/ }), "Needs relocation");
    await user.click(within(bulk()).getByRole("button", { name: "Not interested (1)" }));
    await waitFor(() =>
      expect(bulkPosted).toEqual([
        {
          posting_ids: ["p1"],
          action: "not_interested",
          reason: "other",
          note: "Needs relocation",
        },
      ]),
    );
  });

  it("the keyboard actions apply to all ticked postings", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.click(box("Backend Engineer"));
    await user.click(box("Platform Engineer"));
    await user.keyboard("j"); // opens the detail panel; the ticked rows still win
    await user.keyboard("x6");
    await waitFor(() =>
      expect(bulkPosted).toEqual([
        { posting_ids: ["p1", "p2"], action: "not_interested", reason: "salary" },
      ]),
    );
    expect(posted).toEqual([]);
  });

  it("reports a failed bulk request and keeps the selection", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.click(box("Backend Engineer"));
    await user.selectOptions(within(bulk()).getByRole("combobox", { name: /Reason/ }), "role");
    failNext = true;
    await user.click(within(bulk()).getByRole("button", { name: "Not interested (1)" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Saving failed. Nothing was recorded.",
    );
    expect(within(bulk()).getByText("1 selected")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Undo" })).toBeNull();
  });
});

describe("undo", () => {
  it("the undo button takes back the last action", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.keyboard("ji");
    const bar = await screen.findByRole("status", { name: "Undo" });
    expect(bar.textContent).toContain("Recorded interested (1)");
    await waitFor(() => expect(titles("Top matches")).toEqual(["Platform Engineer"]));
    await user.click(within(bar).getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(undone).toEqual([["p1"]]));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Undo" })).toBeNull());
    await waitFor(() =>
      expect(titles("Top matches")).toEqual(["Backend Engineer", "Platform Engineer"]),
    );
    expect(screen.getByRole("status", { name: "Progress" }).textContent).toBe("0 of 3 processed");
  });

  it("u undoes a bulk action for all its postings", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    const top = within(section("Top matches")); // Backend Engineer is also listed under Needs a look
    await user.click(top.getByRole("checkbox", { name: "Select Backend Engineer" }));
    await user.click(top.getByRole("checkbox", { name: "Select Platform Engineer" }));
    await user.keyboard("j");
    await user.keyboard("x3");
    await waitFor(() => expect(bulkPosted).toHaveLength(1));
    await screen.findByRole("status", { name: "Undo" });
    await user.keyboard("u");
    await waitFor(() => expect(undone).toEqual([["p1", "p2"]]));
  });

  it("the offer disappears after 10 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      renderApp();
      await screen.findByRole("region", { name: "Top matches" });
      await user.keyboard("ji");
      await screen.findByRole("status", { name: "Undo" });
      await act(async () => {
        vi.advanceTimersByTime(9_000);
      });
      expect(screen.queryByRole("status", { name: "Undo" })).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      expect(screen.queryByRole("status", { name: "Undo" })).toBeNull();
      await user.keyboard("u");
      expect(undone).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a refused undo", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Top matches" });
    await user.keyboard("ji");
    await screen.findByRole("status", { name: "Undo" });
    failNext = true;
    await user.keyboard("u");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Undo failed. Nothing was changed.",
    );
  });
});

describe("elapsed timer", () => {
  it("counts from the first review action of the day as the API reports it", async () => {
    firstReviewAt = "2026-10-15T07:30:00.000Z"; // NOW is 08:00
    renderApp();
    const timer = await screen.findByRole("timer", { name: "Elapsed" });
    expect(timer.textContent).toBe("Elapsed: 30:00");
  });

  it("shows hours after the first hour", async () => {
    firstReviewAt = "2026-10-15T06:45:30.000Z";
    renderApp();
    expect((await screen.findByRole("timer", { name: "Elapsed" })).textContent).toBe(
      "Elapsed: 1:14:30",
    );
  });

  it("has not started before the first review", async () => {
    renderApp();
    expect((await screen.findByRole("timer", { name: "Elapsed" })).textContent).toContain(
      "starts with the first review",
    );
  });
});
