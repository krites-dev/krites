const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { makeDir, makeRepo, runHook } = require("./helpers.js");

const PROTECT = path.join(__dirname, "..", "hooks", "protect.js");
const SILENT = { code: 0, stdout: "", stderr: "" };

const edit = (file, cwd) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd, tool_input: { file_path: file } });

async function assertInert(dir, extraEnv) {
  for (const rel of ["src/a.rs", "krites.toml", ".krites/session-head", ".git/config", "tests/krites/a.rs"]) {
    assert.deepStrictEqual(await runHook(PROTECT, edit(path.join(dir, rel), dir), { env: extraEnv }), SILENT, rel);
  }
  assert.strictEqual(fs.existsSync(path.join(dir, ".krites")), false, "nothing is written");
}

test("inert: a git repo with no krites.toml gets no output and no state", async () => {
  await assertInert(makeRepo({ files: { "src/a.rs": "a\n" } }));
});

test("inert: a directory that is not a git repo is inert too", async () => {
  await assertInert(makeDir({ "src/a.rs": "a\n" }));
});

test("inert: CLAUDE_PROJECT_DIR without a krites.toml changes nothing", async () => {
  const dir = makeRepo({ files: { "src/a.rs": "a\n" } });
  await assertInert(dir, { CLAUDE_PROJECT_DIR: dir.replace(/\\/g, "/") });
});

test("inert: malformed input still denies, because failing closed outranks being inert", async () => {
  const result = await runHook(PROTECT, "{not json");
  assert.strictEqual(result.code, 0);
  assert.strictEqual(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
