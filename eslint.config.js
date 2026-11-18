// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // Rebuilt in phase 6; until then it is reference material, not part of the gate.
      "web/**",
      ".references/**",
      ".scratch/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Size limits from the coding rules: enforced mechanically, never by eye.
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: false }],
      "max-lines-per-function": ["error", { max: 200, skipBlankLines: false, skipComments: false }],
      "max-depth": ["error", 3],
      "max-params": ["error", 5],
      "no-console": "error",
      eqeqeq: ["error", "always"],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "Use an `as const` object and a literal union." },
      ],
    },
  },
  {
    // Carrier plug-ins may only use the plug-in API, never the app's internals.
    files: ["server/src/carriers/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/**", "**/api/**", "**/engine/**", "**/auth/**", "**/events/**"],
              message: "Carrier plug-ins may only import from the plug-in API (server/src/plugin).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "server/test/**/*.ts"],
    rules: {
      // A describe() block holds many tests; the function limit is meant for production code.
      "max-lines-per-function": "off",
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
