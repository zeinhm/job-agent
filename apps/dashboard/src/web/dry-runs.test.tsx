// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DryRunDetail, DryRunDoneWhen, DryRunRow } from "./api.ts";
import { DryRunsTab } from "./components/DryRunsTab.tsx";

const BASE = "http://localhost:3000";

const row = (over: Partial<DryRunRow> & { id: string }): DryRunRow => ({
  postingId: "p1",
  title: "Platform Engineer",
  company: "Example Co",
  atsType: "greenhouse",
  status: "filled",
  stopReason: null,
  fieldsFilled: 2,
  fieldsTotal: 2,
  startedAt: "2026-10-16T06:00:00.000Z",
  fixture: false,
  review: null,
  reviewReason: null,
  ...over,
});

let runs: DryRunRow[];
let posted: { id: string; body: Record<string, unknown> }[];

const doneWhen = (): DryRunDoneWhen => {
  const reviewed = runs.filter((r) => r.review !== null && !r.fixture);
  const correct = reviewed.filter((r) => r.review === "correct");
  const full = correct.filter((r) => r.status === "filled").length;
  return {
    correct: correct.length,
    reviewed: reviewed.length,
    fullFills: full,
    met: false,
    line: `dry runs: ${correct.length} correct of ${reviewed.length} reviewed (${full} full fills); done when 20 correct, at least 10 full fills: not met`,
  };
};

const detail = (id: string): DryRunDetail => {
  const r = runs.find((x) => x.id === id) as DryRunRow;
  return {
    ...r,
    finishedAt: "2026-10-16T06:01:00.000Z",
    stopDetail: r.stopReason === null ? null : "one question has no approved answer",
    reviewNote: null,
    reviewedAt: null,
    hasScreenshot: true,
    blockedRequestsRecorded: 0,
    fields: [
      {
        label: "Full name",
        fieldType: "input_text",
        required: true,
        source: "answer",
        answerKey: "contact.full_name",
        value: "Alex Example",
        filled: true,
        note: null,
      },
      {
        label: "Why us?",
        fieldType: "textarea",
        required: false,
        source: "none",
        answerKey: null,
        value: null,
        filled: false,
        note: null,
      },
    ],
  };
};

beforeEach(() => {
  posted = [];
  runs = [
    row({ id: "r-new", title: "Platform Engineer" }),
    row({
      id: "r-old",
      title: "Data Engineer",
      company: "Sample Inc",
      atsType: "lever",
      status: "needs_input",
      stopReason: "uncovered_question",
      fieldsFilled: 1,
      fieldsTotal: 2,
      startedAt: "2026-10-15T06:00:00.000Z",
    }),
  ];
});

const server = setupServer(
  http.get(`${BASE}/api/dry-runs`, () => HttpResponse.json({ runs, doneWhen: doneWhen() })),
  http.get(`${BASE}/api/dry-runs/:id`, ({ params }) =>
    HttpResponse.json(detail(String(params.id))),
  ),
  http.post(`${BASE}/api/dry-runs/:id/review`, async ({ params, request }) => {
    const id = String(params.id);
    const body = (await request.json()) as Record<string, unknown>;
    posted.push({ id, body });
    runs = runs.map((r) =>
      r.id === id
        ? {
            ...r,
            review: body.review as "correct" | "wrong",
            reviewReason: (body.reason as string | undefined) ?? null,
          }
        : r,
    );
    return HttpResponse.json({
      review: body.review,
      reason: body.reason ?? null,
      inboxOpen: body.missing_label !== undefined,
      doneWhen: doneWhen(),
    });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DryRunsTab />
    </QueryClientProvider>,
  );
}

describe("DryRunsTab", () => {
  it("lists one row per run with status, stop reason, fields and review, plus the done-when line", async () => {
    renderTab();
    const table = within(await screen.findByRole("table", { name: "Dry runs" }));
    const rows = table.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Platform Engineer")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("2/2")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("uncovered_question")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("1/2")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("lever")).toBeTruthy();
    expect(screen.getByLabelText("Dry-run done-when").textContent).toBe(
      "dry runs: 0 correct of 0 reviewed (0 full fills); done when 20 correct, at least 10 full fills: not met",
    );
  });

  it("shows an empty state", async () => {
    runs = [];
    renderTab();
    expect(await screen.findByText(/No dry runs yet/)).toBeTruthy();
  });

  it("detail shows the screenshot, every field and the stop detail", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(
      await screen.findByRole("button", { name: "Open Data Engineer at Sample Inc" }),
    );
    const fields = within(await screen.findByRole("table", { name: "Filled fields" }));
    expect(fields.getByText("Full name")).toBeTruthy();
    expect(fields.getByText("Alex Example")).toBeTruthy();
    expect(fields.getByText("contact.full_name")).toBeTruthy();
    expect(fields.getByText("Why us?")).toBeTruthy();
    expect(screen.getByText(/one question has no approved answer/)).toBeTruthy();
    expect(screen.getByText(/Blocked requests recorded: 0/)).toBeTruthy();
    const img = screen.getByAltText("Dry run screenshot") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/dry-runs/r-old/screenshot");
  });

  it("Correct posts the verdict and the done-when line updates", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(
      await screen.findByRole("button", { name: "Open Platform Engineer at Example Co" }),
    );
    await user.click(await screen.findByRole("button", { name: "Correct" }));
    await waitFor(() => expect(posted).toEqual([{ id: "r-new", body: { review: "correct" } }]));
    await waitFor(() =>
      expect(screen.getByLabelText("Dry-run done-when").textContent).toContain(
        "1 correct of 1 reviewed (1 full fills)",
      ),
    );
  });

  it("Wrong needs a reason and posts it with the note; it can change a review later", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(
      await screen.findByRole("button", { name: "Open Platform Engineer at Example Co" }),
    );
    await user.click(await screen.findByRole("button", { name: "Correct" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Wrong" }));
    const save = screen.getByRole("button", { name: "Save wrong" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("Reason"), "wrong_value");
    await user.type(screen.getByLabelText("Note"), "typo in the name");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({
      id: "r-new",
      body: { review: "wrong", reason: "wrong_value", note: "typo in the name" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Dry-run done-when").textContent).toContain(
        "0 correct of 1 reviewed",
      ),
    );
  });

  it("lists the eight reasons", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(
      await screen.findByRole("button", { name: "Open Platform Engineer at Example Co" }),
    );
    await user.click(await screen.findByRole("button", { name: "Wrong" }));
    const options = within(screen.getByLabelText("Reason"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual([
      "choose a reason",
      "wrong_value",
      "wrong_choice",
      "missing_field",
      "salary_wrong",
      "stopped_wrongly",
      "should_have_stopped",
      "page_broken",
      "other",
    ]);
  });

  it("missing_field asks for the missing label and posts it", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(
      await screen.findByRole("button", { name: "Open Data Engineer at Sample Inc" }),
    );
    await user.click(await screen.findByRole("button", { name: "Wrong" }));
    expect(screen.queryByLabelText("Missing field label")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Reason"), "missing_field");
    await user.type(screen.getByLabelText("Missing field label"), "Security clearance?");
    await user.click(screen.getByRole("button", { name: "Save wrong" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      id: "r-old",
      body: { review: "wrong", reason: "missing_field", missing_label: "Security clearance?" },
    });
  });

  it("shows an alert when saving fails", async () => {
    server.use(
      http.post(`${BASE}/api/dry-runs/:id/review`, () => HttpResponse.json({}, { status: 500 })),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(
      await screen.findByRole("button", { name: "Open Platform Engineer at Example Co" }),
    );
    await user.click(await screen.findByRole("button", { name: "Correct" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save the review.");
  });
});
