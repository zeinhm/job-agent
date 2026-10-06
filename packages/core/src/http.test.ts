import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { httpGet, httpGetJson, httpGetText, HttpError, __testInjectTimeAndSleep } from "./http.ts";
import { setupServer, http, HttpResponse } from "./test-utils.ts";

// Set up a fake clock and sleep for tests
const fakeTime = { now: 0 };
let sleep: (ms: number) => Promise<void>;

beforeEach(() => {
  fakeTime.now = 0;
  sleep = async (ms) => {
    fakeTime.now += ms;
  };

  // Inject fake time and sleep
  __testInjectTimeAndSleep(() => new Date(fakeTime.now), sleep);
});

describe("httpGet", () => {
  let server: ReturnType<typeof setupServer>;

  beforeEach(() => {
    server = setupServer(
      http.get("https://example.com/api/success", () => HttpResponse.json({ success: true })),
    );
    server.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    server.close();
  });

  it("should make a successful GET request", async () => {
    const response = await httpGet("https://example.com/api/success");
    expect(response.ok).toBe(true);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.success).toBe(true);
  });

  it("should throw HttpError on 404", async () => {
    server.use(
      http.get("https://example.com/notfound", () => HttpResponse.json(null, { status: 404 })),
    );

    await expect(httpGet("https://example.com/notfound")).rejects.toThrow(HttpError);
  });

  it("should respect User-Agent header", async () => {
    let capturedUserAgent: string | null = null;
    server.use(
      http.get("https://example.com/test", ({ request }) => {
        capturedUserAgent = request.headers.get("User-Agent");
        return HttpResponse.json({});
      }),
    );

    await httpGet("https://example.com/test");
    expect(capturedUserAgent).toMatch(/job-agent\/0\.1/);
  });

  it("should redact sensitive query params in URL", async () => {
    const url = "https://example.com/api?token=abc123&key=xyz789&data=ok";
    const error = new HttpError(url, 404);
    expect(error.message).toContain("token=REDACTED");
    expect(error.message).toContain("key=REDACTED");
    expect(error.message).not.toContain("abc123");
    expect(error.message).not.toContain("xyz789");
    expect(error.message).toContain("data=ok");
  });

  it("should redact uppercase query param names", async () => {
    const url = "https://example.com/api?TOKEN=secret123&KEY=secret456&data=ok";
    const error = new HttpError(url, 404);
    expect(error.message).toContain("TOKEN=REDACTED");
    expect(error.message).toContain("KEY=REDACTED");
    expect(error.message).not.toContain("secret123");
    expect(error.message).not.toContain("secret456");
    expect(error.message).toContain("data=ok");
  });

  it("should redact mixed-case query param names", async () => {
    const url =
      "https://example.com/api?ToKeN=secret1&AcCeSs_ToKeN=secret2&Api_Key=secret3&data=ok";
    const error = new HttpError(url, 404);
    expect(error.message).toContain("ToKeN=REDACTED");
    expect(error.message).toContain("AcCeSs_ToKeN=REDACTED");
    expect(error.message).toContain("Api_Key=REDACTED");
    expect(error.message).not.toContain("secret1");
    expect(error.message).not.toContain("secret2");
    expect(error.message).not.toContain("secret3");
    expect(error.message).toContain("data=ok");
  });

  it("should throw before making request if minIntervalMs is too small", async () => {
    await expect(httpGet("https://example.com/test", { minIntervalMs: 500 })).rejects.toThrow(
      /minIntervalMs must be at least 1000/,
    );
  });
});

describe("Rate limiting", () => {
  let server: ReturnType<typeof setupServer>;

  beforeEach(() => {
    server = setupServer(
      http.get("https://host1.com/api", () => HttpResponse.json({ success: true })),
      http.get("https://host2.com/api", () => HttpResponse.json({ success: true })),
      http.get("https://host3.com/api", () => HttpResponse.json({ success: true })),
    );
    server.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    server.close();
  });

  it("should delay sequential requests to the same host", async () => {
    await httpGet("https://host1.com/api");
    const time1 = fakeTime.now;
    await httpGet("https://host1.com/api");
    const time2 = fakeTime.now;

    expect(time2 - time1).toBeGreaterThanOrEqual(2000); // second request is delayed
  });

  it("should not delay requests to different hosts", async () => {
    // Start both requests in parallel
    const p1 = httpGet("https://host1.com/api").then(() => fakeTime.now);
    const p2 = httpGet("https://host2.com/api").then(() => fakeTime.now);

    const [time1, time2] = await Promise.all([p1, p2]);

    // Both should complete roughly at the same time (no delay between them)
    expect(Math.abs(time1 - time2)).toBeLessThan(100);
  });

  it("should queue 5 concurrent requests and execute them sequentially", async () => {
    // Track when each request actually completes by wrapping the handler
    const completionTimes: (number | undefined)[] = [];
    let handlerCallCount = 0;

    server.use(
      http.get("https://host1.com/api", () => {
        handlerCallCount++;
        const callNumber = handlerCallCount;
        completionTimes[callNumber - 1] = fakeTime.now;
        return HttpResponse.json({ success: true });
      }),
    );

    // Start 5 requests in parallel
    const promises = Array.from({ length: 5 }, () => httpGet("https://host1.com/api"));
    await Promise.all(promises);

    expect(completionTimes).toHaveLength(5);
    expect(completionTimes.every((t) => t !== undefined)).toBe(true);

    // Type assertion: after the every() check passes, treat as number[]
    const times: number[] = completionTimes as number[];
    for (let i = 1; i < times.length; i++) {
      const prev = times[i - 1];
      const curr = times[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr - prev).toBeGreaterThanOrEqual(2000);
      }
    }
  });

  it("should allow custom minIntervalMs", async () => {
    const startTime = fakeTime.now;
    await httpGet("https://host3.com/api", { minIntervalMs: 5000 });
    const time1 = fakeTime.now;
    await httpGet("https://host3.com/api", { minIntervalMs: 5000 });
    const time2 = fakeTime.now;

    expect(time1 - startTime).toBeLessThan(100); // first request is immediate
    expect(time2 - time1).toBeGreaterThanOrEqual(5000); // second request is delayed
  });
});

describe("Retries", () => {
  let server: ReturnType<typeof setupServer>;
  let attemptCount = 0;

  beforeEach(() => {
    attemptCount = 0;
  });

  afterEach(() => {
    server.close();
  });

  it("should retry on 503 and eventually succeed", async () => {
    server = setupServer(
      http.get("https://retry-test.com/api", () => {
        attemptCount++;
        if (attemptCount < 3) {
          return HttpResponse.json(null, { status: 503 });
        }
        return HttpResponse.json({ success: true });
      }),
    );
    server.listen({ onUnhandledRequest: "error" });

    const response = await httpGet("https://retry-test.com/api");
    expect(attemptCount).toBe(3);
    expect(response.ok).toBe(true);
  });

  it("should throw after 2 retries if all fail with 503", async () => {
    server = setupServer(
      http.get("https://retry-fail.com/api", () => {
        attemptCount++;
        return HttpResponse.json(null, { status: 503 });
      }),
    );
    server.listen({ onUnhandledRequest: "error" });

    await expect(httpGet("https://retry-fail.com/api")).rejects.toThrow(HttpError);
    expect(attemptCount).toBe(3); // 1 initial + 2 retries
  });

  it("should not retry on 404", async () => {
    server = setupServer(
      http.get("https://no-retry.com/api", () => {
        attemptCount++;
        return HttpResponse.json(null, { status: 404 });
      }),
    );
    server.listen({ onUnhandledRequest: "error" });

    await expect(httpGet("https://no-retry.com/api")).rejects.toThrow(HttpError);
    expect(attemptCount).toBe(1); // No retries
  });

  it("should honor Retry-After header with seconds", async () => {
    server = setupServer(
      http.get("https://retry-after.com/api", () => {
        attemptCount++;
        if (attemptCount === 1) {
          return HttpResponse.json(null, {
            status: 429,
            headers: { "Retry-After": "5" },
          });
        }
        return HttpResponse.json({ success: true });
      }),
    );
    server.listen({ onUnhandledRequest: "error" });

    const timeBefore = fakeTime.now;
    const response = await httpGet("https://retry-after.com/api");
    expect(response.ok).toBe(true);
    expect(fakeTime.now - timeBefore).toBeGreaterThanOrEqual(5000);
  });

  it("should cap Retry-After at 60 seconds", async () => {
    server = setupServer(
      http.get("https://retry-after-cap.com/api", () => {
        attemptCount++;
        if (attemptCount === 1) {
          return HttpResponse.json(null, {
            status: 429,
            headers: { "Retry-After": "3600" },
          });
        }
        return HttpResponse.json({ success: true });
      }),
    );
    server.listen({ onUnhandledRequest: "error" });

    const timeBefore = fakeTime.now;
    const response = await httpGet("https://retry-after-cap.com/api");
    expect(response.ok).toBe(true);
    const elapsed = fakeTime.now - timeBefore;
    expect(elapsed).toBeGreaterThanOrEqual(60000);
    // Allow some buffer for exponential backoff, but it should be capped at 60
    expect(elapsed).toBeLessThanOrEqual(62000);
  });
});

describe("httpGetJson and httpGetText", () => {
  let server: ReturnType<typeof setupServer>;

  beforeEach(() => {
    server = setupServer(
      http.get("https://json-test.com/api", () => HttpResponse.json({ data: "test" })),
      http.get("https://text-test.com/api", () => HttpResponse.text("plain text response")),
    );
    server.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    server.close();
  });

  it("should parse JSON response", async () => {
    const data = await httpGetJson("https://json-test.com/api");
    expect(data).toEqual({ data: "test" });
  });

  it("should return text response", async () => {
    const text = await httpGetText("https://text-test.com/api");
    expect(text).toBe("plain text response");
  });
});

describe("Break-the-code: minIntervalMs = 0", () => {
  it("should fail when minIntervalMs is 0", async () => {
    await expect(httpGet("https://example.com/test", { minIntervalMs: 0 })).rejects.toThrow(
      /minIntervalMs must be at least 1000/,
    );
  });
});
