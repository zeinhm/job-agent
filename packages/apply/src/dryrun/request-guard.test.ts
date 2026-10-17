import { describe, expect, it } from "vitest";
import {
  ASHBY_READ_ONLY_OPERATIONS,
  classifyRequest,
  describeRequest,
  type GuardPolicy,
} from "./request-guard.ts";

const fixtureAshby: GuardPolicy = { ats: "ashby", fixture: true };
const liveAshby: GuardPolicy = { ats: "ashby", fixture: false };
const fixtureGh: GuardPolicy = { ats: "greenhouse", fixture: true };
const liveGh: GuardPolicy = { ats: "greenhouse", fixture: false };

const gql = (op: string, query: string, operationName = op) =>
  JSON.stringify({ operationName, variables: {}, query });
const ashbyUrl = (op: string, host = "jobs.ashbyhq.com") =>
  `https://${host}/api/non-user-graphql?op=${op}`;

describe("classifyRequest: methods", () => {
  it("allows GET and HEAD", () => {
    expect(classifyRequest({ method: "GET", url: "https://x.test/a", body: null }, liveGh)).toEqual(
      { allow: true },
    );
    expect(
      classifyRequest({ method: "head", url: "https://x.test/a", body: null }, liveGh),
    ).toEqual({ allow: true });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "post"])("aborts %s", (method) => {
    expect(classifyRequest({ method, url: "https://x.test/apply", body: "x" }, liveGh)).toEqual({
      allow: false,
      reason: "method",
    });
  });

  it("aborts a URL it cannot parse", () => {
    expect(classifyRequest({ method: "GET", url: "not a url", body: null }, liveGh).allow).toBe(
      false,
    );
  });
});

describe("classifyRequest: fixture mode", () => {
  it("aborts a GET to any host but 127.0.0.1", () => {
    expect(
      classifyRequest({ method: "GET", url: "https://example.com/", body: null }, fixtureGh),
    ).toEqual({
      allow: false,
      reason: "host",
    });
    expect(
      classifyRequest({ method: "GET", url: "http://localhost:1/", body: null }, fixtureGh),
    ).toEqual({
      allow: false,
      reason: "host",
    });
  });

  it("allows a GET to 127.0.0.1 and data: URLs", () => {
    expect(
      classifyRequest({ method: "GET", url: "http://127.0.0.1:9/f", body: null }, fixtureGh).allow,
    ).toBe(true);
    expect(
      classifyRequest({ method: "GET", url: "data:text/plain,hi", body: null }, fixtureGh).allow,
    ).toBe(true);
  });

  it("does not abort other hosts outside fixture mode (GET only)", () => {
    expect(
      classifyRequest({ method: "GET", url: "https://example.com/", body: null }, liveGh).allow,
    ).toBe(true);
  });
});

describe("classifyRequest: Ashby read-only allowlist", () => {
  const query = "query ApiJobPosting { jobPosting { id } }";

  it("allows an allowlisted query POST on the Ashby host", () => {
    const v = classifyRequest(
      { method: "POST", url: ashbyUrl("ApiJobPosting"), body: gql("ApiJobPosting", query) },
      liveAshby,
    );
    expect(v).toEqual({ allow: true });
  });

  it("allows it on 127.0.0.1 in fixture mode only", () => {
    const url = "http://127.0.0.1:5/api/non-user-graphql?op=ApiJobPosting";
    const body = gql("ApiJobPosting", query);
    expect(classifyRequest({ method: "POST", url, body }, fixtureAshby).allow).toBe(true);
    expect(classifyRequest({ method: "POST", url, body }, liveAshby).allow).toBe(false);
    expect(
      classifyRequest({ method: "POST", url: ashbyUrl("ApiJobPosting"), body }, fixtureAshby).allow,
    ).toBe(false);
  });

  it.each([
    ["a mutation on the list", "ApiJobPosting", "mutation ApiJobPosting { x { ok } }"],
    ["the benign draft mutation", "ApiSetFormValue", "mutation ApiSetFormValue { x { ok } }"],
    [
      "the submit operation",
      "ApiSubmitSingleApplicationFormAction",
      "mutation ApiSubmit { x { ok } }",
    ],
    [
      "a submit hidden in a listed query",
      "ApiJobPosting",
      "query ApiJobPosting { submitApplicationFormAction }",
    ],
    ["an operation not on the list", "ApiGetConsent", "query ApiGetConsent { x }"],
  ])("aborts %s", (_name, op, q) => {
    expect(
      classifyRequest({ method: "POST", url: ashbyUrl(op), body: gql(op, q) }, liveAshby).allow,
    ).toBe(false);
  });

  it("aborts when the body operation differs from ?op=", () => {
    const v = classifyRequest(
      {
        method: "POST",
        url: ashbyUrl("ApiJobPosting"),
        body: gql("ApiJobPosting", query, "ApiSubmitSingleApplicationFormAction"),
      },
      liveAshby,
    );
    expect(v.allow).toBe(false);
  });

  it("aborts a missing, binary, non-JSON or query-less body", () => {
    for (const body of [
      null,
      "not json",
      JSON.stringify({ operationName: "ApiJobPosting" }),
      "[]",
    ]) {
      expect(
        classifyRequest({ method: "POST", url: ashbyUrl("ApiJobPosting"), body }, liveAshby).allow,
      ).toBe(false);
    }
  });

  it("aborts a batch when one entry is not allowed", () => {
    const body = JSON.stringify([
      { operationName: "ApiJobPosting", query },
      { operationName: "ApiJobPosting", query: "mutation M { x }" },
    ]);
    expect(
      classifyRequest({ method: "POST", url: ashbyUrl("ApiJobPosting"), body }, liveAshby).allow,
    ).toBe(false);
  });

  it("aborts the same request for another ATS, another host and another path", () => {
    const body = gql("ApiJobPosting", query);
    expect(
      classifyRequest({ method: "POST", url: ashbyUrl("ApiJobPosting"), body }, liveGh).allow,
    ).toBe(false);
    expect(
      classifyRequest(
        { method: "POST", url: ashbyUrl("ApiJobPosting", "evil.example"), body },
        liveAshby,
      ).allow,
    ).toBe(false);
    expect(
      classifyRequest(
        { method: "POST", url: "https://jobs.ashbyhq.com/other?op=ApiJobPosting", body },
        liveAshby,
      ).allow,
    ).toBe(false);
  });
});

describe("Ashby allowlist is pinned", () => {
  it("holds exactly the five operations of decision D2 note (2)", () => {
    const expected = [
      "ApiOrganizationFromHostedJobsPageName",
      "ApiJobPosting",
      "ApiJobPostingForApplicationRequest",
      "ApiAutocompleteGeoLocation",
      "ApiSearchSchoolByCanonicalName",
    ];
    expect(ASHBY_READ_ONLY_OPERATIONS.size).toBe(5);
    expect([...ASHBY_READ_ONLY_OPERATIONS].sort()).toEqual([...expected].sort());
  });

  it.each(["ApiSetFormValue", "ApiSubmitSingleApplicationFormAction", "ApiSomethingUnknown"])(
    "aborts %s even when the body has no mutation keyword",
    (op) => {
      const body = gql(op, `query ${op} { x { id } }`);
      expect(classifyRequest({ method: "POST", url: ashbyUrl(op), body }, liveAshby).allow).toBe(
        false,
      );
      expect(
        classifyRequest(
          { method: "POST", url: `http://127.0.0.1:5/api/non-user-graphql?op=${op}`, body },
          fixtureAshby,
        ).allow,
      ).toBe(false);
    },
  );
});

describe("describeRequest", () => {
  it("keeps method, host and path only (no query string, no body)", () => {
    const r = describeRequest(
      "request",
      "post",
      "https://boards.example.com/co/jobs/1?token=secret#x",
      "method",
    );
    expect(r).toEqual({
      kind: "request",
      method: "POST",
      host: "boards.example.com",
      path: "/co/jobs/1",
      reason: "method",
    });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
