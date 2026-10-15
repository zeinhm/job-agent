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
    // Web app renders untrusted posting text: text only, never raw HTML (phase-4-conventions section 4).
    files: ["apps/dashboard/src/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML is forbidden in the web app.",
        },
        {
          selector: "Identifier[name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML is forbidden in the web app.",
        },
      ],
    },
  },
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
