const assert = require("node:assert");
const { test } = require("node:test");

const { matches } = require("../lib/glob.js");

const TABLE = [
  ["**/krites.toml", "krites.toml", true],
  ["**/krites.toml", "a/b/krites.toml", true],
  ["**/krites.toml", "krites.toml.bak", false],
  ["**/krites.toml", "a/krites.tomlx", false],
  ["**/.krites/**", ".krites/session-head", true],
  ["**/.krites/**", "a/b/.krites/c/d.json", true],
  ["**/.krites/**", ".krites", false],
  ["**/.krites/**", ".kritesx/a", false],
  [".git/**", ".git/config", true],
  [".git/**", ".git/objects/ab/cd", true],
  [".git/**", "a/.git/config", false],
  [".git/**", ".git", false],
  ["tests/krites/**", "tests/krites/a.rs", true],
  ["tests/krites/**", "tests/krites/deep/a.rs", true],
  ["tests/krites/**", "tests/kritesx/a.rs", false],
  ["tests/krites/**", "tests/krites", false],
  ["*.md", "README.md", true],
  ["*.md", "docs/README.md", false],
  ["docs/*.md", "docs/a.md", true],
  ["docs/*.md", "docs/a/b.md", false],
  ["a?c.txt", "abc.txt", true],
  ["a?c.txt", "ac.txt", false],
  ["a?c.txt", "a/c.txt", false],
  ["src/**/*.rs", "src/a/b.rs", true],
  ["src/**/*.rs", "src/b.rs", true],
  ["src/**/*.rs", "src/b.ts", false],
  ["**", "a", true],
  ["**", "a/b/c", true],
  ["/tests/**", "tests/a.rs", true],
  ["./tests/**", "tests/a.rs", true],
  ["tests/**", "/tests/a.rs", true],
  ["tests/**", "./tests/a.rs", true],
  ["Tests/KRITES/**", "tests/krites/a.rs", true],
  ["tests/krites/**", "TESTS/Krites/A.rs", true],
  [".claude/**", ".claude/settings.json", true],
  ["krites.toml", "krites.toml", true],
  ["krites.toml", "sub/krites.toml", false],
  ["a b/**", "a b/c.txt", true],
  ["a+b.txt", "a+b.txt", true],
  ["a+b.txt", "axb.txt", false],
];

test("glob: the table of glob, path and expected", () => {
  for (const [glob, rel, expected] of TABLE) {
    assert.strictEqual(matches(glob, rel), expected, `${glob} vs ${rel}`);
  }
});

test("glob: separators and unicode form do not decide the match", () => {
  assert.strictEqual(matches("tests/krites/**", "tests\\krites\\a.rs"), true);
  assert.strictEqual(matches("tests\\krites\\**", "tests/krites/a.rs"), true);
  assert.strictEqual(matches("café/**", "café/x.txt"), true);
  assert.strictEqual(matches("café/**", "café/x.txt"), true);
});

test("glob: case folding can be turned off", () => {
  assert.strictEqual(matches("home/q/Work/**", "home/q/work/a.md"), true);
  assert.strictEqual(matches("home/q/Work/**", "home/q/work/a.md", { fold: false }), false);
  assert.strictEqual(matches("home/q/Work/**", "home/q/Work/a.md", { fold: false }), true);
  assert.strictEqual(matches("home/q/Work/**", "home/q/work/a.md"), true, "the unfolded pattern is cached apart from the folded one");
});
