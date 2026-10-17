// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InboxTab } from "./components/InboxTab.tsx";
import type { Answer, InboxAnswerBody, InboxItem } from "./api.ts";

const BASE = "http://localhost:3000";

function item(over: Partial<InboxItem> & { id: string; label: string }): InboxItem {
  return {
    postingCount: 2,
    firstSeenAt: "2026-10-13T00:00:00.000Z",
    lastSeenAt: "2026-10-14T00:00:00.000Z",
    salary: false,
    examples: [{ postingId: "p1", title: "Engineer", company: "Acme" }],
    ...over,
  };
}

const visa: Answer = {
  key: "work_setup.needs_visa_sponsorship",
  group: "work_setup",
  question: "Do you need visa sponsorship?",
  answer: "FAKE-ANSWER",
  type: "text",
  choices: null,
  alternatives: null,
  approved: true,
  approvedAt: "2026-10-16T00:00:00.000Z",
  source: "dashboard",
  updatedAt: "2026-10-16T00:00:00.000Z",
};
const notice: Answer = { ...visa, key: "work_setup.notice_period", question: "Notice period?" };

let items: InboxItem[];
let calls: { kind: string; id: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  items = [
    item({ id: "u1", label: "Open to remote work?", postingCount: 3 }),
    item({ id: "u2", label: "Work permit?" }),
    item({ id: "u3", label: "Expected salary?", salary: true }),
  ];
});

const server = setupServer(
  http.get(`${BASE}/api/inbox`, () =>
    HttpResponse.json({ openCount: items.length, items, mappings: [] }),
  ),
  http.get(`${BASE}/api/answers`, () => HttpResponse.json({ answers: [visa, notice] })),
  ...(["answer", "link", "dismiss"] as const).map((kind) =>
    http.post(`${BASE}/api/inbox/:id/${kind}`, async ({ params, request }) => {
      const id = String(params.id);
      calls.push({ kind, id, body: await request.json() });
      items = items.filter((i) => i.id !== id);
      return HttpResponse.json({ openCount: items.length, key: null });
    }),
  ),
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
      <InboxTab />
    </QueryClientProvider>,
  );
}

describe("Inbox tab", () => {
  it("lists the open wordings with count and example postings", async () => {
    renderTab();
    const list = await screen.findByRole("list", { name: "Unknown questions" });
    expect(within(list).getByText("Open to remote work?")).toBeTruthy();
    expect(within(list).getByText("asked by 3 postings")).toBeTruthy();
    expect(within(list).getAllByText("asked by 2 postings")).toHaveLength(2);
    expect(screen.getAllByText("Engineer at Acme").length).toBe(3);
    expect(screen.getByRole("status").textContent).toBe("Open questions: 3");
  });

  it("a salary question says it is answered by the tier ask and has no answer form", async () => {
    renderTab();
    const row = await screen.findByRole("listitem", { name: "Expected salary?" });
    expect(within(row).getByText("Answered by the tier ask, stays in review.")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Answer /u })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Link /u })).toBeNull();
    expect(within(row).getByRole("button", { name: "Dismiss Expected salary?" })).toBeTruthy();
  });

  it("renders no answer form and no link picker for any salary row, even after clicking around", async () => {
    items = [
      item({ id: "s1", label: "How much do you expect to be paid?", salary: true }),
      item({ id: "s2", label: "Berapa gaji yang Anda harapkan?", salary: true }),
    ];
    renderTab();
    for (const label of items.map((i) => i.label)) {
      const row = await screen.findByRole("listitem", { name: label });
      expect(within(row).getByText("Answered by the tier ask, stays in review.")).toBeTruthy();
      expect(within(row).queryByRole("button", { name: /Answer|Link/u })).toBeNull();
    }
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByLabelText("Search answers")).toBeNull();
  });

  it("answers a yes/no question with a select and approve ticked", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Answer Open to remote work?" }));
    const save = screen.getByRole("button", { name: "Save answer" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Group for Open to remote work?"), "work_setup");
    await user.type(screen.getByLabelText("Key for Open to remote work?"), "remote");
    await user.selectOptions(screen.getByLabelText("Type for Open to remote work?"), "yes_no");
    await user.selectOptions(screen.getByLabelText("Answer for Open to remote work?"), "yes");
    await user.click(screen.getByLabelText("Approve for Open to remote work?"));
    await user.click(save);
    await waitFor(() =>
      expect(calls).toEqual([
        {
          kind: "answer",
          id: "u1",
          body: {
            group: "work_setup",
            key: "remote",
            type: "yes_no",
            answer: "yes",
            approved: true,
          },
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByText("Open to remote work?")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Open questions: 2");
  });

  it("is not approved unless ticked", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Answer Work permit?" }));
    await user.type(screen.getByLabelText("Group for Work permit?"), "legal");
    await user.type(screen.getByLabelText("Key for Work permit?"), "permit");
    await user.type(screen.getByLabelText("Answer for Work permit?"), "FAKE-ANSWER-none");
    await user.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]?.body as InboxAnswerBody).approved).toBe(false);
    expect((calls[0]?.body as InboxAnswerBody).type).toBe("text");
  });

  it("number needs a number; choice needs one of the listed choices", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Answer Work permit?" }));
    await user.type(screen.getByLabelText("Group for Work permit?"), "g");
    await user.type(screen.getByLabelText("Key for Work permit?"), "k");
    const save = screen.getByRole("button", { name: "Save answer" }) as HTMLButtonElement;

    await user.selectOptions(screen.getByLabelText("Type for Work permit?"), "number");
    const num = screen.getByLabelText("Answer for Work permit?");
    expect((num as HTMLInputElement).type).toBe("number");
    await user.type(num, "30");
    expect(save.disabled).toBe(false);
    await user.clear(num);
    expect(save.disabled).toBe(true);

    await user.selectOptions(screen.getByLabelText("Type for Work permit?"), "choice");
    await user.type(screen.getByLabelText("Choices for Work permit?"), "red, blue");
    await user.selectOptions(screen.getByLabelText("Answer for Work permit?"), "blue");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() =>
      expect(calls[0]?.body).toEqual({
        group: "g",
        key: "k",
        type: "choice",
        answer: "blue",
        choices: ["red", "blue"],
        approved: false,
      }),
    );
  });

  it("links to an existing answer picked with the search box", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(
      await screen.findByRole("button", { name: "Link Work permit? to an existing answer" }),
    );
    expect(
      await screen.findByRole("button", { name: "Link to work_setup.notice_period" }),
    ).toBeTruthy();
    await user.type(screen.getByLabelText("Search answers"), "visa");
    expect(screen.queryByRole("button", { name: "Link to work_setup.notice_period" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Link to work_setup.needs_visa_sponsorship" }),
    );
    await waitFor(() =>
      expect(calls).toEqual([
        { kind: "link", id: "u2", body: { key: "work_setup.needs_visa_sponsorship" } },
      ]),
    );
    await waitFor(() => expect(screen.queryByText("Work permit?")).toBeNull());
  });

  it("the link picker says that linking clears the answer's approval", async () => {
    const user = userEvent.setup();
    renderTab();
    expect(screen.queryByText(/clears its approval/)).toBeNull();
    await user.click(
      await screen.findByRole("button", { name: "Link Work permit? to an existing answer" }),
    );
    expect(
      await screen.findByText(
        "Linking adds this wording to the answer and clears its approval until you approve it again.",
      ),
    ).toBeTruthy();
  });

  it("says so when the search finds nothing", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(
      await screen.findByRole("button", { name: "Link Work permit? to an existing answer" }),
    );
    await user.type(screen.getByLabelText("Search answers"), "zzz");
    expect(screen.getByText("No matching answers.")).toBeTruthy();
  });

  it("dismisses and shows the new open count", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Dismiss Work permit?" }));
    await waitFor(() => expect(calls).toEqual([{ kind: "dismiss", id: "u2", body: {} }]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Open questions: 2"));
  });

  it("shows an alert when an action fails and keeps the row", async () => {
    server.use(
      http.post(`${BASE}/api/inbox/:id/dismiss`, () =>
        HttpResponse.json({ error: "not open" }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Dismiss Work permit?" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That action could not be saved.");
    expect(screen.getByText("Work permit?")).toBeTruthy();
  });

  it("shows the empty state", async () => {
    items = [];
    renderTab();
    expect(await screen.findByText("No unknown questions.")).toBeTruthy();
  });
});
