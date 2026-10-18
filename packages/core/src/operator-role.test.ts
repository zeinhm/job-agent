import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const role = JSON.parse(readFileSync(join(ROOT, ".claude", "roles", "operator.json"), "utf8")) as {
  permissions: { allow: string[]; deny: string[] };
};

const ALLOWED = [
  "Bash(bin/operator:*)",
  "Bash(hermes kanban list:*)",
  "Bash(hermes kanban show:*)",
  "Edit(./data/handoff/**)",
];

// Readers and interpreters the harness could auto-approve or the project allows: all refused, on top of dontAsk.
const READERS = [
  "sort",
  "cut",
  "tr",
  "nl",
  "uniq",
  "diff",
  "paste",
  "fold",
  "od",
  "xxd",
  "hexdump",
  "strings",
  "base64",
  "file",
  "stat",
  "tree",
  "column",
  "tac",
  "rev",
  "comm",
  "echo",
  "printf",
  "xargs",
  "tee",
  "perl",
  "ruby",
  "php",
  "osascript",
  "source",
  "dd",
  "tar",
  "zip",
  "gzip",
];

// Every tracked top-level directory the operator must not edit (the only file it writes is under data/handoff/).
const TRACKED_DIRS = [
  ".claude",
  ".githooks",
  ".github",
  "apps",
  "bin",
  "config",
  "docs",
  "fixtures",
  "packages",
  "profiles",
  "prompts",
  "scripts",
  "workers",
];

const REQUIRED_DENY = [
  "Bash(sqlite3:*)",
  "Bash(pnpm:*)",
  "Bash(npx:*)",
  "Bash(node:*)",
  "Bash(tsx:*)",
  "Bash(python:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(less:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  "Bash(cp:*)",
  "Bash(mv:*)",
  "Bash(curl:*)",
  "Bash(git:*)",
  "Read(./data/**)",
  "Read(./config/**)",
  "Read(./.env*)",
  "Read(**/*.png)",
  "Read(**/*.jpg)",
  "Read(**/*.db*)",
  "WebFetch",
  "WebSearch",
  "Bash(hermes kanban create:*)",
  "Bash(hermes kanban comment:*)",
  "Bash(bin/release:*)",
  "Bash(./bin/release:*)",
  "Edit(./.git/**)",
  "Edit(./.worktrees/**)",
  ...READERS.map((c) => `Bash(${c}:*)`),
  ...TRACKED_DIRS.map((d) => `Edit(./${d}/**)`),
  "Edit(./*)",
];

describe(".claude/roles/operator.json", () => {
  it("allows exactly bin/operator, the read-only card tools and writing under data/handoff", () => {
    expect([...role.permissions.allow].sort()).toEqual([...ALLOWED].sort());
  });

  it("denies every required command, path and tool", () => {
    for (const rule of REQUIRED_DENY) expect(role.permissions.deny, rule).toContain(rule);
  });

  it("has no direct way to create a card, comment or release (bin/operator is the only path)", () => {
    expect(role.permissions.allow.filter((r) => /kanban (create|comment)|release/.test(r))).toEqual(
      [],
    );
  });

  it("denies no rule it also allows, and does not deny the handoff directory", () => {
    for (const rule of role.permissions.allow) expect(role.permissions.deny).not.toContain(rule);
    expect(
      role.permissions.deny.filter((r) => /data\/(handoff|\*\*)/.test(r) && r.startsWith("Edit")),
    ).toEqual([]);
  });

  it("keeps the operator's settings file out of the project allow list's reach for cat, pnpm and sqlite3", () => {
    const project = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8")) as {
      permissions: { allow: string[] };
    };
    // a deny wins over an allow, so every project allow that could read data or run the CLI must have a deny here
    for (const rule of [
      "Bash(pnpm:*)",
      "Bash(sqlite3:*)",
      "Bash(cat:*)",
      "Bash(grep:*)",
      "Bash(git add:*)",
    ]) {
      if (!project.permissions.allow.includes(rule)) continue;
      const prefix = rule.replace(/ .*$/, "").replace(/:\*\)$/, "");
      expect(
        role.permissions.deny.some((d) => d === rule || d.startsWith(`${prefix}:`)),
        rule,
      ).toBe(true);
    }
  });
});
