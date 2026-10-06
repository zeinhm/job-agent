import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".worktrees/**",
      "data/**",
      "config/**",
      "**/node_modules/**",
      "**/dist/**",
      "packages/core/drizzle/**",
    ],
  },
  ...tseslint.configs.strict,
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
