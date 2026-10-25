const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { loadConfig } = require("../lib/config.js");
const { contentHash, readBaseline, readBlockCount, readConfigHash, trimTouched, writeBlockCount } = require("../lib/state.js");
const { ABSOLUTE, assertBlock, configure, FAKE, fromTmp, git, head, makeDir, makeRepo, runCli, runHook, script, seed, textOf, tmp, toml } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const SILENT = { code: 0, stdout: "", stderr: "" };
const WINDOWS = process.platform === "win32";
const BROKEN = "version = 1\n\n[checks]\nnope = 1\n";
const BROKEN_LINE = /krites\.toml line 4: /;

const stop = (cwd, extra) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd, ...extra });
const fail = () => script("process.exit(1)");
const pass = () => script("console.log('fine')");

function lastRun(repo) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8"));
  } catch {
    return null;
  }
}

// krites.toml is committed before the baseline, because an edited krites.toml is itself a changed protected path.
function repoWith(options, { dirty = true, baseline = true } = {}) {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, typeof options === "function" ? options(repo) : options);
  if (baseline) seed(repo);
  if (dirty) fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  return repo;
}

test("gate: a clean tree whose HEAD matches the baseline skips and writes nothing", async () => {
  const repo = repoWith({ commands: [fail()] }, { dirty: false });
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(lastRun(repo), null, "a skipped gate writes no last-run.json");
});

test("gate: stop_hook_active is never read, so a repeat stop on a dirty tree still blocks", async () => {
  const repo = repoWith({ commands: [fail()] });
  const baseline = readBaseline(repo);
  for (const flag of [true, "false"]) {
    assertBlock(await runHook(GATE, stop(repo, { stop_hook_active: flag }), { cwd: repo }), /refuted/);
  }
  assert.strictEqual(lastRun(repo).verdict, "refuted");
  assert.strictEqual(readBaseline(repo), baseline);
});

test("gate: the fourth stop in a row is allowed and the run is recorded as exhausted", async () => {
  const repo = repoWith({ commands: [fail()] });
  const baseline = readBaseline(repo);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(repo, { stop_hook_active: attempt > 1 }), { cwd: repo }), /refuted/);
    assert.strictEqual(readBlockCount(repo), attempt);
  }

  assert.deepStrictEqual(await runHook(GATE, stop(repo, { stop_hook_active: true }), { cwd: repo }), SILENT, "the fourth stop is allowed");
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "refuted");
  assert.strictEqual(run.reason, "attempt budget exhausted");
  assert.match(run.checks[0].command, /check\d+\.js/, "the failing command is still recorded");
  assert.strictEqual(readBlockCount(repo), 4);
  assert.strictEqual(readBaseline(repo), baseline, "an exhausted stop advances nothing");
});

test("gate: a passing gate spends nothing and gives the next failures a full budget", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  const flag = path.join(tmp, `budget-flag${Date.now()}.txt`);
  fs.writeFileSync(flag, "bad");
  configure(repo, { commands: [script(`process.exit(require("node:fs").readFileSync(${JSON.stringify(flag)}, "utf8") === "ok" ? 0 : 1);`)] });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  for (let attempt = 1; attempt <= 2; attempt += 1) assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
  fs.writeFileSync(flag, "ok");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT, "the fixed check passes");
  assert.strictEqual(readBlockCount(repo), 0, "a pass resets the budget");

  fs.writeFileSync(flag, "bad");
  for (let attempt = 1; attempt <= 3; attempt += 1) assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
});

test("gate: max_blocks = 1 blocks once and then allows the stop", async () => {
  const repo = repoWith({ commands: [fail()], maxBlocks: 1 });
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(lastRun(repo).reason, "attempt budget exhausted");
  assert.strictEqual(lastRun(repo).verdict, "refuted");
});

test("gate: a config the gate cannot read blocks every stop, counts nothing and signs nothing", async () => {
  const parse = repoWith("version = 1\n\n[checks]\nnope = 1\n");

  const missing = configure(makeRepo({ files: { "a.txt": "a\n" } }), { commands: [fail()] });
  fs.rmSync(path.join(missing, "krites.toml"));

  const gated = seed(makeRepo({ files: { "a.txt": "a\n" } }));

  for (const [repo, pattern] of [
    [parse, /krites\.toml line 4: /],
    [missing, /tracked but missing/],
    [gated, /gated before/],
  ]) {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), pattern);
      assert.strictEqual(readBlockCount(repo), 0, `a config error spends no attempt (stop ${attempt})`);
    }
    assert.strictEqual(fs.existsSync(path.join(repo, ".krites", "block-count")), false, "and grows no counter");
    assert.strictEqual(lastRun(repo), null, "a block with no run signs nothing");
  }
});

test("gate: changed paths git cannot list block every stop and count nothing", async () => {
  const plain = makeDir({ "krites.toml": toml({ commands: [fail()] }), "a.txt": "a\n" });
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    assertBlock(await runHook(GATE, stop(plain), { cwd: plain }), /could not list the changed paths/);
    assert.strictEqual(readBlockCount(plain), 0, `an unreadable baseline spends no attempt (stop ${attempt})`);
  }
  assert.strictEqual(lastRun(plain), null, "a block with no run signs nothing");
});

// findRoots takes the payload cwd first and CLAUDE_PROJECT_DIR second, so inner is the root in front of outer.
function twoRoots(innerConfig, outerConfig) {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  for (const [dir, config] of [[inner, innerConfig], [outer, outerConfig]]) {
    fs.writeFileSync(path.join(dir, "krites.toml"), typeof config === "string" ? config : toml(config));
  }
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  return { inner, outer, env: { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") } };
}

test("gate: a config that does not load is held, and the root behind it is judged on every stop", async () => {
  const { inner, outer, env } = twoRoots(BROKEN, { commands: [fail()] });
  seed(outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const reason = assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), BROKEN_LINE);
    assert.match(reason, /^Krites refuted the stop: /, `stop ${attempt} judges the root behind the broken one, and its reason comes first: ${reason}`);
    assert.strictEqual(readBlockCount(outer), attempt, reason);
    assert.strictEqual((lastRun(outer) || {}).verdict, "refuted", reason);
    assert.strictEqual(readBlockCount(inner), 0, "the held root spends nothing");
  }

  const spent = assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), BROKEN_LINE);
  assert.doesNotMatch(spent, /refuted/, `the exhausted root is passed over and the held reason stands alone: ${spent}`);
  assert.strictEqual(readBlockCount(outer), 4);
  assert.strictEqual(lastRun(outer).reason, "attempt budget exhausted");
  assert.strictEqual(fs.existsSync(path.join(inner, ".krites")), false, "and the held root grows no counter");
});

test("gate: a held config error goes through the scrub like every other reason", async () => {
  // An unknown key is echoed by the parser, and a key can be shaped like a credential.
  const key = FAKE.ghp;
  const repo = repoWith(`version = 1\n\n[checks]\n${key} = 1\n`);
  const reason = assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /krites.toml line 4: /);
  assert.ok(!reason.includes(key), `the key is not echoed as it stands: ${reason}`);
});

test("gate: a passing root behind a held config error is recorded and its baseline advances", async () => {
  const { inner, outer, env } = twoRoots(BROKEN, { commands: [pass()] });
  seed(outer);
  const baseline = readBaseline(outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "work");

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reason = assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), BROKEN_LINE);
    assert.strictEqual(reason.split("\n").length, 1, `the config reason alone: ${reason}`);
    assert.strictEqual((lastRun(outer) || {}).verdict, "passed", `stop ${attempt}: the root behind the broken one is judged`);
    assert.strictEqual(readBaseline(outer), head(outer), "a pass behind a held reason still advances the baseline");
  }
  assert.notStrictEqual(readBaseline(outer), baseline);
  assert.strictEqual(readBlockCount(outer), 0);
});

test("gate: changed paths git cannot list are held, and the root behind them is judged on every stop", async () => {
  const plain = makeDir({ "krites.toml": toml({ commands: [fail()] }), "a.txt": "a\n" });
  const repo = repoWith({ commands: [fail()] });
  const env = { CLAUDE_PROJECT_DIR: repo.replace(/\\/g, "/") };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const reason = assertBlock(await runHook(GATE, stop(plain), { cwd: plain, env }), /could not list the changed paths/);
    assert.match(reason, /Krites refuted the stop: /, `stop ${attempt} judges the root behind the unlistable one: ${reason}`);
    assert.strictEqual(readBlockCount(repo), attempt, reason);
    assert.strictEqual(readBlockCount(plain), 0, "the held root spends nothing");
  }

  const spent = assertBlock(await runHook(GATE, stop(plain), { cwd: plain, env }), /could not list the changed paths/);
  assert.doesNotMatch(spent, /refuted/, `the exhausted root is passed over and the held reason stands alone: ${spent}`);
  assert.strictEqual(lastRun(repo).reason, "attempt budget exhausted");
});

test("gate: two configs that do not load block with both reasons and count nothing", async () => {
  const { inner, outer, env } = twoRoots(BROKEN, "version = 2\n");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const reason = assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), BROKEN_LINE);
    assert.match(reason, /krites\.toml line 1: version must be 1/, `both reasons, one per line (stop ${attempt}): ${reason}`);
    assert.strictEqual(reason.split("\n").length, 2, reason);
    assert.strictEqual(readBlockCount(inner) + readBlockCount(outer), 0, "neither root is charged");
  }
  assert.strictEqual(lastRun(inner), null, "a block with no run signs nothing");
  assert.strictEqual(lastRun(outer), null, "a block with no run signs nothing");
});

test("gate: a counted block still returns at once, so the config error behind it is not reached", async () => {
  const { inner, outer, env } = twoRoots({ commands: [fail()] }, BROKEN);
  seed(outer);
  seed(inner, outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");

  const reason = assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), /Krites refuted the stop: /);
  assert.doesNotMatch(reason, /krites\.toml line/, `the loop answers at the counted block: ${reason}`);
  assert.strictEqual(readBlockCount(inner), 1);
  assert.strictEqual(readBlockCount(outer), 0, "the root behind it is not judged on that stop");
});

test("gate: a held reason sends no ping, and an allowed stop still does", async () => {
  const { gate } = require(GATE);
  const ping = require("../lib/ping.js");
  const broken = repoWith(BROKEN);
  const fine = repoWith({ commands: [pass()] });
  const real = ping.send;
  let sent = 0;
  ping.send = async () => {
    sent += 1;
  };
  try {
    assert.match(await fromTmp(() => gate(stop(broken), { projectDir: broken })), BROKEN_LINE);
    assert.strictEqual(sent, 0, "a held reason means the stop is not an allowed one");
    assert.strictEqual(await fromTmp(() => gate(stop(fine), { projectDir: fine })), null);
    assert.strictEqual(sent, 1, "an allowed stop still pings");
  } finally {
    ping.send = real;
  }
});

test("gate: a block with no root to judge still charges a root whose config does not load", async () => {
  const repo = repoWith("version = 1\n\n[checks]\nnope = 1\n");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, "42", { cwd: repo }), /not an object/);
    assert.strictEqual(readBlockCount(repo), attempt, "the payload is what failed, not the config");
  }
  assert.deepStrictEqual(await runHook(GATE, "42", { cwd: repo }), SILENT);
});

test("gate: a clean tree at the baseline clears the attempts, and a no_checks stop leaves them", async () => {
  const skipped = repoWith({ commands: [fail()] }, { dirty: false });
  writeBlockCount(skipped, 2);
  assert.deepStrictEqual(await runHook(GATE, stop(skipped), { cwd: skipped }), SILENT);
  assert.strictEqual(readBlockCount(skipped), 0, "a clean tree at the baseline holds nothing that blocked");

  const fresh = repoWith({ commands: [fail()] }, { dirty: false });
  assert.deepStrictEqual(await runHook(GATE, stop(fresh), { cwd: fresh }), SILENT);
  assert.strictEqual(fs.existsSync(path.join(fresh, ".krites", "block-count")), false, "nothing spent, nothing written");

  const quiet = repoWith({ commands: [] });
  writeBlockCount(quiet, 2);
  assert.deepStrictEqual(await runHook(GATE, stop(quiet), { cwd: quiet }), SILENT);
  assert.strictEqual(readBlockCount(quiet), 2, "no_checks spends nothing and resets nothing");
});

test("gate: a skip between two failures gives the stops after it a full budget", async () => {
  const repo = repoWith({ commands: [fail()] });
  for (let attempt = 1; attempt <= 2; attempt += 1) assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
  assert.strictEqual(readBlockCount(repo), 2);

  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT, "the tree is back at the baseline");
  assert.strictEqual(readBlockCount(repo), 0, "the skip released the attempts");

  fs.writeFileSync(path.join(repo, "a.txt"), "changed again\n");
  for (let attempt = 1; attempt <= 3; attempt += 1) assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
});

test("gate: a skip whose reset cannot be written stays silent", async () => {
  const repo = repoWith({ commands: [fail()] }, { dirty: false });
  writeBlockCount(repo, 2);
  const counter = path.join(repo, ".krites", "block-count");
  fs.chmodSync(counter, 0o444);
  try {
    assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT, "a skip never blocks, whatever it cannot write");
  } finally {
    fs.chmodSync(counter, 0o666);
  }
});

test("gate: a counter already at the budget lets the first failing stop through and advances nothing", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [fail()] });
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  writeBlockCount(repo, 3);

  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "refuted");
  assert.strictEqual(run.reason, "attempt budget exhausted");
  assert.strictEqual(readBlockCount(repo), 4);
  assert.strictEqual(readBaseline(repo), null, "an exhausted stop advances no baseline");
  assert.strictEqual(readConfigHash(repo), null, "and records no config hash for a root that never passed");
});

test("gate: a run that throws after it spent an attempt is charged once, not twice", async () => {
  const repo = repoWith({ commands: [fail()] });
  fs.mkdirSync(path.join(repo, ".krites", "last-run.json"), { recursive: true });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /the gate hook failed/);
    assert.strictEqual(readBlockCount(repo), attempt, "one block, one attempt");
  }
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(readBlockCount(repo), 4);
});

test("gate: a session id that is not a string is recorded as null and the run still signs", async () => {
  for (const [label, extra] of [
    ["absent", { session_id: undefined }],
    ["a number", { session_id: 123 }],
    ["a boolean", { session_id: true }],
    ["too long", { session_id: "s".repeat(65) }],
  ]) {
    const repo = repoWith({ commands: [pass()] });
    assert.deepStrictEqual(await runHook(GATE, stop(repo, extra), { cwd: repo }), SILENT, label);

    const run = lastRun(repo);
    assert.ok("session_id" in run, `${label}: the key is written`);
    assert.strictEqual(run.session_id, null, label);
    const receipt = await runCli(["receipt"], { cwd: repo });
    assert.strictEqual(receipt.code, 0, label);
    assert.match(receipt.stdout, /^receipts\/[^\n]+\.json\nreceipts\/[^\n]+\.md\n$/, `${label}: ${receipt.stdout}`);
  }
});

test("gate: a block with no owner is never charged to a root that passed in the same run", async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [pass()] }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [fail()] }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");
  fs.mkdirSync(path.join(outer, ".krites", "last-run.json"), { recursive: true });

  const env = { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // The reason names the root that crashed and its error code, so a failure here says which write gave way.
    const blocked = await runHook(GATE, stop(inner), { cwd: inner, env });
    assertBlock(blocked, /the gate hook failed/);
    assert.strictEqual(readBlockCount(inner), 0, `the root that passed is not charged: ${blocked.stdout}`);
    assert.strictEqual(readBlockCount(outer), attempt, blocked.stdout);
  }
  const last = await runHook(GATE, stop(inner), { cwd: inner, env });
  assert.deepStrictEqual(last, SILENT, `the chain ends when the throwing root is spent: ${last.stdout}${last.stderr}`);
  assert.strictEqual(readBlockCount(inner), 0, last.stdout);
});

test("gate: a pass that cannot record its baseline spends the budget like any other block", async () => {
  const repo = repoWith({ commands: [pass()] }, { baseline: false });
  // Not empty, so the plugin's own repair cannot clear it and the baseline write really fails.
  fs.mkdirSync(path.join(repo, ".krites", "session-head"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".krites", "session-head", "held.txt"), "held\n");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /the gate hook failed \(E[A-Z]+\)/);
    assert.strictEqual(readBlockCount(repo), attempt, "a pass that throws afterwards resets nothing");
  }
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
});

test("gate: a crash is charged to the root it happened in, and a spent root lets the next one be judged", async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [fail()] }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [fail()] }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");
  fs.mkdirSync(path.join(inner, ".krites", "last-run.json"), { recursive: true });

  const env = { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), /the gate hook failed/);
    assert.strictEqual(readBlockCount(inner), attempt);
    assert.strictEqual(readBlockCount(outer), 0, "a root that was never judged keeps its whole budget");
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), /refuted/);
    assert.strictEqual(readBlockCount(outer), attempt, "the spent root is passed over and the next root blocks for itself");
  }
  assert.deepStrictEqual(await runHook(GATE, stop(inner), { cwd: inner, env }), SILENT);
});

test("gate: a check that wipes .krites cannot wipe the attempts already spent", async () => {
  const wipe = script("require('fs').rmSync('.krites', { recursive: true, force: true }); process.exit(1)");
  const repo = repoWith({ commands: [wipe] });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
    assert.strictEqual(readBlockCount(repo), attempt, "the count read before the checks is the one that goes up");
  }
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
});

test("gate: a payload that is not an object after a judged one is still charged in the same process", async () => {
  const { gate } = require(GATE);
  const repo = repoWith({ commands: [fail()] });
  assert.match(await fromTmp(() => gate(stop(repo), { projectDir: repo })), /refuted/);
  assert.match(await fromTmp(() => gate(null, { projectDir: repo })), /not an object/);
  assert.strictEqual(readBlockCount(repo), 2, "the second call is its own run");
});

test("gate: called again in one process it counts like a fresh hook process", async () => {
  const { gate } = require(GATE);
  const repo = repoWith({ commands: [fail()] });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.match(await fromTmp(() => gate(stop(repo), { projectDir: repo })), /refuted/);
    assert.strictEqual(readBlockCount(repo), attempt, "what one call charged does not answer for the next");
  }
  assert.strictEqual(await fromTmp(() => gate(stop(repo), { projectDir: repo })), null);
});

test("gate: input it cannot read, in a place with no root, blocks every time", async () => {
  const plain = makeDir();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assertBlock(await runHook(GATE, "{not json", { cwd: plain }), /could not read its input/);
  }
  assert.ok(!fs.existsSync(path.join(plain, ".krites")), "nothing is written where no root is");
});

test("gate: the fail path still knows a root that only the payload named", async () => {
  const repo = repoWith({ commands: [fail()] });
  fs.mkdirSync(path.join(repo, ".krites", "last-run.json"), { recursive: true });
  const elsewhere = makeDir();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(repo), { cwd: elsewhere }), /the gate hook failed/);
    assert.strictEqual(readBlockCount(repo), attempt);
  }
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: elsewhere }), SILENT);
});

test("gate: a file where .krites belongs and a directory where the counter belongs are repaired", async () => {
  const asFile = repoWith({ commands: [fail()] }, { baseline: false });
  fs.writeFileSync(path.join(asFile, ".krites"), "not a directory\n");

  const asDirectory = repoWith({ commands: [fail()] });
  fs.mkdirSync(path.join(asDirectory, ".krites", "block-count"), { recursive: true });

  for (const repo of [asFile, asDirectory]) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
      assert.strictEqual(readBlockCount(repo), attempt);
    }
    assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  }
});

test("gate: a counter it cannot repair keeps blocking, and every reason names the file and the code", async () => {
  const repo = repoWith({ commands: [fail()] });
  const counter = path.join(repo, ".krites", "block-count");
  fs.mkdirSync(counter, { recursive: true });
  fs.writeFileSync(path.join(counter, "keep.txt"), "keep\n");

  const named = /\nKrites could not record this attempt: \.krites\/block-count cannot be written \(E[A-Z]+\)\. The gate keeps blocking until that is fixed\.$/;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const reason = assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
    assert.match(reason, named, `stop ${attempt} says why the attempt was not recorded: ${reason}`);
  }
  assert.strictEqual(fs.readFileSync(path.join(counter, "keep.txt"), "utf8"), "keep\n", "nothing under it is removed");
});

test("gate: a block with no root to judge names the counter it could not write too", async () => {
  const repo = repoWith({ commands: [fail()] });
  const counter = path.join(repo, ".krites", "block-count");
  fs.mkdirSync(counter, { recursive: true });
  fs.writeFileSync(path.join(counter, "keep.txt"), "keep\n");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const reason = assertBlock(await runHook(GATE, "42", { cwd: repo }), /not an object/);
    assert.match(reason, /\nKrites could not record this attempt: \.krites\/block-count cannot be written \(E[A-Z]+\)\./, `stop ${attempt}: ${reason}`);
  }
});

test("gate: a payload that is not an object spends the budget of the roots it can still find", async () => {
  const repo = repoWith({ commands: [fail()] });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, "42", { cwd: repo }), /not an object/);
    assert.strictEqual(readBlockCount(repo), attempt);
  }
  assert.deepStrictEqual(await runHook(GATE, "42", { cwd: repo }), SILENT);
  assert.strictEqual(readBlockCount(repo), 4);
  assert.strictEqual(lastRun(repo), null, "a block with no run signs nothing");
});

test("gate: input the hook cannot read blocks until the budget is spent", async () => {
  const repo = repoWith({ commands: [fail()] });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, "{not json", { cwd: repo }), /could not read its input/);
    assert.strictEqual(readBlockCount(repo), attempt);
  }
  assert.deepStrictEqual(await runHook(GATE, "{not json", { cwd: repo }), SILENT);
  assert.strictEqual(readBlockCount(repo), 4);
});

test("gate: a payload with no root charges every root and blocks while either has budget", async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [], maxBlocks: 1 }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [] }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");

  const env = { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, "42", { cwd: inner, env }), /not an object/);
    assert.strictEqual(readBlockCount(inner), attempt, "the spent root is charged too");
    assert.strictEqual(readBlockCount(outer), attempt);
  }
  assert.deepStrictEqual(await runHook(GATE, "42", { cwd: inner, env }), SILENT, "allowed once both roots are spent");
  assert.strictEqual(readBlockCount(inner), 4);
  assert.strictEqual(readBlockCount(outer), 4);
});

test("gate: the budget is the gate's alone, never the other hooks' fail paths", async () => {
  const repo = repoWith({ commands: [fail()] });
  for (const name of ["protect", "session"]) {
    const result = await runHook(path.join(__dirname, "..", "hooks", `${name}.js`), "{not json", { cwd: repo });
    assert.strictEqual(result.code, 0, name);
    assert.strictEqual(readBlockCount(repo), 0, `${name} counts nothing`);
  }
  assertBlock(await runHook(GATE, "{not json", { cwd: repo }), /could not read its input/);
  assert.strictEqual(readBlockCount(repo), 1, "the gate's own fail path counts");
});

test("gate: one root's spent budget leaves the next root's budget alone", async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [fail()], maxBlocks: 1 }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [fail()] }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");

  const env = { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") };
  assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), /refuted/);
  assert.strictEqual(readBlockCount(outer), 0, "the first blocking root ends the run");

  assertBlock(await runHook(GATE, stop(inner), { cwd: inner, env }), /refuted/);
  assert.strictEqual(readBlockCount(inner), 2);
  assert.strictEqual(readBlockCount(outer), 1);
});

test("gate: passing checks are silent and advance the baseline to the HEAD read before the run", async () => {
  const repo = repoWith({ commands: [pass(), pass()] });
  const before = head(repo);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(readBaseline(repo), before);
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "passed");
  assert.strictEqual(run.schema, "krites.last-run/0.1");
  assert.strictEqual(run.checks.length, 2);
  assert.strictEqual(run.session_id, "s1");
  assert.strictEqual(run.dirty, true);
  assert.strictEqual(run.head, before);
  assert.ok(/^[0-9a-f]{64}$/.test(run.root_hash), "the root is named by a hash, never by its path");
  assert.strictEqual(run.diff.files_changed, 1);
});

test("gate: a new commit since the baseline runs the checks on a clean tree", async () => {
  const repo = repoWith({ commands: [fail()] }, { dirty: false });
  fs.writeFileSync(path.join(repo, "a.txt"), "committed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "work");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
  const run = lastRun(repo);
  assert.strictEqual(run.dirty, false, "the tree is clean; the new commit is what made the gate run");
  assert.deepStrictEqual(run.diff.files, ["a.txt"], "the diff covers what the run covered, not only the working tree");
});

test("gate: a missing baseline counts as differs", async () => {
  const repo = repoWith({ commands: [fail()] }, { dirty: false, baseline: false });
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /refuted/);
});

test("gate: an empty command list is no_checks, the stop is allowed and the baseline stays", async () => {
  const repo = repoWith({ commands: [] });
  const baseline = readBaseline(repo);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "no_checks");
  assert.deepStrictEqual(run.checks, []);
  assert.strictEqual(readBaseline(repo), baseline, "no_checks never advances the baseline");
});

test("gate: a repo with no commits runs its checks, and a directory git cannot read blocks", async () => {
  const fresh = makeRepo({ files: { "krites.toml": toml({ commands: [fail()] }), "a.txt": "a\n" }, commit: false });
  seed(fresh);
  assertBlock(await runHook(GATE, stop(fresh), { cwd: fresh }), /check\d+\.js/);

  const plain = makeDir({ "krites.toml": toml({ commands: [fail()] }), "a.txt": "a\n" });
  const reason = assertBlock(await runHook(GATE, stop(plain), { cwd: plain }), /could not list the changed paths/);
  assert.doesNotMatch(reason, /check\d+\.js/, "no check runs when the changed paths are unknown");
});

test("gate: a payload that is not an object blocks", async () => {
  for (const payload of ['"a string"', "[1,2]", "42", "null"]) {
    assertBlock(await runHook(GATE, payload), /not an object/);
  }
});

test("gate: a root below the git toplevel sees its own tree change", async () => {
  const repo = makeRepo({ files: { "top.txt": "t\n", "sub/a.txt": "a\n" } });
  const root = path.join(repo, "sub");
  const meddle = script(`require("node:fs").appendFileSync(${JSON.stringify(path.join(root, "a.txt"))}, "more\\n");`);
  fs.writeFileSync(path.join(root, "krites.toml"), toml({ commands: [meddle] }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "config");
  seed(root, repo);
  fs.writeFileSync(path.join(root, "a.txt"), "changed\n");

  assertBlock(await runHook(GATE, stop(root), { cwd: root }), /tree changed while the gate ran/);
  assert.strictEqual(lastRun(root), null);
});

test("gate: last-run records the configured commands and the config hash, not only what ran", async () => {
  const repo = repoWith({ commands: [fail(), pass()] });
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /check\d+\.js/);

  const run = lastRun(repo);
  const expected = crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, "krites.toml"), "utf8")).digest("hex");
  assert.strictEqual(run.config_hash, expected);
  assert.strictEqual(run.commands.length, 2, "the full configured list, in order");
  assert.strictEqual(run.checks.length, 1, "only the first command ran");
  assert.deepStrictEqual(run.commands[1], run.commands[1].map(String));
  assert.ok(run.commands[1].join(" ").includes("check"), "the command that never ran is still listed");
  assert.match(run.reason, /check\d+\.js/, "the file says why it refused");
  assert.doesNotMatch(textOf(run), ABSOLUTE);
});

test("gate: the config hash ignores a BOM and the line endings, and a bad session id is dropped", async () => {
  const lf = makeRepo({ files: { "a.txt": "a\n" } });
  configure(lf, { commands: [pass()] });
  seed(lf);
  fs.writeFileSync(path.join(lf, "a.txt"), "changed\n");

  const crlf = makeRepo({ files: { "a.txt": "a\n" } });
  const bom = String.fromCharCode(0xfeff);
  configure(crlf, bom + fs.readFileSync(path.join(lf, "krites.toml"), "utf8").replace(/\n/g, "\r\n"));
  seed(crlf);
  fs.writeFileSync(path.join(crlf, "a.txt"), "changed\n");

  await runHook(GATE, stop(lf), { cwd: lf });
  await runHook(GATE, stop(crlf, { session_id: "not a session id!" }), { cwd: crlf });
  assert.strictEqual(lastRun(crlf).config_hash, lastRun(lf).config_hash, "the same config with a BOM and CRLF hashes the same");
  assert.strictEqual(lastRun(crlf).session_id, null, "a session id that is not an identifier is dropped");
  assert.strictEqual(lastRun(lf).session_id, "s1");
});

test("gate: one budget covers both roots, so a later root gets only what is left", { timeout: 120000 }, async () => {
  const { gate } = require("../hooks/gate.js");
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  const hang = script("setTimeout(() => {}, 30000)");
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [hang], timeoutSeconds: 5 }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [script("setTimeout(() => {}, 2000)")], timeoutSeconds: 5 }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");

  const started = Date.now();
  const reason = await fromTmp(() => gate({ hook_event_name: "Stop", session_id: "s1", cwd: outer }, { totalMs: 6000, startedAt: started, projectDir: inner }));
  const elapsed = Date.now() - started;

  // Its own timeout_seconds is 5; anything under that is budget the first root already spent.
  assert.match(reason, /gate timed out after [0-4] s/, `the second root inherits the rest of the budget: ${reason}`);
  assert.ok(elapsed < 25000, `one budget, not one per root: ${elapsed} ms`);
});

test("gate: a check that changes the tree blocks until the budget is spent and leaves no last-run.json", async () => {
  const repo = repoWith((dir) => ({ commands: [script(`require("node:fs").appendFileSync(${JSON.stringify(path.join(dir, "a.txt"))}, "more\\n");`)] }));
  for (let attempt = 1; attempt <= 3; attempt += 1) assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /tree changed while the gate ran/);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(lastRun(repo), null, "a block with no run signs nothing, spent budget or not");
});

test("gate: a check that cannot start blocks without a path", async () => {
  const repo = repoWith({ commands: [["krites-no-such-binary"]] });
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /krites-no-such-binary/);
});

test("gate: a config that does not parse blocks with the line number and /krites:init", async () => {
  const repo = repoWith("version = 1\n\n[checks]\nnope = 1\n");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /krites\.toml line 4: .*Run \/krites:init\./);
  assert.strictEqual(lastRun(repo), null);
});

test("gate: the first blocking root wins and later roots never run their checks", async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  const marker = path.join(outer, "inner-ran.txt");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)] }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [fail()] }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");

  const payload = stop(outer);
  assertBlock(await runHook(GATE, payload, { cwd: outer, env: { CLAUDE_PROJECT_DIR: inner.replace(/\\/g, "/") } }), /refuted/);
  assert.strictEqual(fs.existsSync(marker), false, "the second root's checks never ran");
});

test("gate: the tail is scrubbed of absolute paths and color codes", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  const noisy = script(`
    for (let i = 0; i < 200; i++) console.log("line " + i);
    console.error("\\x1b[31mat " + ${JSON.stringify(path.join(repo, "src", "lib.rs"))} + ":3\\x1b[0m");
    console.error("home " + ${JSON.stringify(path.join(os.homedir(), ".cargo", "registry", "x.rs"))});
    console.error("foreign " + ${JSON.stringify(WINDOWS ? "Q:\\build\\agent\\out.log" : "/usr/build/agent/out.log")});
    console.error("token ${FAKE.sk}");
    process.exit(3);`);
  const unreached = script("console.log('unreached')");
  configure(repo, { commands: [pass(), noisy, unreached] });
  const before = head(repo);
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  const reason = assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /check\d+\.js/);
  assert.ok(reason.includes("line 199") && !reason.includes("line 100\n"), "the tail keeps the last lines only");
  assert.ok(reason.split("\n").length <= 66, "the tail is capped near 60 lines");
  assert.ok(reason.includes("./src/lib.rs:3") || reason.includes(".\\src\\lib.rs:3"), "the root becomes .");
  assert.ok(!reason.includes("\x1b"), "color codes are stripped");
  assert.ok(reason.includes("<redacted>") && !reason.includes("sk-abcdefghij"), "token shapes are redacted");
  assert.ok(!reason.includes("unreached"), "checks after the first failure do not run");

  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "refuted");
  assert.strictEqual(run.checks.length, 2);
  assert.strictEqual(run.checks[1].exit_code, 3);
  assert.ok(run.checks[1].duration_ms >= 0);
  assert.doesNotMatch(textOf(run), ABSOLUTE, "no absolute path in last-run.json");
  assert.ok(!textOf(run).includes("sk-abcdefghij"), "no token shape in last-run.json");
  assert.strictEqual(readBaseline(repo), before, "a refuted run never advances the baseline");
});

test("gate: [checks.env] reaches every check, and the run file records it scrubbed", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  const needs = script('process.exit(process.env.GOTOOLCHAIN === "go1.26.6" && process.env.krites_t4_case === "new" ? 0 : 1)');
  const env = `\n[checks.env]\nGOTOOLCHAIN = "go1.26.6"\nkrites_t4_case = "new"\nAPI_TOKEN = "${FAKE.sk}"\n`;
  const inherited = { KRITES_T4_CASE: "old" };

  configure(repo, toml({ commands: [needs] }));
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo, env: inherited }), /check\d+\.js/);

  configure(repo, `${toml({ commands: [needs] })}${env}`);
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed again\n");
  const passed = await runHook(GATE, stop(repo), { cwd: repo, env: inherited });
  assert.strictEqual(passed.stdout, "", passed.stdout);
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "passed");
  assert.deepStrictEqual(run.env, ["GOTOOLCHAIN=go1.26.6", "krites_t4_case=new", "API_TOKEN=<redacted>"]);
  assert.ok(!textOf(run).includes("sk-abcdefghij"), "no token shape in last-run.json");

  const verified = await runCli(["verify"], { cwd: repo, env: inherited });
  assert.match(verified.stdout, /check\d+\.js\nexit 0\n/, "/krites:verify runs with the same environment");
  assert.deepStrictEqual(lastRun(repo).env, run.env);

  const receipt = await runCli(["receipt"], { cwd: repo });
  assert.strictEqual(receipt.code, 0, receipt.stdout);
  const signed = JSON.parse(fs.readFileSync(path.join(repo, receipt.stdout.split("\n")[0]), "utf8"));
  assert.strictEqual(signed.schema, "krites.receipt/0.3");
  assert.deepStrictEqual(signed.env, run.env, "the receipt carries the scrubbed assignments");
  assert.ok(!JSON.stringify(signed).includes("sk-abcdefghij"));
});

test("gate: a [checks.env] value under a secret-shaped name is redacted in the run file", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, `${toml({ commands: [script('process.exit(process.env.DB_PASSWORD === "hunter2" ? 0 : 1)')] })}\n[checks.env]\nDB_PASSWORD = "hunter2"\n`);
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "passed");
  assert.deepStrictEqual(run.env, ["DB_PASSWORD=<redacted>"]);
  assert.ok(!fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8").includes("hunter2"));
});

test("gate: a stop never starts a slow check, and records it as configured", async () => {
  const marker = path.join(tmp, `slow-ran${Date.now()}.txt`);
  const slow = script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [fail()], slow: [slow] });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /check\d+\.js/);

  configure(repo, { commands: [pass()], slow: [slow] });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed again\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(fs.existsSync(marker), false, "no stop ran the slow check");
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "passed");
  assert.strictEqual(run.checks.length, 1);
  assert.strictEqual(run.slow.length, 1);
  assert.strictEqual(path.basename(run.slow[0][1]), path.basename(slow[1]));
  assert.doesNotMatch(run.slow[0][1], ABSOLUTE, "recorded, scrubbed like commands");
});

test("gate: a stop on the tree /krites:verify passed carries its slow results, and only a clean pass does", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [pass()], slow: [pass()], timeoutSeconds: 60 });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  await runCli(["verify"], { cwd: repo });
  const verified = lastRun(repo);
  assert.strictEqual(verified.checks.length, 2);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  const carried = lastRun(repo);
  assert.strictEqual(carried.verdict, "passed");
  assert.deepStrictEqual(carried.checks.slice(1), verified.checks.slice(1), "exit codes and durations as verify recorded them");

  fs.writeFileSync(path.join(repo, ".krites", "last-run.json"), JSON.stringify({ ...carried, config_hash: "another" }));
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(lastRun(repo).checks.length, 1, "another krites.toml carries nothing");

  const slowFails = makeRepo({ files: { "a.txt": "a\n" } });
  configure(slowFails, { commands: [pass()], slow: [fail()], timeoutSeconds: 60 });
  seed(slowFails);
  fs.writeFileSync(path.join(slowFails, "a.txt"), "changed\n");
  await runCli(["verify"], { cwd: slowFails });
  assert.strictEqual(lastRun(slowFails).checks.length, 2);
  assert.deepStrictEqual(await runHook(GATE, stop(slowFails), { cwd: slowFails }), SILENT);
  assert.strictEqual(lastRun(slowFails).checks.length, 1, "a failed slow check is not carried");

  const marker = path.join(tmp, `refute${Date.now()}.txt`);
  const flaky = script(`process.exit(require("node:fs").existsSync(${JSON.stringify(marker)}) ? 1 : 0)`);
  const refuted = makeRepo({ files: { "a.txt": "a\n" } });
  configure(refuted, { commands: [flaky], slow: [pass()], timeoutSeconds: 60 });
  seed(refuted);
  fs.writeFileSync(path.join(refuted, "a.txt"), "changed\n");
  await runCli(["verify"], { cwd: refuted });
  assert.strictEqual(lastRun(refuted).verdict, "passed");
  fs.writeFileSync(marker, "x");
  assertBlock(await runHook(GATE, stop(refuted), { cwd: refuted }), /check\d+\.js/);
  const run = lastRun(refuted);
  assert.deepStrictEqual([run.verdict, run.checks.length], ["refuted", 1], "a refuted stop carries nothing");
});

// A session root R that ignores target/, and a committed krites root at R/target/wt/x that session s1's protect hook recorded.
function touchedNested(options, { sessionId = "s1" } = {}) {
  const repo = makeRepo({ files: { "a.txt": "a\n", ".gitignore": "target/\n" } });
  configure(repo, { commands: [pass()] });
  seed(repo);
  const nested = path.join(repo, "target", "wt", "x");
  fs.mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q");
  fs.writeFileSync(path.join(nested, "a.txt"), "a\n");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "init");
  configure(nested, options);
  fs.appendFileSync(path.join(repo, ".krites", "touched"), `${sessionId}\t${nested}\t${head(nested)}\n`);
  return { repo, nested };
}

test("gate: a nested root the session edited is judged from the session root, named by its relative path", async () => {
  const { repo, nested } = touchedNested({ commands: [fail()] });
  fs.writeFileSync(path.join(nested, "a.txt"), "changed\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo, { session_id: "s2" })), SILENT, "another session never edited it");
  assert.ok(!fs.existsSync(path.join(nested, ".krites")), "nothing is written in the nested root before its first judgement");
  assertBlock(await runHook(GATE, stop(repo)), /^In target\/wt\/x: Krites refuted the stop: /);
  assert.strictEqual(readBlockCount(nested), 1, "the block is charged to the nested root");
  assert.strictEqual(readBlockCount(repo), 0);
});

test("gate: a touched root outside the session root, or no longer a krites root, is skipped and nothing is written there", async () => {
  const { repo } = touchedNested({ commands: [pass()] });
  const outside = makeRepo({ files: { "a.txt": "a\n" } });
  configure(outside, { commands: [fail()] });
  fs.writeFileSync(path.join(outside, "a.txt"), "changed\n");
  const gone = path.join(repo, "target", "wt", "gone");
  const plain = path.join(repo, "target", "wt", "plain");
  fs.mkdirSync(plain, { recursive: true });
  git(plain, "init", "-q");
  fs.writeFileSync(path.join(plain, "a.txt"), "a\n");
  const lines = [outside, gone, plain, repo].map((root) => `s1\t${root}\t\n`).join("");
  fs.appendFileSync(path.join(repo, ".krites", "touched"), lines);
  assert.deepStrictEqual(await runHook(GATE, stop(repo)), SILENT);
  for (const dir of [outside, plain]) assert.ok(!fs.existsSync(path.join(dir, ".krites")));
  assert.ok(!fs.existsSync(gone));
});

test("gate: a protected path committed in the nested root after the first touch refutes the stop", async () => {
  const { repo, nested } = touchedNested({ commands: [pass()], globs: ["fixtures/**"] });
  fs.mkdirSync(path.join(nested, "fixtures"));
  fs.writeFileSync(path.join(nested, "fixtures", "a.txt"), "a\n");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "fixture");
  const reason = assertBlock(await runHook(GATE, stop(repo)), /^In target\/wt\/x: Krites refuted the stop: protected path changed: fixtures\/a\.txt\./);
  assert.ok(reason.endsWith("review it with /krites:approve from a session started in target/wt/x."), reason);
});

test("gate: a touched root that passes records its own baseline and count, and its next clean stop skips", async () => {
  const { repo, nested } = touchedNested({ commands: [["git", "rev-parse", "--verify", "-q", "refs/tags/ok"]] });
  fs.writeFileSync(path.join(nested, "a.txt"), "changed\n");
  assertBlock(await runHook(GATE, stop(repo)), /^In target\/wt\/x: Krites refuted the stop: git rev-parse/);
  assert.strictEqual(readBlockCount(nested), 1);
  git(nested, "commit", "-qam", "work");
  git(nested, "tag", "ok");
  assert.deepStrictEqual(await runHook(GATE, stop(repo)), SILENT);
  assert.strictEqual(readBaseline(nested), head(nested));
  assert.strictEqual(readBlockCount(nested), 0);
  git(nested, "tag", "-d", "ok");
  assert.deepStrictEqual(await runHook(GATE, stop(repo)), SILENT, "a clean tree at its own baseline skips");
});

const PROTECT = path.join(__dirname, "..", "hooks", "protect.js");

test("gate: an edit made with the cwd inside the nested root is recorded under the project root and judged from it", async () => {
  const { repo, nested } = touchedNested({ commands: [fail()] });
  fs.writeFileSync(path.join(repo, ".krites", "touched"), "");
  const write = { hook_event_name: "PreToolUse", tool_name: "Write", session_id: "s1", cwd: nested, tool_input: { file_path: path.join(nested, "src", "a.rs") } };
  assert.deepStrictEqual(await runHook(PROTECT, write, { env: { CLAUDE_PROJECT_DIR: repo } }), SILENT);
  assert.ok(!fs.existsSync(path.join(nested, ".krites")), "nothing is written in the nested root");
  fs.mkdirSync(path.join(nested, "src"));
  fs.writeFileSync(path.join(nested, "src", "a.rs"), "fn main() {}\n");
  assertBlock(await runHook(GATE, stop(repo)), /^In target\/wt\/x: Krites refuted the stop: /);
});

test("gate: a touched root that is also the stop's cwd root keeps its recorded head as the baseline", async () => {
  const { repo, nested } = touchedNested({ commands: [pass()], globs: ["fixtures/**"] });
  fs.mkdirSync(path.join(nested, "fixtures"));
  fs.writeFileSync(path.join(nested, "fixtures", "a.txt"), "a\n");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "fixture");
  const reason = assertBlock(await runHook(GATE, stop(nested), { env: { CLAUDE_PROJECT_DIR: repo } }), /^Krites refuted the stop: protected path changed: fixtures\/a\.txt\./);
  assert.doesNotMatch(reason, /^In /, "a root of the stop itself carries no prefix");
});

test("gate: a touched line whose folder now resolves to another root is skipped", async () => {
  const { repo, nested } = touchedNested({ commands: [fail()] });
  fs.writeFileSync(path.join(nested, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, ".krites", "touched"), `s1\t${path.join(nested, "sub")}\t\n`);
  fs.mkdirSync(path.join(nested, "sub"));
  assert.deepStrictEqual(await runHook(GATE, stop(repo)), SILENT, "sub's root is x, which the session never edited");
  assert.ok(!fs.existsSync(path.join(nested, ".krites")));
});

test("gate: a touched line through a link inside the session root to a repo outside it is skipped", async () => {
  const { repo } = touchedNested({ commands: [pass()] });
  const outside = makeRepo({ files: { "a.txt": "a\n" } });
  configure(outside, { commands: [fail()] });
  fs.writeFileSync(path.join(outside, "a.txt"), "changed\n");
  const link = path.join(repo, "target", "wt", "link");
  fs.symlinkSync(outside, link, "junction");
  fs.writeFileSync(path.join(repo, ".krites", "touched"), `s1\t${link}\t\n`);
  assert.deepStrictEqual(await runHook(GATE, stop(repo)), SILENT);
  assert.ok(!fs.existsSync(path.join(outside, ".krites")));
  fs.unlinkSync(link);
});

test("gate: a krites.toml committed in the nested root after the first touch refutes the stop", async () => {
  const { repo, nested } = touchedNested({ commands: [pass()] });
  configure(nested, { commands: [pass()], maxBlocks: 5 });
  assertBlock(await runHook(GATE, stop(repo)), /^In target\/wt\/x: Krites refuted the stop: protected path changed: krites\.toml\. If you changed it yourself, run \/krites:init from a session started in target\/wt\/x to approve it\.$/);
});

test("gate: a nested krites.toml that stops parsing after the first touch is held with the prefix", async () => {
  const { repo, nested } = touchedNested({ commands: [pass()] });
  fs.writeFileSync(path.join(nested, "krites.toml"), BROKEN);
  const reason = assertBlock(await runHook(GATE, stop(repo)), /^In target\/wt\/x: Krites blocked the stop: /);
  assert.match(reason, BROKEN_LINE);
  assert.match(reason, /Run \/krites:init from a session started in target\/wt\/x\.$/);
  assert.strictEqual(readBlockCount(nested), 0, "a config error spends nothing");
});

test("gate: records from hook processes running at once past the cap all survive, and a stop past 4096 trims to 2048", async () => {
  const { repo } = touchedNested({ commands: [pass()] });
  const file = path.join(repo, ".krites", "touched");
  const others = Array.from({ length: 4200 }, (_, i) => `o${i}\t${path.join(repo, "target", "wt", `y${i}`)}\t`);
  fs.writeFileSync(file, `${others.join("\n")}\n`);
  const nested = Array.from({ length: 8 }, (_, i) => {
    const dir = path.join(repo, "target", "wt", `n${i}`);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    configure(dir, { commands: [pass()] });
    return dir;
  });
  const write = (dir) => ({ hook_event_name: "PreToolUse", tool_name: "Write", session_id: "s1", cwd: repo, tool_input: { file_path: path.join(dir, "a.txt") } });
  const results = await Promise.all(nested.map((dir) => runHook(PROTECT, write(dir))));
  for (const result of results) assert.deepStrictEqual(result, SILENT);
  const own = nested.map((dir) => `s1\t${dir}\t${head(dir)}`).sort();
  const read = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.deepStrictEqual(read().filter((line) => line.startsWith("s1\t")).sort(), own, "every concurrent record survives");
  assert.strictEqual(read().length, 4208);
  assert.deepStrictEqual(await runHook(GATE, stop(repo)), SILENT);
  const trimmed = read();
  assert.strictEqual(trimmed.length, 2048);
  assert.deepStrictEqual(trimmed.filter((line) => line.startsWith("s1\t")).sort(), own);
  assert.deepStrictEqual(trimmed.filter((line) => !line.startsWith("s1\t")), others.slice(2160));
  assert.deepStrictEqual(fs.readdirSync(path.join(repo, ".krites")).filter((name) => name.includes("touched")), ["touched"], "no temp file is left");
});

test("gate: a project dir that no krites root holds anchors the record on the outermost session root", async () => {
  const parent = makeDir();
  const repo = path.join(parent, "r");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "target/\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  configure(repo, { commands: [pass()] });
  seed(repo);
  const nested = path.join(repo, "target", "wt", "x");
  fs.mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q");
  configure(nested, { commands: [fail()] });
  const write = { hook_event_name: "PreToolUse", tool_name: "Write", session_id: "s1", cwd: repo, tool_input: { file_path: path.join(nested, "a.txt") } };
  assert.deepStrictEqual(await runHook(PROTECT, write, { env: { CLAUDE_PROJECT_DIR: parent } }), SILENT);
  fs.writeFileSync(path.join(nested, "a.txt"), "a\n");
  assertBlock(await runHook(GATE, stop(repo), { env: { CLAUDE_PROJECT_DIR: parent } }), /^In target\/wt\/x: Krites refuted the stop: /);
});

test("gate: a line recorded with an empty head gives way to the session's first line for that root with a head", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n", ".gitignore": "target/\n" } });
  configure(repo, { commands: [pass()] });
  seed(repo);
  const nested = path.join(repo, "target", "wt", "x");
  fs.mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q");
  fs.writeFileSync(path.join(nested, "krites.toml"), toml({ commands: [pass()], globs: ["fixtures/**"] }));
  const write = (rel) => ({ hook_event_name: "PreToolUse", tool_name: "Write", session_id: "s1", cwd: repo, tool_input: { file_path: path.join(nested, rel) } });
  assert.deepStrictEqual(await runHook(PROTECT, write("a.txt")), SILENT, "no commit yet, so the head is empty");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "init");
  const first = head(nested);
  assert.deepStrictEqual(await runHook(PROTECT, write("b.txt")), SILENT);
  assert.deepStrictEqual(await runHook(PROTECT, write("c.txt")), SILENT);
  const lines = fs.readFileSync(path.join(repo, ".krites", "touched"), "utf8").split("\n").filter(Boolean);
  assert.deepStrictEqual(lines, [`s1\t${nested}\t`, `s1\t${nested}\t${first}`], "a line with a head is recorded once");
  fs.mkdirSync(path.join(nested, "fixtures"));
  fs.writeFileSync(path.join(nested, "fixtures", "a.txt"), "a\n");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "fixture");
  assertBlock(await runHook(GATE, stop(repo)), /^In target\/wt\/x: Krites refuted the stop: protected path changed: fixtures\/a\.txt\./);
});

test("gate: a stop leaves a touched file of up to 4096 lines as it is", async () => {
  const { repo } = touchedNested({ commands: [pass()] });
  const file = path.join(repo, ".krites", "touched");
  const lines = Array.from({ length: 4096 }, (_, i) => `o${i}\t${path.join(repo, "target", "wt", `y${i}`)}\t`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  assert.deepStrictEqual(await runHook(GATE, stop(repo)), SILENT);
  assert.strictEqual(fs.readFileSync(file, "utf8"), `${lines.join("\n")}\n`);
});

test("gate: a trim whose rename fails leaves the lines and no temp file", () => {
  const { repo } = touchedNested({ commands: [pass()] });
  const file = path.join(repo, ".krites", "touched");
  const text = `${Array.from({ length: 4100 }, (_, i) => `o${i}\t${path.join(repo, "target", "wt", `y${i}`)}\t`).join("\n")}\n`;
  fs.writeFileSync(file, text);
  const { renameSync } = fs;
  fs.renameSync = () => {
    throw Object.assign(new Error("rename failed"), { code: "EIO" });
  };
  try {
    assert.throws(() => trimTouched(repo, "s1"), /rename failed/);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.strictEqual(fs.readFileSync(file, "utf8"), text);
  assert.deepStrictEqual(fs.readdirSync(path.join(repo, ".krites")).filter((name) => name.includes("touched")), ["touched"]);
});

test("gate: a project root that does not hold the edited root leaves the record to the session root that does", async () => {
  const project = makeRepo({ files: { "a.txt": "a\n" } });
  configure(project, { commands: [pass()] });
  seed(project);
  const { repo, nested } = touchedNested({ commands: [fail()] });
  fs.writeFileSync(path.join(repo, ".krites", "touched"), "");
  const write = { hook_event_name: "PreToolUse", tool_name: "Write", session_id: "s1", cwd: repo, tool_input: { file_path: path.join(nested, "b.txt") } };
  assert.deepStrictEqual(await runHook(PROTECT, write, { env: { CLAUDE_PROJECT_DIR: project } }), SILENT);
  assert.ok(!fs.existsSync(path.join(project, ".krites", "touched")), "nothing is recorded in the project root");
  fs.writeFileSync(path.join(nested, "b.txt"), "b\n");
  assertBlock(await runHook(GATE, stop(repo), { env: { CLAUDE_PROJECT_DIR: project } }), /^In target\/wt\/x: Krites refuted the stop: /);
});

test("gate: a trim whose temp write fails after the open leaves the lines and no temp file", () => {
  const { repo } = touchedNested({ commands: [pass()] });
  const file = path.join(repo, ".krites", "touched");
  const text = `${Array.from({ length: 4100 }, (_, i) => `o${i}\t${path.join(repo, "target", "wt", `y${i}`)}\t`).join("\n")}\n`;
  fs.writeFileSync(file, text);
  const { writeFileSync } = fs;
  fs.writeFileSync = (target, data, options) => {
    if (!String(target).includes(".touched.")) return writeFileSync(target, data, options);
    writeFileSync(target, "", options);
    throw Object.assign(new Error("write failed"), { code: "EIO" });
  };
  try {
    assert.throws(() => trimTouched(repo, "s1"), /write failed/);
  } finally {
    fs.writeFileSync = writeFileSync;
  }
  assert.strictEqual(fs.readFileSync(file, "utf8"), text);
  assert.deepStrictEqual(fs.readdirSync(path.join(repo, ".krites")).filter((name) => name.includes("touched")), ["touched"]);
});

test("gate: a trim that fails inside a stop still judges the touched root", async () => {
  const { gate } = require(GATE);
  const { repo, nested } = touchedNested({ commands: [fail()] });
  fs.writeFileSync(path.join(nested, "a.txt"), "changed\n");
  const others = Array.from({ length: 4100 }, (_, i) => `o${i}\t${path.join(repo, "target", "wt", `y${i}`)}\t`);
  fs.appendFileSync(path.join(repo, ".krites", "touched"), `${others.join("\n")}\n`);
  const { renameSync } = fs;
  fs.renameSync = (from, to) => {
    if (String(from).includes(".touched.")) throw Object.assign(new Error("rename failed"), { code: "EIO" });
    return renameSync(from, to);
  };
  try {
    assert.match(await fromTmp(() => gate(stop(repo), { projectDir: repo })), /^In target\/wt\/x: Krites refuted the stop: /);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.strictEqual(fs.readFileSync(path.join(repo, ".krites", "touched"), "utf8").split("\n").filter(Boolean).length, 4101, "the lines stay");
});

test("gate: a changed protected path is refuted with a reason that leaves a person's change to a commit and /krites:approve", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n", ".claude/settings.json": "{}\n" } });
  configure(repo, { commands: [pass()], globs: [".claude/settings.json"] });
  seed(repo);
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), '{ "model": "opus" }\n');
  assert.strictEqual(
    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed/),
    "Krites refuted the stop: protected path changed: .claude/settings.json. Protected paths are human-edited only: if you changed it, undo your change; if a person did, they commit it and review it with /krites:approve.",
  );

  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "{}\n");
  fs.appendFileSync(path.join(repo, "krites.toml"), "\n");
  assert.strictEqual(
    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed/),
    "Krites refuted the stop: protected path changed: krites.toml. If you changed it yourself, run /krites:init to approve it.",
  );
});

test("gate: a passing stop records the content it checked, and a refuted one records none", async () => {
  const repo = repoWith({ commands: [pass()] });
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  const run = lastRun(repo);
  assert.match(run.content, /^[0-9a-f]{64}$/);
  assert.strictEqual(run.content, contentHash(repo, run.head));

  const red = repoWith({ commands: [fail()] });
  assertBlock(await runHook(GATE, stop(red), { cwd: red }), /refuted/);
  assert.ok(!("content" in lastRun(red)), "a refuted run carries no content");

  const none = repoWith({ commands: [] });
  assert.deepStrictEqual(await runHook(GATE, stop(none), { cwd: none }), SILENT);
  assert.strictEqual(lastRun(none).verdict, "no_checks");
  assert.ok(!("content" in lastRun(none)), "a no_checks run carries no content");
});

test("gate: a passing stop on an unborn HEAD records its content", async () => {
  const fresh = makeRepo({ files: { "krites.toml": toml({ commands: [pass()] }), "a.txt": "a\n" }, commit: false });
  seed(fresh);
  assert.deepStrictEqual(await runHook(GATE, stop(fresh), { cwd: fresh }), SILENT);
  const run = lastRun(fresh);
  assert.strictEqual(run.head, "");
  assert.strictEqual(run.content, contentHash(fresh, ""));
});

test("gate: a passing run whose content hash failed records no content", () => {
  const repo = repoWith({ commands: [pass()] });
  const { recordRun } = require(GATE);
  const judged = { run: { verdict: "passed", checks: [] }, before: "f", record: null, content: null };
  recordRun(repo, loadConfig(repo), judged, { head: head(repo), dirty: true, baseline: null, reason: null, session_id: null });
  assert.strictEqual(lastRun(repo).verdict, "passed");
  assert.ok(!("content" in lastRun(repo)));
});

test("gate: a passing /krites:verify records its content too", async () => {
  const repo = repoWith({ commands: [pass()] });
  await runCli(["verify"], { cwd: repo });
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "passed");
  assert.strictEqual(run.content, contentHash(repo, run.head));
});
