import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: ["**/core.js", "**/core.ts", "**/core", "@drone/mission-planner/*"]
        }
      ]
    }
  },
  {
    files: ["src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["**/core.ts", "**/core", "@drone/mission-planner/*"]
        }
      ]
    }
  },
  {
    ignores: ["dist/**", ".next/**", "next-env.d.ts", "node_modules/**", "playwright-report/**", "test-results/**"]
  }
);
