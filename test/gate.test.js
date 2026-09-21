const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { readBaseline, readBlockCount, readConfigHash, writeBlockCount } = require("../lib/state.js");
const { ABSOLUTE, assertBlock, configure, git, head, makeDir, makeRepo, runCli, runHook, script, seed, textOf, tmp, toml } = require("./helpers.js");

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
  const key = "ghp_0123456789abcdefghijABCDEFGHIJ";
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
    assert.match(await gate(stop(broken), { projectDir: broken }), BROKEN_LINE);
    assert.strictEqual(sent, 0, "a held reason means the stop is not an allowed one");
    assert.strictEqual(await gate(stop(fine), { projectDir: fine }), null);
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
  assert.match(await gate(stop(repo), { projectDir: repo }), /refuted/);
  assert.match(await gate(null, { projectDir: repo }), /not an object/);
  assert.strictEqual(readBlockCount(repo), 2, "the second call is its own run");
});

test("gate: called again in one process it counts like a fresh hook process", async () => {
  const { gate } = require(GATE);
  const repo = repoWith({ commands: [fail()] });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.match(await gate(stop(repo), { projectDir: repo }), /refuted/);
    assert.strictEqual(readBlockCount(repo), attempt, "what one call charged does not answer for the next");
  }
  assert.strictEqual(await gate(stop(repo), { projectDir: repo }), null);
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
  const reason = await gate({ hook_event_name: "Stop", session_id: "s1", cwd: outer }, { totalMs: 6000, startedAt: started, projectDir: inner });
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
    console.error("token sk-abcdefghijklmnopqrstuvwxyz0123");
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
