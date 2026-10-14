import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// Every test gets its own Brave request counter, so no test spends the real daily cap or another test's.
beforeEach(() => {
  process.env["JOB_AGENT_BRAVE_USAGE"] = join(
    mkdtempSync(join(tmpdir(), "brave-usage-")),
    "usage.json",
  );
});
