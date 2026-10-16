import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, postings, type Db, type NewPosting, type Posting } from "@job-agent/core";
import { normalizePending } from "../normalize/index.ts";
import { dedupePending, locationWithCountries, regionRank, unionCountries } from "./index.ts";

describe("same-source variants", () => {
  let db: Db;
  let n = 0;
  const minute = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();

  function offer(
    title: string,
    text: string,
    country: string | null,
    opts: { id?: string; minute?: number; source?: string; company?: string; slug?: string } = {},
  ) {
    n += 1;
    const id = opts.id ?? `v${n}`;
    const row: NewPosting = {
      id,
      source: opts.source ?? "recruitee",
      external_id: `e${n}`,
      url: `https://acme.recruitee.com/o/${opts.slug ?? `job-${n}`}`,
      title,
      company_name: opts.company ?? "Acme",
      location_text: "Remote job",
      country,
      description_text: text,
      content_hash: `h-${text}-${title}`,
      first_seen_at: minute(opts.minute ?? n),
      last_seen_at: minute(opts.minute ?? n),
    };
    db.insert(postings).values(row).run();
    return id;
  }

  function run() {
    normalizePending(db);
    return dedupePending(db);
  }

  const canonicals = () =>
    Object.fromEntries(
      db
        .select()
        .from(postings)
        .all()
        .map((p) => [p.id, p.canonical_posting_id]),
    );
  const applyUrl = (id: string) =>
    db.select().from(postings).where(eq(postings.id, id)).get()?.apply_url ?? null;

  beforeEach(() => {
    db = openDb(":memory:");
    n = 0;
  });

  it("links per-country variants with identical text; the earliest is canonical", () => {
    const uk = offer("Product Lead (QVAC)", "same text", "United Kingdom", { id: "uk" });
    const india = offer("Product Lead (QVAC)", "same text", "India", { id: "in" });
    const spain = offer("Product Lead (QVAC)", "same text", "Spain", { id: "es" });
    run();
    expect(canonicals()).toEqual({ [uk]: null, [india]: uk, [spain]: uk });
    expect(db.select().from(postings).all()).toHaveLength(3);
  });

  it("links variants that were hashed before this rule existed", () => {
    const a = offer("Product Lead", "same text", "Spain", { id: "a" });
    const b = offer("Product Lead", "same text", "India", { id: "b" });
    run();
    db.update(postings).set({ canonical_posting_id: null }).run();
    expect(run()).toBe(0);
    expect(canonicals()).toEqual({ [a]: null, [b]: a });
  });

  it("never links the same title with different text", () => {
    const a = offer("Product Lead", "text one", "Spain");
    const b = offer("Product Lead", "text two", "India");
    run();
    expect(canonicals()).toEqual({ [a]: null, [b]: null });
  });

  it("never links 'Frontend' and 'Senior Frontend', even with identical text", () => {
    const a = offer("Frontend Engineer", "same text", "Spain");
    const b = offer("Senior Frontend Engineer", "same text", "Spain");
    run();
    expect(canonicals()).toEqual({ [a]: null, [b]: null });
  });

  it("never links across companies or beyond the merge window", () => {
    const a = offer("Product Lead", "same text", "Spain", { company: "Acme" });
    const b = offer("Product Lead", "same text", "Spain", { company: "Globex" });
    const c = offer("Product Lead", "same text", "India", { minute: 61 * 24 * 60 });
    run();
    expect(canonicals()).toEqual({ [a]: null, [b]: null, [c]: null });
  });

  it("unlinks a variant whose text was edited and keeps the others linked", () => {
    const a = offer("Product Lead", "same text", "Spain", { id: "a" });
    const b = offer("Product Lead", "same text", "India", { id: "b" });
    const c = offer("Product Lead", "same text", "Italy", { id: "c" });
    run();
    expect(canonicals()).toEqual({ [a]: null, [b]: a, [c]: a });
    db.update(postings).set({ content_hash: "edited" }).where(eq(postings.id, "c")).run();
    run();
    expect(canonicals()).toEqual({ [a]: null, [b]: a, [c]: null });
  });

  it("a canonical posting whose text was edited lets the others regroup", () => {
    const a = offer("Product Lead", "same text", "Spain", { id: "a" });
    const b = offer("Product Lead", "same text", "India", { id: "b" });
    const c = offer("Product Lead", "same text", "Italy", { id: "c" });
    run();
    db.update(postings).set({ content_hash: "edited" }).where(eq(postings.id, "a")).run();
    run();
    expect(canonicals()).toEqual({ [a]: null, [b]: null, [c]: b });
  });

  it("a new identical variant joins the existing group on a later run", () => {
    const a = offer("Product Lead", "same text", "Spain", { id: "a" });
    const b = offer("Product Lead", "same text", "India", { id: "b" });
    run();
    const c = offer("Product Lead", "same text", "Italy", { id: "c" });
    run();
    expect(canonicals()).toEqual({ [a]: null, [b]: a, [c]: a });
  });

  it("a cross-source copy and same-source variants end in one group under the ATS posting", () => {
    const a = offer("Product Lead", "same text", "Spain", { id: "a" });
    const b = offer("Product Lead", "same text", "India", { id: "b" });
    const l = offer("Product Lead", "other text", null, { id: "l", source: "linkedin" });
    run();
    expect(canonicals()).toEqual({ [a]: null, [b]: a, [l]: a });
  });

  it("is idempotent", () => {
    offer("Product Lead", "same text", "Spain");
    offer("Product Lead", "same text", "India");
    run();
    const before = db.select().from(postings).all();
    run();
    expect(db.select().from(postings).all()).toEqual(before);
  });

  it("the union of the variants' countries: own country first, no repeats", () => {
    offer("Product Lead", "same text", "United Kingdom", { id: "uk" });
    offer("Product Lead", "same text", "India", { id: "in" });
    offer("Product Lead", "same text", "india", { id: "in2" });
    run();
    const head = db.select().from(postings).where(eq(postings.id, "uk")).get() as Posting;
    expect(unionCountries(db, head)).toEqual(["United Kingdom", "India"]);
    expect(locationWithCountries("Remote job", ["United Kingdom", "India"])).toBe(
      "Remote job; Countries: United Kingdom, India",
    );
    expect(locationWithCountries("Remote job, India", ["India"])).toBe("Remote job, India");
    expect(locationWithCountries(null, [])).toBeNull();
  });

  it("an Indonesia variant becomes the apply link, even when it arrived later", () => {
    const uk = offer("Product Lead", "same text", "United Kingdom", { id: "uk", slug: "uk" });
    offer("Product Lead", "same text", "India", { id: "in", slug: "india" });
    run();
    expect(applyUrl(uk)).toBeNull();
    offer("Product Lead", "same text", "Indonesia", { id: "id", slug: "indonesia" });
    run();
    expect(applyUrl(uk)).toBe("https://acme.recruitee.com/o/indonesia");
    run();
    expect(applyUrl(uk)).toBe("https://acme.recruitee.com/o/indonesia");
  });

  it("keeps the canonical apply link when it is already for Indonesia", () => {
    const id = offer("Product Lead", "same text", "Indonesia", { id: "id", slug: "indonesia" });
    offer("Product Lead", "same text", "Asia", { id: "asia", slug: "asia" });
    run();
    expect(applyUrl(id)).toBeNull();
  });

  it("ranks Indonesia over APAC over worldwide, other countries none", () => {
    expect(regionRank("Indonesia")).toBe(0);
    expect(regionRank("Asia")).toBe(1);
    expect(regionRank("APAC")).toBe(1);
    expect(regionRank("Worldwide")).toBe(2);
    expect(regionRank("India")).toBeNull();
    expect(regionRank(null)).toBeNull();
  });
});
