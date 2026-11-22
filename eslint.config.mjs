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
    files: ["web/server/chat-handler.ts", "web/server/browser-agent.ts", "web/server/mission-agent.ts", "web/agent-client.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["**/core.js", "**/core.ts", "**/core"] }
      ]
    }
  },
  {
    files: ["web/editor-session.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@drone/mission-planner/agent"],
          patterns: ["**/core.js", "**/core.ts", "**/core"]
        }
      ]
    }
  },
  {
    ignores: ["dist/**", ".next/**", ".next-map-*/**", "next-env.d.ts", "node_modules/**", "playwright-report/**", "test-results/**", "public/maplibre-gl-worker.mjs"]
  }
);
