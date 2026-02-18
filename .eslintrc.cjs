/**
 * Minimal ESLint config aligned with the repo's current devDependencies.
 * (No TypeScript parser/plugins — keeps npm ci deterministic on the server.)
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:react/recommended",
    "plugin:react/jsx-runtime",
    "plugin:prettier/recommended",
  ],
  plugins: ["react", "prettier"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: "detect" },
  },
  ignorePatterns: [
    "node_modules/",
    "build/",
    "dist/",
    "prisma/",
    "extensions/",
    "**/*.ts",
    "**/*.tsx",
  ],
};
