"use strict";
// Runs on every `pnpm install`, including no-op installs where pnpm skips root
// lifecycle scripts (so the `prepare` script alone is not enough).
// Keeps the pre-commit hook active: core.hooksPath -> .githooks.
const { spawnSync } = require("node:child_process");

function activateHooks() {
  const inRepo = spawnSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
  if (inRepo.status !== 0) return;
  spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
}

activateHooks();

module.exports = { hooks: {} };
