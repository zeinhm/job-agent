// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnswersTab } from "./components/AnswersTab.tsx";
import type { Answer, AnswerPatchBody, NewAnswerBody } from "./api.ts";

const BASE = "http://localhost:3000";

function answer(over: Partial<Answer> & { key: string }): Answer {
  return {
    group: over.key.split(".")[0] ?? "",
    question: null,
    answer: "FAKE-ANSWER",
    type: "text",
    choices: null,
    alternatives: null,
    approved: false,
    approvedAt: null,
    source: "config",
    updatedAt: "2026-10-16T09:00:00.000Z",
    ...over,
  };
}

let store: Answer[];
let patches: { key: string; body: AnswerPatchBody }[];
let created: NewAnswerBody[];
let exports: number;
beforeEach(() => {
  patches = [];
  created = [];
  exports = 0;
  store = [
    answer({
      key: "links.site",
      answer: "https://example.com",
      approved: true,
      approvedAt: "x",
    }),
    answer({
      key: "work_setup.notice",
      question: "What is your notice period?",
      alternatives: ["When can you start?"],
    }),
    answer({ key: "work_setup.timezone", answer: "FAKE-UTC+7" }),
  ];
});

const server = setupServer(
  http.get(`${BASE}/api/answers`, () => HttpResponse.json({ answers: store })),
  http.patch(`${BASE}/api/answers/:key`, async ({ params, request }) => {
    const key = String(params.key);
    const body = (await request.json()) as AnswerPatchBody;
    patches.push({ key, body });
    const prev = store.find((a) => a.key === key);
    if (prev === undefined) return HttpResponse.json({ error: "not found" }, { status: 404 });
    // Mirrors the server rule: new text clears approval unless the request approves.
    const textChanged = body.answer !== undefined && body.answer !== prev.answer;
    const next: Answer = {
      ...prev,
      ...(body.answer !== undefined ? { answer: body.answer } : {}),
      ...(body.question !== undefined ? { question: body.question } : {}),
      ...(body.alternatives !== undefined ? { alternatives: body.alternatives } : {}),
      approved: body.approved ?? (textChanged ? false : prev.approved),
      source: "dashboard",
      updatedAt: `2026-10-16T10:00:0${patches.length}.000Z`,
    };
    store = store.map((a) => (a.key === key ? next : a));
    return HttpResponse.json(next);
  }),
  http.post(`${BASE}/api/answers/export`, () => {
    exports += 1;
    return HttpResponse.json({
      path: "/tmp/data/exports/answers-2026-10-16.yaml",
      count: store.length,
    });
  }),
  http.post(`${BASE}/api/answers`, async ({ request }) => {
    const body = (await request.json()) as NewAnswerBody;
    created.push(body);
    const row = answer({
      key: `${body.group}.${body.key}`,
      answer: body.answer,
      source: "dashboard",
    });
    store = [...store, row];
    return HttpResponse.json(row, { status: 201 });
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
      <AnswersTab />
    </QueryClientProvider>,
  );
}

describe("Answers tab", () => {
  it("lists answers grouped by group with one heading per group", async () => {
    renderTab();
    await screen.findByRole("table", { name: "Answers" });
    const headings = screen.getAllByRole("columnheader", { name: /^(links|work_setup)$/ });
    expect(headings.map((h) => h.textContent)).toEqual(["links", "work_setup"]);
    expect(screen.getByText("What is your notice period?")).toBeTruthy();
    expect(screen.getByText("https://example.com")).toBeTruthy();
  });

  it("filters to answers that are not approved", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("table", { name: "Answers" });
    await user.click(screen.getByRole("checkbox", { name: "Not approved only" }));
    expect(screen.queryByText("https://example.com")).toBeNull();
    expect(screen.getAllByRole("columnheader", { name: "work_setup" })).toHaveLength(1);
    expect(screen.queryByRole("columnheader", { name: "links" })).toBeNull();
  });

  it("toggles approval with a PATCH", async () => {
    const user = userEvent.setup();
    renderTab();
    const box = await screen.findByRole("checkbox", { name: "Approved work_setup.timezone" });
    await user.click(box);
    await waitFor(() =>
      expect(patches).toEqual([{ key: "work_setup.timezone", body: { approved: true } }]),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("checkbox", { name: "Approved work_setup.timezone" }) as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
  });

  it("edits an answer inline; the saved text clears approval", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Edit links.site" }));
    const box = screen.getByRole("textbox", { name: "Answer for links.site" });
    await user.clear(box);
    await user.type(box, "https://example.org");
    await user.click(screen.getByRole("button", { name: "Save links.site" }));
    await waitFor(() =>
      expect(patches).toEqual([
        { key: "links.site", body: { answer: "https://example.org", question: null } },
      ]),
    );
    await screen.findByText("https://example.org");
    expect(
      (screen.getByRole("checkbox", { name: "Approved links.site" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("adds and removes alternatives", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.type(
      await screen.findByRole("textbox", { name: "New alternative for work_setup.notice" }),
      "Notice?",
    );
    await user.click(screen.getByRole("button", { name: "Add alternative to work_setup.notice" }));
    await waitFor(() =>
      expect(patches).toEqual([
        {
          key: "work_setup.notice",
          body: { alternatives: ["When can you start?", "Notice?"] },
        },
      ]),
    );
    const list = await screen.findByRole("list", { name: "Alternatives for work_setup.notice" });
    await within(list).findByText("Notice?");
    await user.click(
      screen.getByRole("button", { name: "Remove alternative When can you start?" }),
    );
    await waitFor(() =>
      expect(patches[1]).toEqual({
        key: "work_setup.notice",
        body: { alternatives: ["Notice?"] },
      }),
    );
  });

  it("exports and shows only the path and count", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Export YAML" }));
    const status = await screen.findByRole("status");
    expect(exports).toBe(1);
    expect(status.textContent).toBe(
      "Exported 3 answers to /tmp/data/exports/answers-2026-10-16.yaml",
    );
  });

  it("adds a new answer without approving it", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.type(await screen.findByRole("textbox", { name: "New group" }), "links");
    await user.type(screen.getByRole("textbox", { name: "New key" }), "blog");
    await user.type(screen.getByRole("textbox", { name: "New answer" }), "https://example.net");
    await user.click(screen.getByRole("button", { name: "Add answer" }));
    await waitFor(() =>
      expect(created).toEqual([{ group: "links", key: "blog", answer: "https://example.net" }]),
    );
    await screen.findByText("https://example.net");
  });

  it("shows an error when saving fails", async () => {
    server.use(
      http.patch(`${BASE}/api/answers/:key`, () =>
        HttpResponse.json({ error: "internal error" }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("checkbox", { name: "Approved work_setup.timezone" }));
    await screen.findByRole("alert");
  });
});
