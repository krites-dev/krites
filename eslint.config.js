const js = require("@eslint/js");

const GLOBALS = ["Buffer", "URL", "__dirname", "clearTimeout", "console", "process", "require", "setTimeout"];

module.exports = [
  // The fixture repos are other projects' sources, linted by their own checks when the end-to-end tests run them.
  { ignores: ["test/fixtures/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...Object.fromEntries(GLOBALS.map((name) => [name, "readonly"])), module: "writable" },
    },
    rules: { "no-empty": "error" },
  },
];
