import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    exclude: [...configDefaults.exclude, ".worktrees/**", "data/**", "config/**", "**/dist/**"],
  },
});
