import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, openDb, postings, type Db, type NewPosting } from "@job-agent/core";
import {
  cleanLine,
  cleanUrl,
  htmlToText,
  normalizeCompanyName,
  normalizePending,
} from "./index.ts";

describe("htmlToText", () => {
  it("handles nested lists", () => {
    const out = htmlToText(
      "<ul><li>One<ul><li>Nested A</li><li>Nested B</li></ul></li><li>Two</li></ul>",
    );
    expect(out.split("\n")).toEqual(["* One", "* Nested A", "* Nested B", "* Two"]);
  });

  it("turns <br> into line breaks and keeps paragraph breaks", () => {
    expect(htmlToText("<p>First  line<br>second   line</p><p>Next paragraph</p>")).toBe(
      "First line\nsecond line\n\nNext paragraph",
    );
  });

  it("decodes entities", () => {
    expect(htmlToText("<p>R&amp;D&nbsp;team &#39;core&#39;</p>")).toBe("R&D team 'core'");
  });

  it("removes script and style content", () => {
    const out = htmlToText(
      "<style>.a{color:red}</style><p>Hello</p><script>alert('x')</script><p>World</p>",
    );
    expect(out).toBe("Hello\n\nWorld");
  });

  it("parses entity-escaped HTML (Greenhouse content)", () => {
    const out = htmlToText(
      "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;GitLab &amp;amp; friends&lt;/p&gt;\n&lt;p&gt;Second&nbsp;para&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;",
    );
    expect(out).toBe("GitLab & friends\n\nSecond para\n\n* One");
  });

  it("keeps double-escaped markup literal", () => {
    expect(htmlToText("a &amp;lt;b&amp;gt; c")).toBe("a &lt;b&gt; c");
  });

  it("passes plain text through and collapses blank runs", () => {
    expect(htmlToText("  a\n\n\n\n b  ")).toBe("a\n\nb");
  });
});

describe("cleanLine", () => {
  it("trims, collapses whitespace and decodes entities", () => {
    expect(cleanLine("  Senior &amp;  Staff\n Engineer ")).toBe("Senior & Staff Engineer");
  });
});

describe("normalizeCompanyName", () => {
  it.each([
    ["Acme, Inc.", "acme"],
    ["ACME Inc", "acme"],
    ["acme", "acme"],
    ["Foo GmbH", "foo"],
    ["Bar Pte. Ltd.", "bar"],
    ["Baz Pty Limited", "baz"],
    ["  Big   Corp Co ", "big"],
    ["S.A. Holdings SA", "sa holdings"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeCompanyName(input)).toBe(expected);
  });

  it.each(["Co", "Pte. Ltd."])("does not reduce %s to an empty string", (input) => {
    expect(normalizeCompanyName(input)).not.toBe("");
  });
});

describe("cleanUrl", () => {
  it("removes tracking params, keeps others in order, drops the fragment", () => {
    expect(
      cleanUrl(
        "https://x.com/jobs/1?utm_source=a&gh_jid=42&ref=foo&lang=en&utm_medium=b&source=s&lever-source=l&gh_src=g#apply",
      ),
    ).toBe("https://x.com/jobs/1?gh_jid=42&lang=en");
  });

  it("drops the ? when nothing is left and leaves clean urls alone", () => {
    expect(cleanUrl("https://x.com/a?utm_campaign=z")).toBe("https://x.com/a");
    expect(cleanUrl("https://x.com/a?id=1")).toBe("https://x.com/a?id=1");
    expect(cleanUrl("https://x.com/a#top")).toBe("https://x.com/a");
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

describe("normalizePending", () => {
  let db: Db;
  const NOW = new Date("2026-10-07T00:00:00.000Z");
  const base = {
    first_seen_at: "2026-10-06T00:00:00.000Z",
    last_seen_at: "2026-10-06T00:00:00.000Z",
  };

  function insert(n: number, extra: Partial<NewPosting>) {
    db.insert(postings)
      .values({
        id: `p${n}`,
        source: "greenhouse",
        external_id: `e${n}`,
        url: `https://example.com/${n}`,
        title: `Engineer ${n}`,
        company_name: "Acme",
        ...base,
        ...extra,
      })
      .run();
  }

  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("links postings to one company per real company and is idempotent", () => {
    insert(1, {
      company_name: "Acme, Inc.",
      title: "  Backend &amp; API  Engineer ",
      location_text: " Remote \n (APAC) ",
    });
    insert(2, {
      company_name: "ACME Inc",
      url: "https://example.com/2?utm_source=x&id=7#frag",
      description_text: "<p>Hello&nbsp;<b>world</b></p><script>x()</script>",
    });
    insert(3, { company_name: "Foo GmbH", description_text: null, posted_at: null });

    expect(normalizePending(db, { now: () => NOW })).toBe(3);

    const cos = db.select().from(companies).all();
    expect(cos.map((c) => c.normalized_name).sort()).toEqual(["acme", "foo"]);
    const acme = must(cos.find((c) => c.normalized_name === "acme"));
    const foo = must(cos.find((c) => c.normalized_name === "foo"));
    expect(acme.created_at).toBe(NOW.toISOString());

    const rows = db
      .select()
      .from(postings)
      .all()
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(rows.map((r) => r.company_id)).toEqual([acme.id, acme.id, foo.id]);
    expect(rows.every((r) => r.normalized_at === NOW.toISOString())).toBe(true);
    expect(must(rows[0]).title).toBe("Backend & API Engineer");
    expect(must(rows[0]).location_text).toBe("Remote (APAC)");
    expect(must(rows[1]).url).toBe("https://example.com/2?id=7");
    expect(must(rows[1]).description_text).toBe("Hello world");
    expect(must(rows[2]).description_text).toBeNull();
    expect(must(rows[2]).posted_at).toBeNull();

    const before = {
      cos: db.select().from(companies).all(),
      rows: db.select().from(postings).all(),
    };
    expect(normalizePending(db, { now: () => new Date("2027-01-01T00:00:00.000Z") })).toBe(0);
    expect(db.select().from(companies).all()).toEqual(before.cos);
    expect(db.select().from(postings).all()).toEqual(before.rows);
  });

  it("does not link or create a company for 'unknown'", () => {
    insert(1, { company_name: "unknown" });
    insert(2, { company_name: " Unknown " });
    normalizePending(db);
    expect(db.select().from(companies).all()).toEqual([]);
    const rows = db.select().from(postings).where(eq(postings.source, "greenhouse")).all();
    expect(rows.map((r) => r.company_id)).toEqual([null, null]);
    expect(rows.every((r) => r.normalized_at !== null)).toBe(true);
  });

  it("only touches pending postings", () => {
    insert(1, {
      company_name: "Acme",
      normalized_at: "2026-10-01T00:00:00.000Z",
      title: " Keep  as is ",
    });
    insert(2, { company_name: "Acme" });
    expect(normalizePending(db)).toBe(1);
    expect(must(db.select().from(postings).where(eq(postings.id, "p1")).get()).title).toBe(
      " Keep  as is ",
    );
  });
});

describe("cleanUrl web3.career", () => {
  it("returns links of source web3career byte-for-byte, whatever the host", () => {
    for (const url of [
      "https://web3.career/r/1QDM1UTM__M9jY3A?ref=x&utm_source=y#apply",
      "https://other.example/job?id=1&utm_source=w3c#top",
    ]) {
      expect(cleanUrl(url, "web3career")).toBe(url);
    }
  });

  it("still cleans other sources, including on the web3.career host", () => {
    expect(cleanUrl("https://notweb3.career/a?ref=z", "greenhouse")).toBe(
      "https://notweb3.career/a",
    );
    expect(cleanUrl("https://other.example/a?utm_source=x")).toBe("https://other.example/a");
  });

  it("normalizePending leaves web3career urls untouched", () => {
    const db = openDb(":memory:");
    const url = "https://other.example/job?id=1&utm_source=w3c#top";
    db.insert(postings)
      .values({
        id: "w1",
        source: "web3career",
        external_id: "w1",
        url,
        apply_url: url,
        title: "T",
        company_name: "Acme",
        first_seen_at: "2026-10-06T00:00:00.000Z",
        last_seen_at: "2026-10-06T00:00:00.000Z",
      })
      .run();
    normalizePending(db, { now: () => new Date("2026-10-07T00:00:00.000Z") });
    const row = db.select().from(postings).where(eq(postings.id, "w1")).get();
    expect(row?.url).toBe(url);
    expect(row?.apply_url).toBe(url);
  });
});

describe("company domain from posting links", () => {
  let db: Db;
  const base = {
    first_seen_at: "2026-10-06T00:00:00.000Z",
    last_seen_at: "2026-10-06T00:00:00.000Z",
  };
  const NOW = new Date("2026-10-07T00:00:00.000Z");
  const add = (n: number, name: string, url: string, apply_url: string | null = null) =>
    db
      .insert(postings)
      .values({
        id: `d${n}`,
        source: "remoteok",
        external_id: `e${n}`,
        url,
        apply_url,
        title: "Engineer",
        company_name: name,
        ...base,
      })
      .run();
  const domainOf = (key: string) =>
    db
      .select()
      .from(companies)
      .all()
      .find((c) => c.normalized_name === key)?.domain ?? null;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("takes a company-owned apply host; falls back to the public link; strips www and tracking", () => {
    add(
      1,
      "Acme",
      "https://remoteok.com/remote-jobs/1",
      "https://www.acme.io/careers/7?utm_source=x",
    );
    add(2, "Globex", "https://globex.dev/jobs/2");
    normalizePending(db, { now: () => NOW });
    expect(domainOf("acme")).toBe("acme.io");
    expect(domainOf("globex")).toBe("globex.dev");
  });

  it.each([
    ["boards.greenhouse.io", "https://boards.greenhouse.io/acme/jobs/1"],
    ["job-boards.greenhouse.io", "https://job-boards.greenhouse.io/acme/jobs/1"],
    ["jobs.lever.co", "https://jobs.lever.co/acme/abc"],
    ["jobs.ashbyhq.com", "https://jobs.ashbyhq.com/acme/abc"],
    ["apply.workable.com", "https://apply.workable.com/acme/j/1"],
    ["recruitee tenant", "https://acme.recruitee.com/o/x"],
    ["smartrecruiters", "https://jobs.smartrecruiters.com/Acme/1"],
    ["remoteok", "https://remoteok.com/remote-jobs/1"],
    ["remotive", "https://remotive.com/remote-jobs/1"],
    ["himalayas", "https://himalayas.app/companies/acme/jobs/1"],
    ["weworkremotely", "https://weworkremotely.com/remote-jobs/1"],
    ["arbeitnow", "https://www.arbeitnow.com/jobs/1"],
    ["arbeitnow.ch", "https://www.arbeitnow.ch/jobs/1"],
    ["arbeitnow.co.uk", "https://arbeitnow.co.uk/jobs/1"],
    ["web3.career", "https://web3.career/acme/1"],
    ["hacker news", "https://news.ycombinator.com/item?id=1"],
    ["bit.ly shortener", "https://bit.ly/abc"],
    ["linktr.ee", "https://linktr.ee/acme"],
    ["linkedin", "https://www.linkedin.com/jobs/view/1"],
    ["ip address", "https://203.0.113.5/jobs"],
  ])("never uses %s as a company domain", (_n, url) => {
    add(1, "Acme", url, url);
    normalizePending(db, { now: () => NOW });
    expect(domainOf("acme")).toBeNull();
  });

  it("never overwrites a stored (config) domain, also from a later posting", () => {
    db.insert(companies)
      .values({
        id: "c-acme",
        name: "Acme",
        normalized_name: "acme",
        domain: "acme-config.example",
        created_at: NOW.toISOString(),
      })
      .run();
    add(1, "Acme", "https://remoteok.com/1", "https://other-host.io/apply");
    normalizePending(db, { now: () => NOW });
    expect(domainOf("acme")).toBe("acme-config.example");
  });

  it("fills a missing domain on a later posting of an existing company", () => {
    add(1, "Acme", "https://remoteok.com/1");
    normalizePending(db, { now: () => NOW });
    expect(domainOf("acme")).toBeNull();
    add(2, "Acme", "https://remoteok.com/2", "https://acme.io/apply");
    normalizePending(db, { now: () => NOW });
    expect(domainOf("acme")).toBe("acme.io");
  });

  it("backfills companies of already normalized postings, oldest link first", () => {
    add(1, "Acme", "https://remoteok.com/1", "https://old.acme.io/apply");
    normalizePending(db, { now: () => NOW });
    db.update(companies).set({ domain: null }).run();
    expect(normalizePending(db, { now: () => NOW })).toBe(0);
    expect(domainOf("acme")).toBe("old.acme.io");
  });
});
