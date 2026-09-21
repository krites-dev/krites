const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { BUDGET_MS, WATCHDOG_MS, budgetMs } = require("../hooks/gate.js");
const { readBaseline, readBlockCount } = require("../lib/state.js");
const { assertBlock, configure, git, makeRepo, runHook, script, seed, tmp, toml } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Generous, because a loaded CI runner can take seconds to write a file or reap a killed tree.
async function until(done, ms = 20000) {
  const limit = Date.now() + ms;
  while (!done() && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 200));
  return done();
}

// The pid file lives outside the repo, so a hung check never changes the tree fingerprint.
function hangs(name, grandchildOptions) {
  const pidFile = path.join(tmp, name);
  const argv = script(
    `const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], ${grandchildOptions});
     require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
     setTimeout(() => {}, 60000);`,
  );
  return {
    argv,
    async pids() {
      assert.ok(await until(() => fs.existsSync(pidFile)), `${name} was never written`);
      return JSON.parse(fs.readFileSync(pidFile, "utf8"));
    },
  };
}

function repoThatHangs(hang) {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [hang.argv], timeoutSeconds: 3 });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  return repo;
}

// A fresh module is a fresh hook process: each run has to spend its own attempt.
function freshGuarded() {
  delete require.cache[require.resolve("../hooks/gate.js")];
  return require("../hooks/gate.js").guarded;
}

test("deadline: the watchdog spends an attempt, and the fourth stop is allowed", { timeout: 180000 }, async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("setTimeout(() => process.exit(1), 3500)")] });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  const payload = { hook_event_name: "Stop", session_id: "s1", cwd: repo };
  const watched = () => freshGuarded()(payload, { watchdogMs: 3000, projectDir: repo });
  const left = path.join(repo, ".krites", "last-run.json");

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    fs.rmSync(left, { force: true });
    const reason = await watched();
    if (attempt < 4) assert.match(reason, /gate timed out after 3 s/);
    else assert.strictEqual(reason, null, "the fourth stop is allowed");
    assert.strictEqual(readBlockCount(repo), attempt, "the watchdog spends one attempt per run");
    assert.ok(await until(() => fs.existsSync(left)), "the run the watchdog left behind finishes on its own");
  }
  assert.strictEqual(readBlockCount(repo), 4, "the run left behind spends nothing a second time");
});

test("deadline: the watchdog charges the root it interrupted, not the one that already passed", { timeout: 180000 }, async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [script("process.exit(0)")] }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [script("setTimeout(() => process.exit(1), 3500)")] }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");

  const payload = { hook_event_name: "Stop", session_id: "s1", cwd: inner };
  const left = path.join(outer, ".krites", "last-run.json");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    fs.rmSync(left, { force: true });
    const reason = await freshGuarded()(payload, { watchdogMs: 3000, projectDir: outer });
    if (attempt < 4) assert.match(reason, /gate timed out after 3 s/);
    else assert.strictEqual(reason, null, "the chain ends with the interrupted root's budget");
    assert.strictEqual(readBlockCount(inner), 0, "the root that passed is never charged");
    assert.strictEqual(readBlockCount(outer), attempt);
    assert.ok(await until(() => fs.existsSync(left)), "the run the watchdog left behind finishes on its own");
  }
});

test("deadline: the watchdog never allows a stop while a config error is held", { timeout: 180000 }, async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), "version = 1\n\n[checks]\nnope = 1\n");
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [script("setTimeout(() => process.exit(1), 3500)")] }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");

  const payload = { hook_event_name: "Stop", session_id: "s1", cwd: inner };
  const left = path.join(outer, ".krites", "last-run.json");
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    fs.rmSync(left, { force: true });
    const reason = await freshGuarded()(payload, { watchdogMs: 3000, projectDir: outer });
    // Attempts 4 and 5 find the interrupted root's budget spent: what is left to say is the config error, and it is said.
    assert.match(String(reason), /krites\.toml line 4: /, `stop ${attempt} is blocked and names the held config error: ${reason}`);
    if (attempt <= 3) assert.match(reason, /^Krites blocked the stop: gate timed out after 3 s/, `stop ${attempt}: the watchdog's own reason comes first`);
    else assert.doesNotMatch(reason, /gate timed out/, `stop ${attempt}: the interrupted root's budget is spent, so only what is held is left`);
    assert.strictEqual(readBlockCount(outer), attempt, "the watchdog charges the root it interrupted");
    assert.ok(await until(() => fs.existsSync(left)), "the run the watchdog left behind finishes on its own");
  }
  assert.strictEqual(readBlockCount(inner), 0, "the root that was never judged is never charged");
});

test("deadline: a hung check is killed with its whole tree and the stop is blocked", { timeout: 120000 }, async () => {
  const hang = hangs("pids-tree.json", '{ stdio: "ignore" }');
  const repo = repoThatHangs(hang);
  const before = readBaseline(repo);

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /gate timed out after 3 s/);
  const pids = await hang.pids();

  assert.ok(await until(() => !alive(pids[0])), "the check process is gone");
  assert.ok(await until(() => !alive(pids[1])), "the grandchild is gone");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8")).verdict, "timed_out");
  assert.strictEqual(readBaseline(repo), before, "a timed-out run never advances the baseline");
});

test("deadline: the verdict does not wait for a grandchild that still holds the output pipe", { timeout: 120000 }, async () => {
  const hang = hangs("pids-escaped.json", '{ stdio: "inherit", detached: true }');
  const repo = repoThatHangs(hang);
  const started = Date.now();

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /gate timed out after 3 s/);
  assert.ok(Date.now() - started < 30000, "the answer comes from the deadline, not from the closed pipe");
});

test("deadline: two roots share one budget, so hung checks answer once", { timeout: 120000 }, async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  const hang = hangs("pids-two-roots.json", '{ stdio: "ignore" }');
  fs.writeFileSync(path.join(inner, "krites.toml"), "version = 1\n\n[checks]\ncommands = []\n");
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [hang.argv], timeoutSeconds: 3 }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);
  fs.writeFileSync(path.join(outer, "a.txt"), "changed\n");

  const started = Date.now();
  assertBlock(await runHook(GATE, stop(outer), { cwd: outer, env: { CLAUDE_PROJECT_DIR: inner.replace(/\\/g, "/") } }), /gate timed out after 3 s/);
  assert.ok(Date.now() - started < 30000, "one budget for the run, not one per root");
});

test("deadline: a timing-out check spends the attempt budget and then the stop is allowed", { timeout: 120000 }, async () => {
  const hang = hangs("pids-budget.json", '{ stdio: "ignore" }');
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [hang.argv], timeoutSeconds: 1 });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  const baseline = readBaseline(repo);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /gate timed out after 1 s/);
  }
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), { code: 0, stdout: "", stderr: "" });

  const run = JSON.parse(fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8"));
  assert.strictEqual(run.verdict, "timed_out", "an exhausted timeout keeps its own verdict");
  assert.strictEqual(run.reason, "attempt budget exhausted");
  assert.strictEqual(readBaseline(repo), baseline, "nothing advances");
});

test("deadline: the budget shrinks as the run goes on, and never goes below zero", () => {
  assert.strictEqual(BUDGET_MS, 820000);
  assert.strictEqual(WATCHDOG_MS, 880000);
  assert.strictEqual(budgetMs(0, 3), 3000);
  assert.strictEqual(budgetMs(0, 600), 600000);
  assert.strictEqual(budgetMs(819000, 600), 1000, "a later root gets only what is left");
  assert.strictEqual(budgetMs(821000, 600), 0, "an exhausted budget leaves nothing to run in");
});

test("deadline: a check that already exited is not killed by the pid it gave back", { timeout: 60000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("elsewhere the kill goes to the process group, which outlives its leader");
  // The check exits at once and a detached grandchild keeps its pipes open, so close never comes and the deadline fires.
  // Its cwd is outside the test's temp dir, which Windows could not remove under a process that is still there.
  const escaping = script(
    'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit", detached: true, cwd: require("node:os").tmpdir() }).unref();',
  );
  const driver = script(
    `const cp = require("node:child_process");
     const real = cp.spawnSync;
     const kills = [];
     cp.spawnSync = (file, args, options) => (file === "taskkill" ? (kills.push(args), { status: 0 }) : real(file, args, options));
     const { runChecks } = require(${JSON.stringify(path.join(__dirname, "..", "lib", "checks.js"))});
     runChecks({ commands: [${JSON.stringify(escaping)}], root: process.cwd(), deadlineMs: 2500 }).then((run) => {
       console.log(JSON.stringify({ verdict: run.verdict, kills }));
       process.exit(0);
     });`,
  )[1];
  const result = JSON.parse((await runHook(driver, null, { cwd: tmp })).stdout);
  assert.strictEqual(result.verdict, "timed_out", "the grandchild held the pipes past the deadline");
  assert.deepStrictEqual(result.kills, [], "no taskkill is sent to a pid whose process has already ended");
});
