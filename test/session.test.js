const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { readBlockCount, writeBlockCount } = require("../lib/state.js");
const { ABSOLUTE, assertBlock, configure, git, head, makeDir, makeRepo, runCli, runHook, script, toml } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const SESSION = path.join(__dirname, "..", "hooks", "session.js");
const SILENT = { code: 0, stdout: "", stderr: "" };

const start = (cwd) => ({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd });
const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });
const baseline = (repo) => fs.readFileSync(path.join(repo, ".krites", "session-head"), "utf8").trim();

const NUDGE = "Krites is installed but this repo has no krites.toml, so nothing is being checked. Run /krites:init to create one.";
const NO_CHECKS = "krites.toml configures no checks, so nothing is being checked until [checks].commands names a command.";
const SLOW_ONLY = "krites.toml runs no check at a stop; [checks].slow runs only under /krites:verify.";
const GAVE_UP = "in the last session the Krites stop gate gave up after 3 blocked attempts, so that work ended without passing its checks. Run /krites:verify.";
const NOT_PARSED = "Krites is not running: krites.toml line 4: unknown key checks.nope. Run /krites:init.";
const FAILED = (what) => `the Krites session hook ${what}, so the stop gate may compare against a stale baseline.`;

function message(result) {
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  const out = JSON.parse(result.stdout);
  assert.deepStrictEqual(Object.keys(out), ["systemMessage"], "shown to the user, never context for the model, never a decision");
  assert.doesNotMatch(out.systemMessage, ABSOLUTE, "no absolute path in what the user sees");
  assert.doesNotMatch(out.systemMessage, /Tell the user/);
  return out.systemMessage;
}

test("session: a git repo with no krites.toml tells the user to run /krites:init", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  assert.strictEqual(message(await runHook(SESSION, start(repo), { cwd: repo })), NUDGE);
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
  assert.strictEqual(message(await runHook(SESSION, start(repo), { cwd: repo })), NO_CHECKS);
  assert.strictEqual(baseline(repo), head(repo));
});

test("session: slow checks alone say they run only under /krites:verify; both empty keep the no-checks line", async () => {
  const slowOnly = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [], slow: [script("")] });
  assert.strictEqual(message(await runHook(SESSION, start(slowOnly), { cwd: slowOnly })), SLOW_ONLY);
  const empty = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [], slow: [] });
  assert.strictEqual(message(await runHook(SESSION, start(empty), { cwd: empty })), NO_CHECKS);
  const both = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [script("")], slow: [script("")] });
  assert.deepStrictEqual(await runHook(SESSION, start(both), { cwd: both }), SILENT);
});

test("session: a spent budget is reported in one line, and every start resets the counter", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [script("")] });
  writeBlockCount(repo, 4);

  assert.strictEqual(message(await runHook(SESSION, start(repo), { cwd: repo })), GAVE_UP);
  assert.strictEqual(readBlockCount(repo), 0);

  writeBlockCount(repo, 3);
  assert.deepStrictEqual(await runHook(SESSION, start(repo), { cwd: repo }), SILENT, "a counter at the budget never gave up");
  assert.strictEqual(readBlockCount(repo), 0, "the counter is reset either way");
});

test("session: a /clear reports a spent budget and resets the counter, but keeps the baseline and the approved config", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [script("")] });
  await runHook(SESSION, start(repo), { cwd: repo });
  const before = baseline(repo);
  const hash = fs.readFileSync(path.join(repo, ".krites", "config-hash"), "utf8");
  fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
  git(repo, "commit", "-qam", "b");
  fs.appendFileSync(path.join(repo, "krites.toml"), "\n");
  writeBlockCount(repo, 4);
  const clear = { ...start(repo), source: "clear" };

  assert.strictEqual(message(await runHook(SESSION, clear, { cwd: repo })), GAVE_UP);
  assert.strictEqual(readBlockCount(repo), 0);
  assert.strictEqual(baseline(repo), before, "work since the last stop stays judged: an interrupted turn ran no gate");
  assert.strictEqual(fs.readFileSync(path.join(repo, ".krites", "config-hash"), "utf8"), hash, "a krites.toml changed since startup stays unapproved");

  writeBlockCount(repo, 2);
  assert.deepStrictEqual(await runHook(SESSION, clear, { cwd: repo }), SILENT);
  assert.strictEqual(readBlockCount(repo), 0);
});

test("session: a /clear in a root whose config does not parse still says Krites is not running", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), "version = 1\n\n[checks]\nnope = 1\n");
  assert.strictEqual(message(await runHook(SESSION, { ...start(repo), source: "clear" }, { cwd: repo })), NOT_PARSED);
});

test("session: a /clear in a repo with no krites.toml, or one with no checks, says nothing", async () => {
  const bare = makeRepo({ files: { "a.txt": "a\n" } });
  assert.deepStrictEqual(await runHook(SESSION, { ...start(bare), source: "clear" }, { cwd: bare }), SILENT);
  const empty = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [] });
  assert.deepStrictEqual(await runHook(SESSION, { ...start(empty), source: "clear" }, { cwd: empty }), SILENT);
});

test("session: a spent budget and an empty command list are two lines", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [] });
  writeBlockCount(repo, 4);

  assert.deepStrictEqual(message(await runHook(SESSION, start(repo), { cwd: repo })).split("\n"), [GAVE_UP, NO_CHECKS]);
});

test("session: a root whose config does not parse is reported and reset too", async () => {
  const broken = "version = 1\n\n[checks]\nnope = 1\n";
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), broken);
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /krites\.toml line 4: /);
  assert.strictEqual(readBlockCount(repo), 0, "the gate spends no attempt on a config error");
  // The count a broken root can carry is what its blocks spent while the config still loaded.
  writeBlockCount(repo, 4);

  assert.deepStrictEqual(message(await runHook(SESSION, start(repo), { cwd: repo })).split("\n"), [GAVE_UP, NOT_PARSED]);
  assert.strictEqual(readBlockCount(repo), 0, "a config error no longer keeps the counter across sessions");
  assert.strictEqual(fs.existsSync(path.join(repo, ".krites", "session-head")), false, "still no baseline");

  const untouched = configure(makeRepo({ files: { "a.txt": "a\n" } }), broken);
  assert.strictEqual(message(await runHook(SESSION, start(untouched), { cwd: untouched })), NOT_PARSED);
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
  const lines = message(result).split("\n");
  const failed = /^the Krites session hook failed \(E[A-Z]+\), so the stop gate may compare against a stale baseline\.$/;
  assert.strictEqual(lines.filter((line) => line === GAVE_UP).length, 2, result.stdout);
  assert.strictEqual(lines.filter((line) => failed.test(line)).length, 1, result.stdout);
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

test("session: a payload that is not an object records nothing and stays silent", async () => {
  assert.deepStrictEqual(await runHook(SESSION, '"a string"'), SILENT);
});

test("session: a config that does not parse is reported in one line and no baseline is written", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), "version = 1\n\n[checks]\nnope = 1\n");
  assert.strictEqual(message(await runHook(SESSION, start(repo), { cwd: repo })), NOT_PARSED);
  assert.strictEqual(fs.existsSync(path.join(repo, ".krites", "session-head")), false);
});

test("session: a repo with no commits writes an empty baseline", async () => {
  const repo = makeRepo({ files: { "krites.toml": toml({ commands: [script("")] }), "a.txt": "a\n" }, commit: false });
  assert.deepStrictEqual(await runHook(SESSION, start(repo), { cwd: repo }), SILENT);
  assert.strictEqual(baseline(repo), "");
});

test("session: malformed input is reported to the user and never blocks the session", async () => {
  assert.strictEqual(message(await runHook(SESSION, "{not json")), FAILED("could not read its input"));
});

test("session: a fresh startup drops an approval, even one whose baseline matches again", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } }), { commands: [script("")], globs: ["secrets/**"] });
  await runHook(SESSION, start(repo), { cwd: repo });
  const first = baseline(repo);
  fs.writeFileSync(path.join(repo, "secrets", "rule.md"), "sanctioned\n");
  git(repo, "commit", "-q", "-am", "sanctioned");
  await runCli(["approve"], { cwd: repo });
  await runCli(["approve", "--write"], { cwd: repo });
  const approved = path.join(repo, ".krites", "approved-head");
  assert.ok(fs.existsSync(approved), "the approval was written");

  git(repo, "reset", "-q", "--hard", first);
  await runHook(SESSION, start(repo), { cwd: repo });
  assert.strictEqual(baseline(repo), first);
  assert.strictEqual(fs.existsSync(approved), false);
});

test("session: a fresh startup drops an approval even when krites.toml does not parse", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } }), { commands: [script("")], globs: ["secrets/**"] });
  await runHook(SESSION, start(repo), { cwd: repo });
  fs.writeFileSync(path.join(repo, "secrets", "rule.md"), "sanctioned\n");
  git(repo, "commit", "-q", "-am", "sanctioned");
  await runCli(["approve"], { cwd: repo });
  await runCli(["approve", "--write"], { cwd: repo });
  const approved = path.join(repo, ".krites", "approved-head");
  assert.ok(fs.existsSync(approved), "the approval was written");

  fs.writeFileSync(path.join(repo, "krites.toml"), "version = 1\n\n[checks]\nnope = 1\n");
  assert.strictEqual(message(await runHook(SESSION, start(repo), { cwd: repo })), NOT_PARSED);
  assert.strictEqual(fs.existsSync(approved), false);
});

test("session: a /clear keeps an approval along with the baseline it was made against", async () => {
  const repo = configure(makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } }), { commands: [script("")], globs: ["secrets/**"] });
  await runHook(SESSION, start(repo), { cwd: repo });
  fs.writeFileSync(path.join(repo, "secrets", "rule.md"), "sanctioned\n");
  git(repo, "commit", "-q", "-am", "sanctioned");
  await runCli(["approve"], { cwd: repo });
  await runCli(["approve", "--write"], { cwd: repo });
  const approved = path.join(repo, ".krites", "approved-head");
  const pair = fs.readFileSync(approved, "utf8");

  assert.deepStrictEqual(await runHook(SESSION, { ...start(repo), source: "clear" }, { cwd: repo }), SILENT);
  assert.strictEqual(fs.readFileSync(approved, "utf8"), pair);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT, "the next stop is still excused");
});
