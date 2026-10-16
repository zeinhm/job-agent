// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnswersTab } from "./components/AnswersTab.tsx";
import { InboxTab } from "./components/InboxTab.tsx";
import type { Answer, ChoiceMapping, ChoiceMappingBody, MappingNeed } from "./api.ts";

const BASE = "http://localhost:3000";
const LABEL = "What is your notice period?";
const OPTIONS = ["Immediately", "Within 1 month", "More than 1 month"];

const need = (over: Partial<MappingNeed> = {}): MappingNeed => ({
  answerKey: "work.notice",
  label: LABEL,
  normalizedLabel: "what is your notice period",
  options: OPTIONS,
  multi: false,
  answerText: "FAKE-ANSWER",
  postingCount: 2,
  examples: [{ postingId: "p1", title: "Engineer", company: "Acme" }],
  picked: null,
  ...over,
});

const answer: Answer = {
  key: "work.notice",
  group: "work",
  question: LABEL,
  answer: "FAKE-ANSWER",
  type: "text",
  choices: null,
  alternatives: null,
  approved: true,
  approvedAt: "2026-10-16T00:00:00.000Z",
  source: "dashboard",
  updatedAt: "2026-10-16T00:00:00.000Z",
};

const mapping = (over: Partial<ChoiceMapping> = {}): ChoiceMapping => ({
  answerKey: "work.notice",
  normalizedLabel: "what is your notice period",
  optionsHash: "h1",
  options: OPTIONS,
  chosen: ["Within 1 month"],
  approved: true,
  approvedAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
  ...over,
});

let needs: MappingNeed[];
let mappings: ChoiceMapping[];
let saved: ChoiceMappingBody[];
let removed: unknown[];
beforeEach(() => {
  needs = [need()];
  mappings = [];
  saved = [];
  removed = [];
});

const server = setupServer(
  http.get(`${BASE}/api/inbox`, () =>
    HttpResponse.json({ openCount: 0, items: [], mappings: needs }),
  ),
  http.get(`${BASE}/api/answers`, () => HttpResponse.json({ answers: [answer] })),
  http.get(`${BASE}/api/choice-mappings`, () => HttpResponse.json({ mappings })),
  http.post(`${BASE}/api/choice-mappings`, async ({ request }) => {
    const body = (await request.json()) as ChoiceMappingBody;
    saved.push(body);
    needs = [];
    return HttpResponse.json(mapping({ chosen: body.chosen }), { status: 201 });
  }),
  http.post(`${BASE}/api/choice-mappings/remove`, async ({ request }) => {
    removed.push(await request.json());
    mappings = [];
    return HttpResponse.json({ removed: true });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function renderTab(tab: "inbox" | "answers") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {tab === "inbox" ? <InboxTab /> : <AnswersTab />}
    </QueryClientProvider>,
  );
}

describe("Inbox: choice mapping picker", () => {
  it("shows the question, the form's options in order, the approved answer text and a disabled save", async () => {
    renderTab("inbox");
    const row = await screen.findByRole("listitem", { name: `Choice mapping for ${LABEL}` });
    expect(within(row).getByText("needs a choice mapping")).toBeTruthy();
    expect(within(row).getByText("FAKE-ANSWER")).toBeTruthy();
    const radios = within(row).getAllByRole("radio");
    expect(radios.map((r) => r.parentElement?.textContent?.trim())).toEqual(OPTIONS);
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(
      (within(row).getByRole("button", { name: `Save mapping for ${LABEL}` }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("saves one picked option with the answer key, wording and options, and the row goes away", async () => {
    const user = userEvent.setup();
    renderTab("inbox");
    const row = await screen.findByRole("listitem", { name: `Choice mapping for ${LABEL}` });
    await user.click(within(row).getByRole("radio", { name: "Within 1 month" }));
    await user.click(within(row).getByRole("radio", { name: "Immediately" }));
    await user.click(within(row).getByRole("button", { name: `Save mapping for ${LABEL}` }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      answer_key: "work.notice",
      label: LABEL,
      options: OPTIONS,
      chosen: ["Immediately"],
    });
    await waitFor(() =>
      expect(screen.queryByRole("listitem", { name: `Choice mapping for ${LABEL}` })).toBeNull(),
    );
  });

  it("a multi-select question takes several options, kept in the form's order", async () => {
    needs = [need({ multi: true })];
    const user = userEvent.setup();
    renderTab("inbox");
    const row = await screen.findByRole("listitem", { name: `Choice mapping for ${LABEL}` });
    expect(within(row).getAllByRole("checkbox")).toHaveLength(3);
    await user.click(within(row).getByRole("checkbox", { name: "More than 1 month" }));
    await user.click(within(row).getByRole("checkbox", { name: "Immediately" }));
    await user.click(within(row).getByRole("button", { name: `Save mapping for ${LABEL}` }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.chosen).toEqual(["Immediately", "More than 1 month"]);
  });

  it("pre-selects an option equal to the answer text but never saves it alone", async () => {
    needs = [need({ answerText: " within 1 MONTH " })];
    renderTab("inbox");
    const row = await screen.findByRole("listitem", { name: `Choice mapping for ${LABEL}` });
    expect(
      (within(row).getByRole("radio", { name: "Within 1 month" }) as HTMLInputElement).checked,
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(saved).toEqual([]);
  });

  it("starts from an earlier pick whose approval was cleared", async () => {
    needs = [need({ picked: ["More than 1 month"] })];
    renderTab("inbox");
    const row = await screen.findByRole("listitem", { name: `Choice mapping for ${LABEL}` });
    expect(
      (within(row).getByRole("radio", { name: "More than 1 month" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("shows no mapping section when nothing needs one", async () => {
    needs = [];
    renderTab("inbox");
    await screen.findByText("No unknown questions.");
    expect(screen.queryByRole("list", { name: "Choice mappings needed" })).toBeNull();
  });
});

describe("Answers: choice mappings", () => {
  it("lists each mapping's question and chosen options, flags a cleared approval", async () => {
    mappings = [
      mapping(),
      mapping({ optionsHash: "h2", normalizedLabel: "other", chosen: ["A", "B"], approved: false }),
    ];
    renderTab("answers");
    const list = await screen.findByRole("list", { name: "Choice mappings for work.notice" });
    expect(within(list).getByText("what is your notice period:")).toBeTruthy();
    expect(within(list).getByText("Within 1 month")).toBeTruthy();
    expect(within(list).getByText("A, B")).toBeTruthy();
    expect(within(list).getAllByText(/needs approval/u)).toHaveLength(1);
  });

  it("removes one mapping", async () => {
    mappings = [mapping()];
    const user = userEvent.setup();
    renderTab("answers");
    await user.click(
      await screen.findByRole("button", {
        name: "Remove mapping what is your notice period for work.notice",
      }),
    );
    await waitFor(() => expect(removed).toHaveLength(1));
    expect(removed[0]).toEqual({
      answer_key: "work.notice",
      label: "what is your notice period",
      options: OPTIONS,
    });
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("list", { name: "Choice mappings for work.notice" }),
        ).queryAllByRole("listitem"),
      ).toHaveLength(0),
    );
  });
});
