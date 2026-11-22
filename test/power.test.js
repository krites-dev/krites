const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { readBaseline } = require("../lib/state.js");
const { ABSOLUTE, assertBlock, configure, head, makeDir, makeRepo, runCli, runHook, script, seed, tmp, trust } = require("./helpers.js");

const hook = (name) => path.join(__dirname, "..", "hooks", `${name}.js`);
const [PROTECT, COMMIT, GATE, SESSION] = ["protect", "commit", "gate", "session"].map(hook);
const SILENT = { code: 0, stdout: "", stderr: "" };

const NOTE = "Krites is off in every session until /krites:on: no edit is blocked, no commit is held and no stop is checked.";
const TURNED_OFF =
  "Krites is off in every session until you run /krites:on: no edit is blocked, no commit is held and no stop is checked. Every session start and every stop says so, and /krites:receipt signs nothing meanwhile.";
const TURNED_ON = "Krites is on: edits, commits and stops are checked again. A protected path changed while it was off is refuted at the next stop.";
const NO_RECEIPT = "Krites is off, so /krites:receipt signs nothing. Run /krites:on first.";
const NO_CHECKS = "krites.toml configures no checks, so nothing is being checked until [checks].commands names a command.";
const UNREAD = "the Krites session hook could not read its input, so the stop gate may compare against a stale baseline.";

const edit = (file, cwd) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", session_id: "s1", cwd, tool_input: { file_path: file } });
const bash = (cwd, command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1", cwd, tool_input: { command } });
const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });
const start = (cwd) => ({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd });

// One config directory per test, so no test reads another's marker.
const world = () => ({ KRITES_CONFIG_DIR: makeDir() });
const marker = (env) => path.join(env.KRITES_CONFIG_DIR, "off");
const decision = (result) => JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;

function told(result) {
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  const out = JSON.parse(result.stdout);
  assert.deepStrictEqual(Object.keys(out), ["systemMessage"], "shown to the user, never context for the model, never a decision");
  assert.doesNotMatch(out.systemMessage, ABSOLUTE, "no absolute path in what the user sees");
  return out.systemMessage;
}

function changed(check, env) {
  const repo = makeRepo({ files: { "a.txt": "a\n", "tests/krites/t.rs": "t\n" } });
  configure(repo, { commands: [script(check)], globs: ["tests/krites/**"] });
  seed(repo);
  if (env) trust(repo, env.KRITES_CONFIG_DIR);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  return repo;
}

test("power: /krites:off writes one marker in the Krites config directory, and /krites:on removes it", async () => {
  const env = { KRITES_CONFIG_DIR: path.join(makeDir(), "not-made-yet") };
  for (let turn = 1; turn <= 2; turn += 1) {
    assert.deepStrictEqual(await runCli(["off"], { env }), { code: 0, stdout: `${TURNED_OFF}\n`, stderr: "" }, `off, run ${turn}`);
    assert.deepStrictEqual(fs.readdirSync(env.KRITES_CONFIG_DIR), ["off"], "the marker and nothing else");
  }
  for (let turn = 1; turn <= 2; turn += 1) {
    assert.deepStrictEqual(await runCli(["on"], { env }), { code: 0, stdout: `${TURNED_ON}\n`, stderr: "" }, `on, run ${turn}`);
    assert.deepStrictEqual(fs.readdirSync(env.KRITES_CONFIG_DIR), []);
  }
});

test("power: a marker that is a folder still reads as off, and /krites:on removes it", async () => {
  const env = world();
  fs.mkdirSync(path.join(marker(env), "inner"), { recursive: true });
  assert.strictEqual(told(await runHook(GATE, stop(tmp), { env })), NOTE);
  await runCli(["on"], { env });
  assert.strictEqual(fs.existsSync(marker(env)), false);
  assert.deepStrictEqual(await runHook(GATE, stop(tmp), { env }), SILENT);
});

test("power: off and on take no argument, and anything else is answered with the usage line alone", async () => {
  const env = world();
  for (const args of [["off", "now"], ["on", "--force"]]) {
    const result = await runCli(args, { env });
    assert.match(result.stdout, /^usage: .*\/krites:off, \/krites:on\n$/, args.join(" "));
  }
  assert.strictEqual(fs.existsSync(marker(env)), false, "nothing was switched");
});

test("power: while off the protect hook answers nothing, for a protected path, krites.toml and a path outside the repo", async () => {
  const env = world();
  const repo = changed("process.exit(1)");
  const targets = [path.join(repo, "tests", "krites", "t.rs"), path.join(repo, "krites.toml"), path.join(tmp, "outside-while-off.txt")];
  const denied = async (when) => {
    for (const file of targets) assert.strictEqual(decision(await runHook(PROTECT, edit(file, repo), { cwd: repo, env })), "deny", `${when}: ${file}`);
  };

  await denied("before");
  await runCli(["off"], { env });
  for (const file of targets) assert.deepStrictEqual(await runHook(PROTECT, edit(file, repo), { cwd: repo, env }), SILENT, file);
  assert.deepStrictEqual(await runHook(PROTECT, "{not json", { cwd: repo, env }), SILENT, "input it cannot read blocks nothing either");
  await runCli(["on"], { env });
  await denied("after");
});

test("power: the edit tools cannot write the marker, whatever allow_outside says", async () => {
  const env = world();
  const dir = env.KRITES_CONFIG_DIR.replace(/\\/g, "/");
  fs.writeFileSync(path.join(env.KRITES_CONFIG_DIR, "config.toml"), `[protect]\nallow_outside = ["${dir}/**"]\n`);
  const repo = changed("process.exit(1)");
  const result = await runHook(PROTECT, { ...edit(marker(env), repo), permission_mode: "default" }, { cwd: repo, env });
  assert.strictEqual(decision(result), "deny", "never asked, never allowed");
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /own configuration/);
});

test("power: while off the commit hook holds nothing", async () => {
  const env = world();
  const repo = changed("process.exit(1)");
  const commit = bash(repo, "git commit -am wip");
  assert.match((await runHook(COMMIT, commit, { cwd: repo, env })).stdout, /Krites held the commit/);
  await runCli(["off"], { env });
  assert.deepStrictEqual(await runHook(COMMIT, commit, { cwd: repo, env }), SILENT);
});

test("power: while off a stop runs no check, blocks nothing, writes nothing and tells the user; on again it blocks", async () => {
  const env = world();
  const repo = changed("process.exit(1)", env);
  await runCli(["off"], { env });

  assert.strictEqual(told(await runHook(GATE, stop(repo), { cwd: repo, env })), NOTE);
  assert.strictEqual(fs.existsSync(path.join(repo, ".krites", "last-run.json")), false, "no run is recorded");
  assert.strictEqual(fs.existsSync(path.join(repo, ".krites", "block-count")), false, "no attempt is spent");
  assert.strictEqual(told(await runHook(GATE, "{not json", { cwd: repo, env })), NOTE, "input it cannot read blocks nothing either");
  assert.strictEqual(told(await runHook(GATE, stop(tmp), { env })), NOTE, "every stop says so, in a folder Krites does not gate too");

  await runCli(["on"], { env });
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo, env }), /refuted/);
});

test("power: a gate whose checks were running when Krites was turned off lets the stop through", async () => {
  const env = world();
  const repo = changed(`require("node:fs").writeFileSync(${JSON.stringify(marker(env))}, "x"); process.exit(1);`, env);
  assert.strictEqual(told(await runHook(GATE, stop(repo), { cwd: repo, env })), NOTE);
});

test("power: the session start says Krites is off first, and still records the baseline", async () => {
  const env = world();
  const repo = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [] });
  trust(repo, env.KRITES_CONFIG_DIR);
  await runCli(["off"], { env });

  assert.strictEqual(told(await runHook(SESSION, start(repo), { cwd: repo, env })), `${NOTE}\n${NO_CHECKS}`);
  assert.strictEqual(readBaseline(repo), head(repo), "so a /krites:on later in the session judges from this start");
  assert.strictEqual(told(await runHook(SESSION, start(tmp), { env })), NOTE, "a folder Krites does not gate is told too");
  assert.strictEqual(told(await runHook(SESSION, "{not json", { env })), `${NOTE}\n${UNREAD}`);
});

test("power: /krites:receipt signs nothing while off, /krites:verify says it is off, and on again the run is signed", async () => {
  const env = world();
  const repo = changed("console.log('fine')", env);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT, "a passing gate, recorded before the switch");
  await runCli(["off"], { env });

  assert.deepStrictEqual(await runCli(["receipt"], { cwd: repo, env }), { code: 0, stdout: `${NO_RECEIPT}\n`, stderr: "" });
  assert.strictEqual(fs.existsSync(path.join(repo, "receipts")), false, "a refusal writes no receipts directory");
  const verified = await runCli(["verify"], { cwd: repo, env });
  assert.match(verified.stdout, /\nexit 0\n/, "the checks still run when a person asks");
  assert.ok(verified.stdout.endsWith(`\n${NOTE}\n`), verified.stdout);

  await runCli(["on"], { env });
  assert.match((await runCli(["receipt"], { cwd: repo, env })).stdout, /^receipts\/[0-9A-Za-z._-]+\.json\nreceipts\/[0-9A-Za-z._-]+\.md\n$/);
});
