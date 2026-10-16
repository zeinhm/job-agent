import { SourceBlockedError, SourceError, SourceSkippedError } from "@job-agent/core";
import { describe, expect, it } from "vitest";
import { createLinkedInDetailFetcher } from "./details.ts";
import type { DetailRunner, WorkerDetails } from "./worker.ts";

function fetcherFor(exitCode: number, lines: unknown[], seen: WorkerDetails[] = []) {
  const runWorker: DetailRunner = (details) => {
    seen.push(details);
    return Promise.resolve({
      exitCode,
      stdout: lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
    });
  };
  return createLinkedInDetailFetcher({ runWorker });
}

describe("LinkedIn detail fetcher", () => {
  it("asks the worker for exactly one id, with the li- prefix, in details mode", async () => {
    const seen: WorkerDetails[] = [];
    await fetcherFor(0, [{ id: "li-123456", description: "Fake text" }], seen)("123456");
    expect(seen).toEqual([{ mode: "details", site: "linkedin", job_ids: ["li-123456"] }]);
  });

  it("returns the description of the id", async () => {
    const r = await fetcherFor(0, [{ id: "li-123456", description: "Fake text" }])("123456");
    expect(r).toEqual({ kind: "ok", description: "Fake text" });
  });

  it("returns a per-id failure when the worker reports one, or prints nothing for the id", async () => {
    expect(await fetcherFor(0, [{ id: "li-123456", error: "no description" }])("123456")).toEqual({
      kind: "failed",
      reason: "no description",
    });
    expect(await fetcherFor(0, [])("123456")).toMatchObject({ kind: "failed" });
    expect(
      await fetcherFor(0, ["not json", { id: "li-999999", description: "x" }])("123456"),
    ).toMatchObject({ kind: "failed" });
  });

  it("throws SourceBlockedError for the blocked kind (exit 2)", async () => {
    await expect(
      fetcherFor(2, [{ error: "LinkedIn response status code 429", kind: "blocked" }])("123456"),
    ).rejects.toBeInstanceOf(SourceBlockedError);
  });

  it("throws a plain SourceError for a worker failure, never a per-id result", async () => {
    const err = await fetcherFor(2, [
      { error: "JobSpy has no LinkedIn detail call", kind: "error" },
    ])("123456").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).not.toBeInstanceOf(SourceBlockedError);
    await expect(fetcherFor(1, [])("123456")).rejects.toThrow("exited 1");
  });

  it("is refused under the test runner unless a spawn function is injected", async () => {
    await expect(createLinkedInDetailFetcher()("123456")).rejects.toBeInstanceOf(
      SourceSkippedError,
    );
  });
});
