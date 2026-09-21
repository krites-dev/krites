const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { findRoots } = require("../lib/config.js");
const { decide } = require("../hooks/protect.js");
const { ABSOLUTE, gitInit, makeDir, makeRepo, runHook, tmp } = require("./helpers.js");

const PROTECT = path.join(__dirname, "..", "hooks", "protect.js");
const WINDOWS = process.platform === "win32";
const CONFIG = 'version = 1\n\n[protect]\nglobs = ["tests/krites/**", "docs/SPEC.md", "*.lock"]\n';

const edit = (input, cwd) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd, tool_input: input });
const input = (file) => ({ tool_input: { file_path: file } });

function assertDeny(result, pattern) {
  assert.strictEqual(result.code, 0, "exit code is 0, never 2");
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  assert.strictEqual(out.hookEventName, "PreToolUse");
  assert.strictEqual(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, pattern);
  assert.doesNotMatch(result.stdout + result.stderr, ABSOLUTE, "no absolute path in hook output");
  assert.strictEqual(result.stderr, "", "nothing on stderr, so no stack trace naming the script");
}

const SILENT = { code: 0, stdout: "", stderr: "" };

test("protect: a glob from krites.toml is denied as JSON with exit 0", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "tests", "krites", "a.rs") }, repo)), /tests\/krites\/a\.rs is protected/);
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "docs", "SPEC.md") }, repo)), /docs\/SPEC\.md is protected/);
  assertDeny(await runHook(PROTECT, edit({ path: path.join(repo, "pnpm.lock") }, repo)), /protected/);
  assertDeny(await runHook(PROTECT, edit({ notebook_path: path.join(repo, "tests", "krites", "a.ipynb") }, repo)), /protected/);
  assert.deepStrictEqual(await runHook(PROTECT, edit({ file_path: path.join(repo, "src", "lib.rs") }, repo)), SILENT);
});

test("protect: the built-ins are protected even with an empty [protect]", async () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n\n[protect]\n" } });
  for (const rel of [["krites.toml"], ["sub", "krites.toml"], [".krites", "session-head"], [".krites", "a", "b.json"], [".git", "config"]]) {
    assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, ...rel) }, repo)), /is protected/);
  }
});

test("protect: every path key is checked, not only the first", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const keys = { file_path: path.join(repo, "src", "a.rs"), notebook_path: path.join(repo, "tests", "krites", "x.ipynb") };
  assertDeny(await runHook(PROTECT, edit(keys, repo)), /tests\/krites\/x\.ipynb is protected/);
});

test("protect: matching ignores case and Win32 trailing dots and spaces", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  for (const parts of [["TESTS", "KRITES", "new.rs"], ["tests", "krites..", "new.rs"], ["tests", "krites ", "new.rs"], ["KRITES.TOML"]]) {
    assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, ...parts) }, repo)), /is protected/);
  }
});

test("protect: relative and home-relative paths are denied", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  assertDeny(await runHook(PROTECT, edit({ file_path: "src/x.rs" }, repo)), /not an absolute path/);
  assertDeny(await runHook(PROTECT, edit({ file_path: "~/.bashrc" }, repo)), /not an absolute path/);
});

test("protect: a payload with no path is allowed, a tool input that is not an object is denied", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  assert.deepStrictEqual(await runHook(PROTECT, edit({}, repo)), SILENT);
  for (const bad of ["a string", null, [{ file_path: "x" }]]) assertDeny(await runHook(PROTECT, edit(bad, repo)), /not an object/);
  assertDeny(await runHook(PROTECT, edit({ file_path: 42 }, repo)), /not a plain string/);
});

test("protect: malformed stdin denies", async () => {
  assertDeny(await runHook(PROTECT, "{not json"), /could not read/);
});

test("protect: stdin that never arrives denies at the deadline", { timeout: 15000 }, async () => {
  assertDeny(await runHook(PROTECT, null, { closeStdin: false }), /timed out/);
});

test("protect: the root can come from CLAUDE_PROJECT_DIR, and a cwd in a subfolder still finds it", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG, "src/deep/a.rs": "a\n" } });
  const target = { file_path: path.join(repo, "tests", "krites", "a.rs") };
  assertDeny(await runHook(PROTECT, edit(target, path.join(repo, "src", "deep"))), /is protected/);
  assertDeny(await runHook(PROTECT, edit(target), { env: { CLAUDE_PROJECT_DIR: repo.replace(/\\/g, "/") } }), /is protected/);
});

test("protect: a stray krites.toml above the git toplevel is ignored", async () => {
  const outer = makeDir({ "krites.toml": CONFIG });
  const repo = path.join(outer, "repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  assert.deepStrictEqual(await runHook(PROTECT, edit({ file_path: path.join(repo, "tests", "krites", "a.rs") }, repo)), SILENT);
});

test("protect: a krites.toml tracked at HEAD but missing from the tree denies every edit", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  fs.rmSync(path.join(repo, "krites.toml"));
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "src", "a.rs") }, repo)), /tracked but missing.*\/krites:init/s);
  assertDeny(await runHook(PROTECT, edit({}, repo)), /tracked but missing/);
});

test("protect: a krites.toml deleted from a repo that was gated before denies every edit", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  fs.mkdirSync(path.join(repo, ".krites"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".krites", "session-head"), `${"a".repeat(40)}\n`);
  fs.rmSync(path.join(repo, "krites.toml"));
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "src", "a.rs") }, repo)), /missing from a repo that Krites gated before/);
});

test("protect: a payload that is not an object denies", async () => {
  for (const payload of ['"a string"', "[1,2]", "42", "null"]) {
    assertDeny(await runHook(PROTECT, payload), /not an object/);
  }
});

test("protect: a config that does not parse denies with the line number and /krites:init", async () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n\n[checks]\nnope = 1\n" } });
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "src", "a.rs") }, repo)), /krites\.toml line 4: .*Run \/krites:init\./);
});

test("protect: paths outside the repo are denied", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const outside = path.join(tmp, "outside-target");
  fs.mkdirSync(path.join(repo, "tests", "krites"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  assert.strictEqual(decide(input(path.join(repo, "src", "lib.rs")), roots), null);
  assert.strictEqual(decide(input(path.join(repo, "new", "deep", "file.rs")), roots), null);
  assert.match(decide(input(path.join(repo, "..", "outside-target", "x.txt")), roots), /outside the repository/);
  assert.match(decide(input(repo), roots), /outside the repository/);

  const elsewhere = WINDOWS ? `${repo[0].toUpperCase() === "Q" ? "R" : "Q"}:\\elsewhere\\x.txt` : "/krites-nowhere/x.txt";
  for (const target of [elsewhere, "\\\\fileserver\\share\\x.txt", "//fileserver/share/x.txt"]) {
    const reason = decide(input(target), roots);
    // On POSIX the backslash form is a relative file name, which is denied for that reason instead.
    assert.match(reason, /x\.txt (resolves outside the repository|is not an absolute path)/);
    assert.doesNotMatch(reason, ABSOLUTE);
  }

  fs.symlinkSync(outside, path.join(repo, "link"), "junction");
  assert.match(decide(input(path.join(repo, "link", "escaped.txt")), roots), /outside the repository/);

  fs.symlinkSync(path.join(repo, "tests", "krites"), path.join(repo, "alias"), "junction");
  assert.match(decide(input(path.join(repo, "alias", "x.rs")), roots), /tests\/krites\/x\.rs is protected/);

  fs.symlinkSync(path.join(tmp, "not-created-yet"), path.join(repo, "dangling"), "junction");
  assert.match(decide(input(path.join(repo, "dangling", "x.txt")), roots), /could not be resolved|outside the repository/);

  const linked = path.join(tmp, "repo-link");
  fs.symlinkSync(repo, linked, "junction");
  assert.strictEqual(decide(input(path.join(linked, "src", "lib.rs")), roots), null);
});

test("protect: the deepest root decides which globs apply", () => {
  const repo = makeRepo({
    files: { "krites.toml": 'version = 1\n\n[protect]\nglobs = ["**/secret.txt"]\n', "inner/krites.toml": 'version = 1\n\n[protect]\nglobs = ["own.txt"]\n' },
  });
  const inner = path.join(repo, "inner");
  for (const roots of [findRoots({ cwd: inner, projectDir: repo, processCwd: tmp }), findRoots({ cwd: repo, projectDir: inner, processCwd: tmp })]) {
    assert.strictEqual(roots.length, 2);
    assert.match(decide(input(path.join(inner, "own.txt")), roots), /own\.txt is protected/);
    assert.strictEqual(decide(input(path.join(inner, "secret.txt")), roots), null, "the inner root decides, and it does not protect secret.txt");
    assert.match(decide(input(path.join(repo, "secret.txt")), roots), /secret\.txt is protected/);
  }
});

test("protect: a colon in the relative path denies on Windows", async () => {
  if (!WINDOWS) return;
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  assertDeny(await runHook(PROTECT, edit({ file_path: `${path.join(repo, "a.txt")}:stream` }, repo)), /a\.txt:stream/);
});
