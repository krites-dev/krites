const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { configHash, readBaseline, readConfigHash, writeBaseline } = require("../lib/state.js");
const { assertBlock, configure, git, head, makeRepo, runHook, script, seed, tmp, toml } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });

let markers = 0;

// The marker proves whether a check ran, and it lives outside the repo so it cannot change the tree itself.
function guarded(globs) {
  const repo = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } });
  const marker = path.join(tmp, `marker${++markers}.txt`);
  configure(repo, { commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)], globs });
  seed(repo);
  return { repo, ran: () => fs.existsSync(marker) };
}

test("bypass: a protected file changed since the baseline refutes before any check runs", async () => {
  const { repo, ran } = guarded(["secrets/**"]);
  fs.writeFileSync(path.join(repo, "secrets", "rule.md"), "weakened\n");

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: secrets\/rule\.md/);
  assert.strictEqual(ran(), false, "no check runs once a protected path changed");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8")).verdict, "refuted");
});

test("bypass: a protected path blocks until the budget is spent, then the stop is allowed", async () => {
  const { repo, ran } = guarded(["secrets/**"]);
  fs.writeFileSync(path.join(repo, "secrets", "rule.md"), "weakened\n");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: secrets\/rule\.md/);
  }
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), { code: 0, stdout: "", stderr: "" });

  const run = JSON.parse(fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8"));
  assert.strictEqual(run.verdict, "refuted");
  assert.deepStrictEqual(run.checks, [], "an exhausted protected path still runs no check");
  assert.strictEqual(run.reason, "attempt budget exhausted");
  assert.strictEqual(ran(), false);
});

test("bypass: an untracked new file under a protected glob refutes", async () => {
  const { repo, ran } = guarded(["secrets/**"]);
  fs.writeFileSync(path.join(repo, "secrets", "extra.md"), "new\n");

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: secrets\/extra\.md/);
  assert.strictEqual(ran(), false);
});

test("bypass: a protected change that was committed since the baseline still refutes", async () => {
  const { repo, ran } = guarded(["secrets/**"]);
  fs.writeFileSync(path.join(repo, "secrets", "rule.md"), "weakened\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "weaken");

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: secrets\/rule\.md/);
  assert.strictEqual(ran(), false);
});

test("bypass: changes under .claude/worktrees are not protected paths, so the checks still run", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } });
  configure(repo, { commands: [script("process.exit(7)")], globs: [".claude/**", "secrets/**"] });
  seed(repo);
  fs.mkdirSync(path.join(repo, ".claude", "worktrees", "w"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "worktrees", "w", "x.txt"), "worktree\n");

  const reason = assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /check\d+\.js/);
  assert.ok(!reason.includes("protected path changed"), "a worktree folder is another checkout, not a protected change");
});

test("bypass: a root below the git toplevel matches globs against its own paths", async () => {
  const repo = makeRepo({ files: { "top.txt": "t\n", "sub/a.txt": "a\n", "sub/tests/krites/t.js": "t\n" } });
  const root = path.join(repo, "sub");
  fs.writeFileSync(path.join(root, "krites.toml"), toml({ commands: [script("process.exit(0)")], globs: ["tests/krites/**"] }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "config");
  seed(root, repo);
  fs.writeFileSync(path.join(root, "tests", "krites", "t.js"), "weakened\n");

  assertBlock(await runHook(GATE, stop(root), { cwd: root }), /protected path changed: tests\/krites\/t\.js/);
});

test("bypass: a protected file moved out of its glob is still named by its old path", async () => {
  for (const commit of [false, true]) {
    const { repo, ran } = guarded(["secrets/**"]);
    git(repo, "mv", "secrets/rule.md", "moved.md");
    if (commit) git(repo, "commit", "-q", "-m", "move");
    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: secrets\/rule\.md/);
    assert.strictEqual(ran(), false, `commit=${commit}`);
  }
});

test("bypass: an untracked krites.toml that has not changed since session start passes", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  fs.writeFileSync(path.join(repo, "krites.toml"), toml({ commands: [script("process.exit(0)")] }));
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), { code: 0, stdout: "", stderr: "" });
});

test("bypass: krites.toml edited mid-session is refuted, tracked or not", async () => {
  for (const tracked of [false, true]) {
    const repo = makeRepo({ files: { "a.txt": "a\n" } });
    const config = toml({ commands: [script("process.exit(0)")] });
    if (tracked) configure(repo, config);
    else fs.writeFileSync(path.join(repo, "krites.toml"), config);
    seed(repo);
    fs.appendFileSync(path.join(repo, "krites.toml"), "\n# weakened\n");

    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: krites\.toml/, `tracked=${tracked}`);
  }
});

test("bypass: weakening the config and deleting .krites is refuted, never passed", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  const ran = path.join(tmp, `weakened${++markers}.txt`);
  configure(repo, { commands: [script("process.exit(1)")] });
  seed(repo);
  fs.writeFileSync(path.join(repo, "krites.toml"), toml({ commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran");`)] }));
  fs.rmSync(path.join(repo, ".krites"), { recursive: true, force: true });

  const reason = assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: krites\.toml/);
  assert.match(reason, /run \/krites:init to approve it\.$/, "the reason says how a human approves the edit");
  assert.strictEqual(fs.existsSync(ran), false, "the weakened check never ran");
  assert.strictEqual(readBaseline(repo), null, "nothing was advanced");
});

test("bypass: a root the session never saw records its config hash after a passing run", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] });
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), { code: 0, stdout: "", stderr: "" });
  assert.strictEqual(readConfigHash(repo), configHash(repo), "the record is written once the run passed");

  fs.writeFileSync(path.join(repo, "a.txt"), "changed twice\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), { code: 0, stdout: "", stderr: "" }, "the next stop is not refuted");
});

test("bypass: a missing config-hash record with a valid baseline is refuted", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] });
  writeBaseline(repo, head(repo));
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: krites\.toml/);
});

test("bypass: a nested krites.toml stays protected through the glob and git", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] });
  seed(repo);
  fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(repo, "vendor", "krites.toml"), "version = 1\n");

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: vendor\/krites\.toml/);
});

test("bypass: a protected path elsewhere in .claude still refutes", async () => {
  const { repo } = guarded([".claude/**"]);
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "{}\n");

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: \.claude\/settings\.json/);
});
