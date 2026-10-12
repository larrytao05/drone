import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
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
          patterns: ["**/core.js", "@drone/mission-planner/*"]
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
          patterns: ["@drone/mission-planner/*"]
        }
      ]
    }
  },
  {
    ignores: ["dist/**", ".next/**", "next-env.d.ts", "node_modules/**"]
  }
);
