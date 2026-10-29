import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const config = [
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "tailwind.config.js"],
  },
  {
    rules: {
      "no-console": "error",
      "no-multiple-empty-lines": ["error", { max: 1 }],
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "import/order": [
        "warn",
        {
          groups: ["external", "builtin", "internal", "sibling", "parent", "index"],
          pathGroups: [{ pattern: "@unep/**", group: "internal" }],
          pathGroupsExcludedImportTypes: ["internal"],
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
];

export default config;
