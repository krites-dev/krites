const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { findRoots, loadConfig, loadUserConfig, parseToml, protectedGlobs } = require("../lib/config.js");
const { matches } = require("../lib/glob.js");
const { git, gitInit, makeDir, makeRepo, tmp } = require("./helpers.js");

const BRIEF = `# krites.toml
version = 1

[checks]
# run in order; first non-zero exit refutes
commands = [
  "cargo fmt --check",
  "cargo clippy --workspace --all-targets -- -D warnings",
  "cargo nextest run --workspace",
]
timeout_seconds = 600          # hard deadline for the whole gate; must be below the hook timeout in settings

[protect]
globs = ["tests/krites/**", "krites.toml", ".claude/**"]

[receipts]
dir = "receipts"
`;

let n = 0;
function withToml(toml) {
  const dir = path.join(tmp, `cfg${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "krites.toml"), toml, "utf8");
  return dir;
}

const load = (toml) => loadConfig(withToml(toml));
const head = (body) => `version = 1\n\n${body}`;

test("config: the brief's example parses to the expected object", () => {
  const parsed = parseToml(BRIEF);
  assert.strictEqual(parsed.ok, true, parsed.message);
  assert.deepStrictEqual(parsed.value, {
    version: 1,
    checks: {
      commands: ["cargo fmt --check", "cargo clippy --workspace --all-targets -- -D warnings", "cargo nextest run --workspace"],
      timeout_seconds: 600,
    },
    protect: { globs: ["tests/krites/**", "krites.toml", ".claude/**"] },
    receipts: { dir: "receipts" },
  });

  const loaded = load(BRIEF);
  assert.strictEqual(loaded.ok, true, loaded.error);
  assert.deepStrictEqual(loaded.config, {
    version: 1,
    checks: {
      commands: [
        ["cargo", "fmt", "--check"],
        ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
        ["cargo", "nextest", "run", "--workspace"],
      ],
      slow: [],
      env: Object.create(null),
      timeout_seconds: 600,
      max_blocks: 3,
    },
    protect: { globs: ["tests/krites/**", "krites.toml", ".claude/**"] },
    receipts: { dir: "receipts" },
  });
});

test("config: the defaults when only version is set", () => {
  const loaded = load("version = 1\n");
  assert.strictEqual(loaded.ok, true, loaded.error);
  assert.deepStrictEqual(loaded.config, {
    version: 1,
    checks: { commands: [], slow: [], env: Object.create(null), timeout_seconds: 600, max_blocks: 3 },
    protect: { globs: [] },
    receipts: { dir: "receipts" },
  });
});

test("config: BOM, CRLF, comments and a trailing comma are accepted", () => {
  const toml = "\uFEFF# lead\r\nversion = 1\r\n\r\n[protect]\r\nglobs = [\r\n  \"a/**\",\r\n  \"b/**\",\r\n]\r\n";
  const loaded = load(toml);
  assert.strictEqual(loaded.ok, true, loaded.error);
  assert.deepStrictEqual(loaded.config.protect.globs, ["a/**", "b/**"]);
});

test("config: the array form of a command keeps its arguments", () => {
  const loaded = load(head('[checks]\ncommands = [["pytest", "-k", "not slow"], "npm test"]\n'));
  assert.strictEqual(loaded.ok, true, loaded.error);
  assert.deepStrictEqual(loaded.config.checks.commands, [
    ["pytest", "-k", "not slow"],
    ["npm", "test"],
  ]);
});

test("config: every rejected character is rejected with a line number, in both command forms", () => {
  for (const ch of ['"', "'", "`", "|", "&", ";", "<", ">", "$", "%", "^", "!", "*", "?", "(", ")"]) {
    const escaped = ch === '"' ? '\\"' : ch;
    for (const body of [`commands = ["echo a${escaped}b"]`, `commands = [["echo", "a${escaped}b"]]`]) {
      const loaded = load(head(`[checks]\n${body}\n`));
      assert.strictEqual(loaded.ok, false, `${ch} in ${body}`);
      assert.match(loaded.error, /^krites\.toml line 4: /, `${ch} in ${body}`);
      assert.match(loaded.error, /Run \/krites:init\.$/);
    }
  }
});

test("config: a newline and a trailing backslash in a command are rejected with a line number", () => {
  const broken = load(head('[checks]\ncommands = ["echo a\nb"]\n'));
  assert.strictEqual(broken.ok, false);
  assert.match(broken.error, /^krites\.toml line 4: /);

  const trailing = load(head('[checks]\ncommands = ["echo a\\\\"]\n'));
  assert.strictEqual(trailing.ok, false);
  assert.match(trailing.error, /^krites\.toml line 4: .*backslash/);
});

test("config: a command that starts with a dash, an empty command and an empty program are errors", () => {
  for (const body of ['commands = ["-k not slow"]', 'commands = [""]', 'commands = [[]]', 'commands = [["", "x"]]', "commands = [1]"]) {
    const loaded = load(head(`[checks]\n${body}\n`));
    assert.strictEqual(loaded.ok, false, body);
    assert.match(loaded.error, /^krites\.toml line 4: /, body);
  }
  assert.strictEqual(load(head("[checks]\ncommands = []\n")).ok, true, "an empty list is valid");
});

test("config: unknown table, unknown key, duplicate key and unsupported syntax fail closed", () => {
  const cases = [
    ["version = 1\n[nope]\nx = 1\n", 2],
    ["version = 1\n\n[checks]\nnope = 1\n", 4],
    ["version = 1\nversion = 1\n", 2],
    ["version = 1\n\n[checks]\ntimeout_seconds = 10\ntimeout_seconds = 20\n", 5],
    ["version = 1\n\n[checks]\n\n[checks]\n", 5],
    ["version = 1\n\n[receipts]\ndir = 'receipts'\n", 4],
    ['version = 1\n\n[receipts]\ndir = """r"""\n', 4],
    ["version = 1\n\n[receipts]\ndir = { a = 1 }\n", 4],
    ["version = 1\n\n[checks]\ntimeout_seconds = true\n", 4],
    ["version = 1\n\n[checks]\ntimeout_seconds = 1.5\n", 4],
    ["version = 1\n\n[protect]\nglobs.a = 1\n", 4],
    ['version = 1\n\n[protect]\nglobs = ["a" "b"]\n', 4],
    ['version = 1\n\n[protect]\nglobs = ["a"\n', 4],
    ['version = 1\n\n[protect]\nglobs = ["a"] junk\n', 4],
    ['version = 1\n\n[protect]\nglobs = ["a\\nb"]\n', 4],
    ['version = 1\n\n[protect]\nglobs = [[["a"]]]\n', 4],
  ];
  for (const [toml, line] of cases) {
    const loaded = load(toml);
    assert.strictEqual(loaded.ok, false, toml);
    assert.match(loaded.error, new RegExp(`^krites\\.toml line ${line}: `), toml);
  }
});

test("config: version must be 1", () => {
  for (const toml of ["version = 2\n", "[checks]\n", 'version = "1"\n']) {
    const loaded = load(toml);
    assert.strictEqual(loaded.ok, false, toml);
    assert.match(loaded.error, /^krites\.toml line \d+: version must be 1\./, toml);
  }
});

test("config: max_blocks is a whole number from 1 to 8 and defaults to 3", () => {
  for (const value of ["0", "9", '"3"']) {
    const loaded = load(head(`[checks]\nmax_blocks = ${value}\n`));
    assert.strictEqual(loaded.ok, false, value);
    assert.match(loaded.error, /^krites\.toml line 4: .*max_blocks/, value);
  }
  const float = load(head("[checks]\nmax_blocks = 1.5\n"));
  assert.strictEqual(float.ok, false);
  assert.match(float.error, /^krites\.toml line 4: /);

  assert.strictEqual(load(head("[checks]\nmax_blocks = 1\n")).config.checks.max_blocks, 1);
  assert.strictEqual(load(head("[checks]\nmax_blocks = 8\n")).config.checks.max_blocks, 8, "the recording's ceiling");
  assert.strictEqual(load("version = 1\n").config.checks.max_blocks, 3, "absent means three blocked attempts");
});

test("config: timeout_seconds is a whole number from 1 to 820", () => {
  for (const value of ["0", "821", '"600"']) {
    const loaded = load(head(`[checks]\ntimeout_seconds = ${value}\n`));
    assert.strictEqual(loaded.ok, false, value);
    assert.match(loaded.error, /^krites\.toml line 4: .*timeout_seconds/, value);
  }
  assert.strictEqual(load(head("[checks]\ntimeout_seconds = 1\n")).config.checks.timeout_seconds, 1);
  assert.strictEqual(load(head("[checks]\ntimeout_seconds = 820\n")).config.checks.timeout_seconds, 820);
});

test("config: receipts.dir stays inside the repo", () => {
  for (const dir of ["../out", "a/../../out", "/tmp/out", "C:\\\\out", "\\\\\\\\server\\\\share", ""]) {
    const loaded = load(head(`[receipts]\ndir = "${dir}"\n`));
    assert.strictEqual(loaded.ok, false, dir);
    assert.match(loaded.error, /^krites\.toml line 4: .*receipts/, dir);
  }
  assert.strictEqual(load(head('[receipts]\ndir = "out/receipts"\n')).config.receipts.dir, "out/receipts");
});

test("config: protect.globs holds non-empty strings only", () => {
  for (const body of ['globs = [1]', 'globs = [""]', 'globs = "a/**"']) {
    const loaded = load(head(`[protect]\n${body}\n`));
    assert.strictEqual(loaded.ok, false, body);
    assert.match(loaded.error, /^krites\.toml line 4: /, body);
  }
});

test("config: a missing file is an error, never a silent default", () => {
  const loaded = loadConfig(makeDir({}));
  assert.strictEqual(loaded.ok, false);
  assert.match(loaded.error, /krites\.toml/);
});

test("config: protectedGlobs adds the built-ins to the configured globs", () => {
  const config = load(head('[protect]\nglobs = ["a/**"]\n')).config;
  assert.deepStrictEqual(protectedGlobs(config).slice(0, 1), ["a/**"]);
  const built = protectedGlobs(load("version = 1\n").config);
  assert.deepStrictEqual(protectedGlobs(config).slice(1), built);
  for (const rel of ["krites.toml", "sub/krites.toml", ".krites/session-head", ".git", ".git/config", "sub/.git", "sub/.git/config", "sub/.git/refs/heads/main"]) {
    assert.ok(
      built.some((glob) => matches(glob, rel)),
      `${rel} is protected by a built-in glob`,
    );
  }
  for (const rel of ["src/git.rs", "gitignore", ".github/workflows/ci.yml"]) {
    assert.ok(
      !built.some((glob) => matches(glob, rel)),
      `${rel} is not protected`,
    );
  }
});

test("config: a command list that is not an array, and a load that would throw, are errors", () => {
  for (const body of ['commands = "cargo test"', "commands = 3", "commands = [[[\"a\"]]]"]) {
    const loaded = load(head(`[checks]\n${body}\n`));
    assert.strictEqual(loaded.ok, false, body);
    assert.match(loaded.error, /^krites\.toml line \d+: .*Run \/krites:init\.$/, body);
  }
  const unreadable = loadConfig(path.join(tmp, "no-such-root-at-all"));
  assert.strictEqual(unreadable.ok, false);
  assert.match(unreadable.error, /Run \/krites:init\.$/);
});

test("config: an item deep in a multi-line array reports its own line", () => {
  const loaded = load('version = 1\n\n[checks]\ncommands = [\n  "cargo fmt",\n  "cargo test",\n  "echo $HOME",\n]\n');
  assert.strictEqual(loaded.ok, false);
  assert.match(loaded.error, /^krites\.toml line 7: /);
});

test("config: integers are plain, with no leading zero or sign", () => {
  for (const value of ["007", "+7", "1_0", "0x10", "-0"]) {
    const loaded = load(head(`[checks]\ntimeout_seconds = ${value}\n`));
    assert.strictEqual(loaded.ok, false, value);
    assert.match(loaded.error, /^krites\.toml line 4: /, value);
  }
  assert.strictEqual(load(head("[checks]\ntimeout_seconds = 60\n")).config.checks.timeout_seconds, 60);
});

test("config: control characters and empty arguments are rejected, but a tab separates words", () => {
  const control = (code) => String.fromCharCode(code);
  for (const body of [`commands = ["echo${control(0)}a"]`, `commands = [["echo", "a${control(7)}b"]]`, 'commands = [["echo", ""]]']) {
    const loaded = load(head(`[checks]\n${body}\n`));
    assert.strictEqual(loaded.ok, false, JSON.stringify(body));
    assert.match(loaded.error, /^krites\.toml line 4: /, JSON.stringify(body));
  }
  const tabbed = load(head(`[checks]\ncommands = ["cargo${control(9)}fmt"]\n`));
  assert.strictEqual(tabbed.ok, true, tabbed.error);
  assert.deepStrictEqual(tabbed.config.checks.commands, [["cargo", "fmt"]]);
});

test("config: receipts.dir may not be the root itself or a tool directory", () => {
  for (const dir of [".", "./", ".git", ".git/x", ".krites", ".krites/out", ".claude/receipts"]) {
    const loaded = load(head(`[receipts]\ndir = "${dir}"\n`));
    assert.strictEqual(loaded.ok, false, dir);
    assert.match(loaded.error, /^krites\.toml line 4: .*receipts/, dir);
  }
  assert.strictEqual(load(head('[receipts]\ndir = ".github/r"\n')).config.receipts.dir, ".github/r", "only the exact names are reserved");
});

test("findRoots: a repo gated before but with krites.toml deleted stays a root with a config error", () => {
  for (const commit of [false, true]) {
    const repo = makeRepo({ files: { "krites.toml": "version = 1\n", "a.txt": "a\n" } });
    fs.mkdirSync(path.join(repo, ".krites"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".krites", "session-head"), `${"a".repeat(40)}\n`);
    fs.rmSync(path.join(repo, "krites.toml"));
    if (commit) {
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "drop config");
    }
    const roots = findRoots({ cwd: repo, processCwd: tmp });
    assert.strictEqual(roots.length, 1, `commit=${commit}`);
    assert.strictEqual(roots[0].root, repo);
    assert.match(roots[0].error, /krites\.toml is missing from a repo that Krites gated before/, `commit=${commit}`);
    assert.doesNotMatch(roots[0].error, /delete \.krites/, "the reason never tells the model how to switch the gate off");
  }
});

test("findRoots: the process cwd is a start directory too", () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n" } });
  assert.deepStrictEqual(findRoots({ processCwd: repo }), [{ root: repo, error: null }]);
  assert.deepStrictEqual(findRoots({ processCwd: makeDir({}) }), [], "a cwd with no config adds no root");
});

test("findRoots: the nearest ancestor with krites.toml, from either start", () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n", "src/deep/a.txt": "a\n" } });
  assert.deepStrictEqual(findRoots({ cwd: path.join(repo, "src", "deep"), processCwd: tmp }), [{ root: repo, error: null }]);
  assert.deepStrictEqual(findRoots({ projectDir: repo.replace(/\\/g, "/"), processCwd: tmp }), [{ root: repo, error: null }]);
  assert.deepStrictEqual(findRoots({ cwd: repo, projectDir: path.join(repo, "src"), processCwd: tmp }), [{ root: repo, error: null }], "the same root is returned once");
  assert.deepStrictEqual(findRoots({ processCwd: tmp }), []);
});

test("findRoots: a nested krites.toml is its own root and both starts are kept", () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n", "inner/krites.toml": "version = 1\n" } });
  const inner = path.join(repo, "inner");
  assert.deepStrictEqual(findRoots({ cwd: inner, projectDir: repo, processCwd: tmp }), [
    { root: inner, error: null },
    { root: repo, error: null },
  ]);
});

test("findRoots: nothing above the git toplevel is read", () => {
  const outer = makeDir({ "krites.toml": "version = 1\n" });
  const repo = path.join(outer, "repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  assert.deepStrictEqual(findRoots({ cwd: repo, processCwd: tmp }), []);
});

test("findRoots: a krites.toml tracked at HEAD but missing from the tree is a config error", () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n" } });
  fs.rmSync(path.join(repo, "krites.toml"));
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].root, repo);
  assert.match(roots[0].error, /tracked but missing/);
});

test("user config: allow_outside takes absolute and home globs on every OS, and a missing file is an empty list", () => {
  assert.deepStrictEqual(loadUserConfig(makeDir()), { ok: true, allowOutside: [] });
  const entries = ["~/work/**", "~\\notes\\**", "/srv/scratch/**", "\\\\share\\x\\**", "C:/Users/q/scratch/**", "d:\\plans\\**"];
  const text = `[protect]\nallow_outside = [${entries.map((entry) => JSON.stringify(entry)).join(", ")}]\n`;
  assert.deepStrictEqual(loadUserConfig(makeDir({ "config.toml": text })), { ok: true, allowOutside: entries });
});

test("user config: a relative entry and every other shape are errors that name the file, the line and the key", () => {
  const cases = [
    ['[protect]\nallow_outside = ["work/**"]\n', 2, /protect\.allow_outside entries are absolute paths or start with ~\//],
    ['[protect]\nallow_outside = [\n  "~/a/**",\n  "~work/**",\n]\n', 4, /protect\.allow_outside entries/],
    ['[protect]\nallow_outside = [""]\n', 2, /protect\.allow_outside is a list of non-empty strings/],
    ['[protect]\nallow_outside = "~/work/**"\n', 2, /protect\.allow_outside is a list of non-empty strings/],
    ['[protect]\nglobs = ["x"]\n', 2, /unknown key protect\.globs/],
    ["[checks]\n", 1, /unknown table \[checks\]/],
    ["version = 1\n", 1, /unknown key version/],
  ];
  for (const [text, line, what] of cases) {
    const loaded = loadUserConfig(makeDir({ "config.toml": text }));
    assert.strictEqual(loaded.ok, false, text);
    assert.match(loaded.error, new RegExp(`^config\\.toml in the Krites config directory, line ${line}: `), text);
    assert.match(loaded.error, what, text);
  }
});

test("user config: krites.toml does not take allow_outside", () => {
  const loaded = load('version = 1\n\n[protect]\nallow_outside = ["~/work/**"]\n');
  assert.strictEqual(loaded.ok, false);
  assert.match(loaded.error, /^krites\.toml line 4: unknown key protect\.allow_outside/);
});

test("config: [checks.env] is a table of names and string values", () => {
  const loaded = load(head('[checks]\ncommands = ["make vulncheck"]\n\n[checks.env]\nGOTOOLCHAIN = "go1.26.6"\n__proto__ = "x"\n_Lower_9 = ""\n'));
  assert.strictEqual(loaded.ok, true, loaded.error);
  assert.deepStrictEqual(Object.entries(loaded.config.checks.env), [["GOTOOLCHAIN", "go1.26.6"], ["__proto__", "x"], ["_Lower_9", ""]]);
  assert.deepStrictEqual(Object.entries(load(head("")).config.checks.env), []);
});

test("config: a bad [checks.env] is refused with its line", () => {
  const cases = [
    ['[checks.env]\n1X = "a"\n', 4, /a line is blank, a comment, a table header or key = value/],
    ['[checks.env]\nA-B = "a"\n', 4, /\[checks\.env\] names are letters, digits and _, not starting with a digit/],
    ["[checks.env]\nA = 1\n", 4, /\[checks\.env\] values are strings/],
    ['[checks.env]\nA = ["x"]\n', 4, /\[checks\.env\] values are strings/],
    ['[checks.env]\nA = "a\tb"\n', 4, /\[checks\.env\] values may not hold a control character/],
    ...['\\"', "&", "|", "<", ">", "^", "%", "!"].map((ch) => [`[checks.env]\nA = "x${ch}y"\n`, 4, /\[checks\.env\] values may not hold the character/]),
    ['[checks.env]\nPath = "a"\nPATH = "b"\n', 5, /\[checks\.env\] names PATH twice, ignoring case/],
    ['[checks.env]\nA = "a"\n\n[checks.env]\n', 6, /\[checks\.env\] appears twice/],
    ["[checks.other]\n", 3, /unknown table \[checks\.other\]/],
    ["[protect.env]\n", 3, /unknown table \[protect\.env\]/],
    ["[checks.env.x]\n", 3, /a table header is/],
    ['[checks]\nenv = "A=1"\n', 4, /unknown key checks\.env/],
  ];
  for (const [body, line, what] of cases) {
    const loaded = load(head(body));
    assert.strictEqual(loaded.ok, false, body);
    assert.match(loaded.error, new RegExp(`^krites\\.toml line ${line}: `), `${body}: ${loaded.error}`);
    assert.match(loaded.error, what, body);
  }
});

test("config: changing [checks.env] changes config_hash", () => {
  const a = load(head('[checks.env]\nGOTOOLCHAIN = "go1.26.6"\n'));
  const b = load(head('[checks.env]\nGOTOOLCHAIN = "go1.26.7"\n'));
  assert.ok(a.ok && b.ok);
  assert.notStrictEqual(a.hash, b.hash);
});

test("config: [checks].slow is validated like commands and defaults to none", () => {
  const loaded = load(head('[checks]\ncommands = ["cargo test"]\nslow = [\n  "cargo test --release",\n  ["pnpm", "e2e"],\n]\n'));
  assert.strictEqual(loaded.ok, true, loaded.error);
  assert.deepStrictEqual(loaded.config.checks.slow, [["cargo", "test", "--release"], ["pnpm", "e2e"]]);
  assert.deepStrictEqual(load(head('[checks]\ncommands = ["cargo test"]\n')).config.checks.slow, []);

  const cases = [
    ['[checks]\nslow = [\n  "ok",\n  "a | b",\n]\n', 6, /may not hold the character "\|"/],
    ['[checks]\nslow = ["-x"]\n', 4, /starting with - has no program/],
    ['[checks]\nslow = "cargo test"\n', 4, /checks\.slow is a list of commands/],
  ];
  for (const [body, line, what] of cases) {
    const bad = load(head(body));
    assert.strictEqual(bad.ok, false, body);
    assert.match(bad.error, new RegExp(`^krites\\.toml line ${line}: `), `${body}: ${bad.error}`);
    assert.match(bad.error, what, body);
  }
});
