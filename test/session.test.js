const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { readBlockCount, writeBlockCount } = require("../lib/state.js");
const { ABSOLUTE, assertBlock, configure, git, head, makeDir, makeRepo, runHook, script, toml } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const SESSION = path.join(__dirname, "..", "hooks", "session.js");
const SILENT = { code: 0, stdout: "", stderr: "" };

const start = (cwd) => ({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd });
const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });
const baseline = (repo) => fs.readFileSync(path.join(repo, ".krites", "session-head"), "utf8").trim();

function assertOneLine(result) {
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.doesNotMatch(result.stdout, ABSOLUTE, "no absolute path in the line the model receives");
  assert.strictEqual(result.stdout.trimEnd().split("\n").length, 1, `exactly one line: ${result.stdout}`);
  assert.doesNotMatch(result.stdout, /"decision"|permissionDecision/, "SessionStart never blocks");
  return result.stdout;
}

test("session: a git repo with no krites.toml gets one line telling the user to run /krites:init", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  const line = assertOneLine(await runHook(SESSION, start(repo), { cwd: repo }));
  assert.match(line, /krites\.toml/);
  assert.match(line, /\/krites:init/);
  assert.strictEqual(fs.existsSync(path.join(repo, ".krites")), false, "the nudge writes nothing");
});

test("session: a directory that is not a git work tree stays silent", async () => {
  const dir = makeDir({ "a.txt": "a\n" });
  assert.deepStrictEqual(await runHook(SESSION, start(dir), { cwd: dir }), SILENT);
});

test("session: a valid root records HEAD, overwrites an older baseline, and hides .krites from git", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [script("")] });
  fs.mkdirSync(path.join(repo, ".krites"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".krites", "session-head"), "0000000000000000000000000000000000000000");

  assert.deepStrictEqual(await runHook(SESSION, start(repo), { cwd: repo }), SILENT);
  assert.strictEqual(baseline(repo), head(repo));
  assert.strictEqual(fs.readFileSync(path.join(repo, ".krites", ".gitignore"), "utf8").trim(), "*");
  assert.strictEqual(git(repo, "status", "--porcelain").stdout.toString().trim(), "", ".krites never dirties the tree");
});

test("session: the root can come from CLAUDE_PROJECT_DIR", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [script("")] });
  await runHook(SESSION, start(undefined), { cwd: repo, env: { CLAUDE_PROJECT_DIR: repo.replace(/\\/g, "/") } });
  assert.strictEqual(baseline(repo), head(repo));
});

test("session: an empty command list says so in one line, and still records the baseline", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [] });
  const line = assertOneLine(await runHook(SESSION, start(repo), { cwd: repo }));
  assert.match(line, /no checks|nothing is being checked/i);
  assert.strictEqual(baseline(repo), head(repo));
});

test("session: slow checks alone say they run only under /krites:verify; both empty keep the no-checks line", async () => {
  const slowOnly = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [], slow: [script("")] });
  assert.strictEqual(
    assertOneLine(await runHook(SESSION, start(slowOnly), { cwd: slowOnly })).trimEnd(),
    "Tell the user: krites.toml runs no check at a stop; [checks].slow runs only under /krites:verify.",
  );
  const empty = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [], slow: [] });
  assert.strictEqual(
    assertOneLine(await runHook(SESSION, start(empty), { cwd: empty })).trimEnd(),
    "Tell the user: krites.toml configures no checks, so nothing is being checked until [checks].commands names a command.",
  );
  const both = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [script("")], slow: [script("")] });
  assert.deepStrictEqual(await runHook(SESSION, start(both), { cwd: both }), SILENT);
});

test("session: a spent budget is reported in one line, and every start resets the counter", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [script("")] });
  writeBlockCount(repo, 4);

  const line = assertOneLine(await runHook(SESSION, start(repo), { cwd: repo }));
  assert.match(line, /gave up after 3 blocked attempts/);
  assert.match(line, /\/krites:verify/);
  assert.strictEqual(readBlockCount(repo), 0);

  writeBlockCount(repo, 3);
  assert.deepStrictEqual(await runHook(SESSION, start(repo), { cwd: repo }), SILENT, "a counter at the budget never gave up");
  assert.strictEqual(readBlockCount(repo), 0, "the counter is reset either way");
});

test("session: a spent budget and an empty command list are two lines", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [] });
  writeBlockCount(repo, 4);

  const result = await runHook(SESSION, start(repo), { cwd: repo });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.doesNotMatch(result.stdout, ABSOLUTE);
  const lines = result.stdout.trimEnd().split("\n");
  assert.strictEqual(lines.length, 2, result.stdout);
  assert.match(lines[0], /gave up after 3 blocked attempts/);
  assert.match(lines[1], /nothing is being checked/);
});

test("session: a root whose config does not parse is reported and reset too", async () => {
  const broken = "version = 1\n\n[checks]\nnope = 1\n";
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), broken);
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /krites\.toml line 4: /);
  assert.strictEqual(readBlockCount(repo), 0, "the gate spends no attempt on a config error");
  // The count a broken root can carry is what its blocks spent while the config still loaded.
  writeBlockCount(repo, 4);

  const result = await runHook(SESSION, start(repo), { cwd: repo });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.strictEqual(lines.length, 2, result.stdout);
  assert.match(lines[0], /gave up after 3 blocked attempts/);
  assert.match(lines[1], /krites\.toml line 4: /);
  assert.strictEqual(readBlockCount(repo), 0, "a config error no longer keeps the counter across sessions");
  assert.strictEqual(fs.existsSync(path.join(repo, ".krites", "session-head")), false, "still no baseline");

  const untouched = configure(makeRepo({ files: { "a.txt": "a\n" } }), broken);
  assertOneLine(await runHook(SESSION, start(untouched), { cwd: untouched }));
  assert.strictEqual(fs.existsSync(path.join(untouched, ".krites")), false, "a counter already at 0 is not written back");
});

test("session: one root that cannot record its baseline does not cost the next root its report and reset", async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [script("")] }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [script("")] }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  writeBlockCount(inner, 4);
  writeBlockCount(outer, 4);
  // Not empty, so the plugin's own repair cannot clear it and the baseline write really fails.
  fs.mkdirSync(path.join(inner, ".krites", "session-head"));
  fs.writeFileSync(path.join(inner, ".krites", "session-head", "held.txt"), "held\n");

  const result = await runHook(SESSION, start(inner), { cwd: inner, env: { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") } });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.doesNotMatch(result.stdout, ABSOLUTE);
  const lines = result.stdout.trimEnd().split("\n");
  assert.strictEqual(lines.filter((line) => /gave up after 3 blocked attempts/.test(line)).length, 2, result.stdout);
  assert.strictEqual(lines.filter((line) => /session hook failed \(E[A-Z]+\)/.test(line)).length, 1, result.stdout);
  assert.strictEqual(readBlockCount(inner), 0);
  assert.strictEqual(readBlockCount(outer), 0, "the root behind the failing one is reset too");
  assert.strictEqual(baseline(outer), head(outer), "and gets its baseline");
});

test("session: the config hash is recorded next to the baseline", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [script("")] });
  fs.appendFileSync(path.join(repo, "krites.toml"), "# edited before the session started\n");
  assert.deepStrictEqual(await runHook(SESSION, start(repo), { cwd: repo }), SILENT);

  const expected = crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, "krites.toml"))).digest("hex");
  assert.strictEqual(fs.readFileSync(path.join(repo, ".krites", "config-hash"), "utf8").trim(), expected);
});

test("session: a payload that is not an object records nothing and never blocks", async () => {
  const result = await runHook(SESSION, '"a string"');
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.doesNotMatch(result.stdout, /"decision"/);
});

test("session: a config that does not parse is reported in one line and no baseline is written", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), "version = 1\n\n[checks]\nnope = 1\n");
  const line = assertOneLine(await runHook(SESSION, start(repo), { cwd: repo }));
  assert.match(line, /krites\.toml line 4: .*Run \/krites:init\./);
  assert.strictEqual(fs.existsSync(path.join(repo, ".krites", "session-head")), false);
});

test("session: a repo with no commits writes an empty baseline", async () => {
  const repo = makeRepo({ files: { "krites.toml": toml({ commands: [script("")] }), "a.txt": "a\n" }, commit: false });
  assert.deepStrictEqual(await runHook(SESSION, start(repo), { cwd: repo }), SILENT);
  assert.strictEqual(baseline(repo), "");
});

test("session: malformed input never blocks the session", async () => {
  const result = await runHook(SESSION, "{not json");
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.doesNotMatch(result.stdout, /"decision"/);
});
