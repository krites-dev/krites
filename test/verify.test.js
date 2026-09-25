const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const cli = require("../cli.js");
const { readBaseline, readBlockCount, writeBlockCount } = require("../lib/state.js");
const { ABSOLUTE, configure, git, head, makeDir, makeRepo, runCli, runHook, script, seed, tmp, toml } = require("./helpers.js");

const CAP = "timed out after 540 s (capped under /krites:verify; the stop gate allows 600 s)";

// A check that outlives the kill would hold the pipes its parent reads, so it lets them go and ends by itself.
const hangs = () =>
  script(
    [
      "process.stdout.destroy();",
      "process.stderr.destroy();",
      "setTimeout(() => {}, 30000);",
    ].join("\n"),
  );

const lastRun = (repo) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8"));
  } catch {
    return null;
  }
};

const printed = (result) => {
  assert.strictEqual(result.code, 0, "exit code is 0 on every verdict");
  assert.strictEqual(result.stderr, "", "nothing on stderr");
  assert.doesNotMatch(result.stdout, ABSOLUTE, "no absolute path in the output");
  const lines = result.stdout.split("\n");
  assert.strictEqual(lines.pop(), "", "the output ends with exactly one newline");
  return lines;
};

// 60 s keeps the cap line out of the way; only the cap test wants it.
function repoWith(commands, extra = {}) {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands, timeoutSeconds: 60, ...extra });
  seed(repo);
  return repo;
}

test("verify: a passing run prints each command, its output and its exit code, and nothing else", async () => {
  const repo = repoWith([script("console.log('first out')"), script("console.log('second out')")]);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  const lines = printed(await runCli(["verify"], { cwd: repo }));
  assert.strictEqual(lines.length, 6, lines.join("\n"));
  assert.match(lines[0], /^node .*check\d+\.js$/);
  assert.strictEqual(lines[1], "first out");
  assert.strictEqual(lines[2], "exit 0");
  assert.match(lines[3], /^node .*check\d+\.js$/);
  assert.strictEqual(lines[4], "second out");
  assert.strictEqual(lines[5], "exit 0", "nothing follows the last exit line");
  assert.strictEqual(lastRun(repo).verdict, "passed");
});

test("verify: a failing check is printed with its exit code and the later check never runs", async () => {
  const marker = path.join(tmp, `verify-unreached${Date.now()}.txt`);
  const repo = repoWith([
    script("console.log('boom'); process.exit(3)"),
    script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`),
  ]);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  const lines = printed(await runCli(["verify"], { cwd: repo }));
  assert.strictEqual(lines.length, 3, lines.join("\n"));
  assert.strictEqual(lines[1], "boom");
  assert.strictEqual(lines[2], "exit 3");
  assert.strictEqual(fs.existsSync(marker), false, "the check after the failure is never run and never printed");
  assert.strictEqual(lastRun(repo).verdict, "refuted");
});

test("verify: a check past the deadline is reported as timed out, not as an exit code", { timeout: 120000 }, async () => {
  const repo = repoWith([hangs()], { timeoutSeconds: 1 });
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  const lines = printed(await runCli(["verify"], { cwd: repo }));
  assert.strictEqual(lines[lines.length - 1], "timed out after 1 s", lines.join("\n"));
  assert.strictEqual(lastRun(repo).verdict, "timed_out");
});

test("verify: a grandchild that escapes the kill and holds the output pipe does not keep the command open", { timeout: 120000 }, async () => {
  // The check exits at once and leaves a detached grandchild holding its pipes for 25 s: no tree kill can find it.
  // Its cwd is outside the test's temp dir, which Windows cannot remove under a process that is still there.
  const escaping = script(
    [
      'const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 25000)"], { stdio: "inherit", detached: true, cwd: require("node:os").tmpdir() });',
      "child.unref();",
    ].join("\n"),
  );
  const repo = repoWith([escaping], { timeoutSeconds: 3 });
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  const started = Date.now();
  const lines = printed(await runCli(["verify"], { cwd: repo }));
  const elapsed = Date.now() - started;
  assert.strictEqual(lines[lines.length - 1], "timed out after 3 s", lines.join("\n"));
  assert.ok(elapsed < 20000, `the command answered in ${elapsed} ms, well before the escaped grandchild let go at 25 s`);
});

test("verify: no configured checks say so, and no verdict word is printed", async () => {
  const repo = repoWith([]);
  const lines = printed(await runCli(["verify"], { cwd: repo }));
  assert.deepStrictEqual(lines, ["krites.toml configures no checks, so nothing ran."]);
  assert.strictEqual(lastRun(repo).verdict, "no_checks");
});

test("verify: a protected path that changed is reported as the gate words it and no check runs", async () => {
  const marker = path.join(tmp, `verify-protected${Date.now()}.txt`);
  const repo = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } });
  configure(repo, {
    commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)],
    timeoutSeconds: 60,
    globs: ["secrets/**"],
  });
  seed(repo);
  fs.writeFileSync(path.join(repo, "secrets", "rule.md"), "weakened\n");

  const lines = printed(await runCli(["verify"], { cwd: repo }));
  assert.strictEqual(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /protected path changed: secrets\/rule\.md/);
  assert.strictEqual(fs.existsSync(marker), false, "no check runs once a protected path changed");
  assert.strictEqual(lastRun(repo).verdict, "refuted");
});

test("verify: the cap is named only where it bites, on the line of a check it cut off", async () => {
  const repo = repoWith([script("console.log('ok')")], { timeoutSeconds: 600 });
  const lines = printed(await runCli(["verify"], { cwd: repo }));
  assert.ok(!lines.some((line) => /capped/.test(line)), "the default config prints no cap notice on a run that finished");
  assert.strictEqual(lines[lines.length - 1], "exit 0");

  assert.strictEqual(cli.timeoutLine(60), "timed out after 60 s");
  assert.strictEqual(cli.timeoutLine(540), "timed out after 540 s");
  assert.strictEqual(cli.timeoutLine(600), CAP);
});

test("verify: the deadline is the configured timeout, capped at what is left of one 540 s budget", () => {
  assert.strictEqual(cli.deadlineMs(1), 1000);
  assert.strictEqual(cli.deadlineMs(539), 539000);
  assert.strictEqual(cli.deadlineMs(540), 540000);
  assert.strictEqual(cli.deadlineMs(600), 540000);
  assert.strictEqual(cli.deadlineMs(820), 540000);

  const table = [
    [1, 0, 1000],
    [600, 0, 540000],
    [600, 1000, 539000],
    [600, 300000, 240000],
    [60, 300000, 60000],
    [60, 490000, 50000],
    [60, 539000, 1000],
    [60, 540000, 0],
    [60, 900000, 0],
  ];
  for (const [seconds, elapsedMs, want] of table) {
    assert.strictEqual(cli.deadlineMs(seconds, elapsedMs), want, `${seconds} s after ${elapsedMs} ms`);
  }
  assert.strictEqual(cli.timeoutLine(60, 40000), "timed out after 40 s (capped under /krites:verify; the stop gate allows 60 s)");
  assert.strictEqual(cli.timeoutLine(60, 60000), "timed out after 60 s", "the cap is named only when it, not the config, was the deadline");
  // Rounding up would promise a second the check never got.
  assert.strictEqual(cli.timeoutLine(3, 2600), "timed out after 2 s (capped under /krites:verify; the stop gate allows 3 s)");
  assert.strictEqual(cli.timeoutLine(3, 2400), "timed out after 2 s (capped under /krites:verify; the stop gate allows 3 s)");
});

test("verify: two roots share one budget and the second gets only what is left", { timeout: 120000 }, async () => {
  const hang = hangs();
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [hang], timeoutSeconds: 3 }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [hang], timeoutSeconds: 20 }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);

  // 6 s of budget: the inner root spends its own 3 s and the outer root can only have what is left of the 6.
  const driver = script(
    `require(${JSON.stringify(path.join(__dirname, "..", "cli.js"))}).main(["verify"], { capMs: 6000, startedAt: Date.now() }).then((text) => process.stdout.write(text, () => process.exit(0)));`,
  )[1];
  const started = Date.now();
  const lines = printed(await runHook(driver, null, { cwd: inner, env: { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") } }));
  const elapsed = Date.now() - started;

  assert.strictEqual(lines[2], "timed out after 3 s", lines.join("\n"));
  // Either end proves the shared budget: the outer root is cut short, or the first root left it nothing at all.
  const last = lines[lines.length - 1];
  const cut = /^timed out after [0-5] s \(capped under \/krites:verify; the stop gate allows 20 s\)$/.test(last);
  assert.ok(cut || last === "not run: /krites:verify's 6 s were spent before this root", lines.join("\n"));
  assert.ok(elapsed < 20000, `both roots ran inside the one budget (${elapsed} ms)`);
});

// verify in this process, with the root's own overhead (fingerprints, git calls) played by a wait before the real judge.
async function verifyAfter(overheadMs, repo, capMs, seen = (ms) => ms) {
  const gate = require("../hooks/gate.js");
  const realJudge = gate.judge;
  const cwd = process.cwd();
  const project = process.env.CLAUDE_PROJECT_DIR;
  try {
    gate.judge = async (root, loaded, options) => {
      await new Promise((resolve) => setTimeout(resolve, overheadMs));
      return realJudge(root, loaded, { ...options, deadline: () => seen(options.deadline()) });
    };
    process.chdir(repo);
    process.env.CLAUDE_PROJECT_DIR = repo;
    return await cli.main(["verify"], { capMs, startedAt: Date.now() });
  } finally {
    gate.judge = realJudge;
    process.chdir(cwd);
    if (project === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = project;
  }
}

test("verify: the checks are given what is left when they start, not what was left before the root's own overhead", async () => {
  const repo = repoWith([script("process.exit(0)")]);
  let given = null;
  // A wide cap: on a loaded machine the root's real git calls must not spend it all, or nothing is judged at all.
  await verifyAfter(1200, repo, 30000, (ms) => (given = ms));
  assert.notStrictEqual(given, null, "the root was judged");
  assert.ok(given <= 28800, `the checks were given ${given} ms of a 30000 ms budget that had already spent 1200 ms`);
});

test("verify: a root whose own overhead spends the budget runs no check and keeps its last run", async () => {
  const marker = path.join(tmp, `verify-starved-marker${Date.now()}.txt`);
  const repo = repoWith([script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)]);
  await verifyAfter(0, repo, 60000);
  const file = path.join(repo, ".krites", "last-run.json");
  const before = fs.readFileSync(file, "utf8");
  assert.strictEqual(JSON.parse(before).verdict, "passed");
  fs.rmSync(marker);

  const text = await verifyAfter(1300, repo, 1000);
  assert.strictEqual(text, "not run: /krites:verify's 1 s were spent before this root\n");
  assert.strictEqual(fs.existsSync(marker), false, "no check was started with a millisecond to live");
  assert.strictEqual(fs.readFileSync(file, "utf8"), before, "the good run is still the recorded one");
});

test("verify: a second run in the same process answers with its own text alone", async () => {
  const first = await cli.main(["telemetry"]);
  const second = await cli.main(["telemetry"]);
  assert.strictEqual(second, first, "the second call answers with the first call's text again");
  assert.strictEqual(second.split("\n").filter(Boolean).length, 1, second);
});

test("verify: a root left with no time is not run at all", { timeout: 120000 }, async () => {
  const marker = path.join(tmp, `verify-spent-marker${Date.now()}.txt`);
  const hang = hangs();
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [hang], timeoutSeconds: 20 }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)], timeoutSeconds: 20 }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(inner, outer);

  const driver = script(
    `require(${JSON.stringify(path.join(__dirname, "..", "cli.js"))}).main(["verify"], { capMs: 3000, startedAt: Date.now() }).then((text) => process.stdout.write(text, () => process.exit(0)));`,
  )[1];
  const lines = printed(await runHook(driver, null, { cwd: inner, env: { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") } }));

  assert.strictEqual(lines.length, 5, lines.join("\n"));
  assert.match(lines[2], /^timed out after [0-2] s \(capped under \/krites:verify; the stop gate allows 20 s\)$/, lines.join("\n"));
  assert.strictEqual(lines[3], "## ..");
  assert.strictEqual(lines[4], "not run: /krites:verify's 3 s were spent before this root");
  assert.strictEqual(fs.existsSync(marker), false, "the root with no time left runs no check");
  assert.strictEqual(fs.existsSync(path.join(outer, ".krites")), false, "and writes nothing at all");
});

test("verify: a check killed by a signal is reported as that, not as a timeout", async (t) => {
  if (process.platform === "win32") return t.skip("win32 has no signals, so a check cannot kill itself with one");
  const repo = repoWith([script('process.kill(process.pid, "SIGKILL");')]);
  const lines = printed(await runCli(["verify"], { cwd: repo }));

  assert.strictEqual(lines[lines.length - 1], "killed by a signal", lines.join("\n"));
  assert.strictEqual(lastRun(repo).verdict, "refuted");
  assert.strictEqual(lastRun(repo).checks[0].exit_code, null, "a signal leaves no exit code");
});

test("verify: a clean tree at the baseline is still run, unlike a stop", async () => {
  const repo = repoWith([script("console.log('asked for it')")]);
  assert.strictEqual(readBaseline(repo), head(repo), "the gate would skip this tree");

  const lines = printed(await runCli(["verify"], { cwd: repo }));
  assert.strictEqual(lines[1], "asked for it");
  assert.strictEqual(lastRun(repo).verdict, "passed");
});

test("verify: a pass advances the baseline and resets the block count; a refutation changes neither", async () => {
  const flag = path.join(tmp, `verify-flag${Date.now()}.txt`);
  fs.writeFileSync(flag, "bad");
  const repo = repoWith([script(`process.exit(require("node:fs").readFileSync(${JSON.stringify(flag)}, "utf8") === "ok" ? 0 : 1);`)]);
  const baseline = readBaseline(repo);
  writeBlockCount(repo, 2);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "work");

  printed(await runCli(["verify"], { cwd: repo }));
  assert.strictEqual(lastRun(repo).verdict, "refuted");
  assert.strictEqual(readBlockCount(repo), 2, "a refuted verify spends no attempt");
  assert.strictEqual(readBaseline(repo), baseline, "and advances nothing");

  fs.writeFileSync(flag, "ok");
  printed(await runCli(["verify"], { cwd: repo }));
  assert.strictEqual(lastRun(repo).verdict, "passed");
  assert.strictEqual(readBlockCount(repo), 0, "a pass resets the block count");
  assert.strictEqual(readBaseline(repo), head(repo), "and advances the baseline");
});

test("verify: more than one root gets a heading each, one root gets none", async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [script("console.log('inner ran')")], timeoutSeconds: 60 }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [script("console.log('outer ran')")], timeoutSeconds: 60 }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);

  const both = printed(await runCli(["verify"], { cwd: inner, env: { CLAUDE_PROJECT_DIR: outer.replace(/\\/g, "/") } }));
  assert.deepStrictEqual(
    both.filter((line) => line.startsWith("## ")),
    ["## .", "## .."],
    both.join("\n"),
  );
  assert.ok(both.includes("inner ran") && both.includes("outer ran"), both.join("\n"));

  const one = printed(await runCli(["verify"], { cwd: outer }));
  assert.ok(!one.some((line) => line.startsWith("## ")), "one root needs no heading");
});

test("verify: no krites.toml anywhere prints the one init line", async () => {
  const plain = makeDir({ "a.txt": "a\n" });
  for (const args of [["verify"], ["receipt"]]) {
    const lines = printed(await runCli(args, { cwd: plain }));
    assert.strictEqual(lines.length, 1, args.join(" "));
    assert.match(lines[0], /no krites\.toml/);
    assert.match(lines[0], /\/krites:init/);
  }
  assert.strictEqual(fs.existsSync(path.join(plain, ".krites")), false, "nothing is written where no root is");
});

test("verify: a config error and a tree git cannot read are reported, and no check runs", async () => {
  const broken = makeDir({ "krites.toml": "version = 1\n\n[checks]\nnope = 1\n" });
  assert.match(printed(await runCli(["verify"], { cwd: broken }))[0], /krites\.toml line 4: .*Run \/krites:init\./);

  const marker = path.join(tmp, `verify-nogit${Date.now()}.txt`);
  const loose = makeDir({
    "krites.toml": toml({ commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)], timeoutSeconds: 60 }),
  });
  assert.match(printed(await runCli(["verify"], { cwd: loose }))[0], /could not list the changed paths/);
  assert.strictEqual(fs.existsSync(marker), false);
});

test("verify: telemetry answers in one line while the endpoint is off", async () => {
  const repo = repoWith([script("process.exit(0)")]);
  for (const args of [["telemetry"], ["telemetry", "on"], ["telemetry", "off"]]) {
    const lines = printed(await runCli(args, { cwd: repo }));
    assert.deepStrictEqual(lines, ["Telemetry is switched off: KRITES_PING_ENDPOINT is set to off, so nothing is asked and nothing is sent."], args.join(" "));
  }
});

test("verify: slow checks run after the commands, and only when every command passed", async () => {
  const repo = repoWith([script("console.log('fast out')")], { slow: [script("console.log('slow out')")] });
  const lines = printed(await runCli(["verify"], { cwd: repo }));
  assert.deepStrictEqual(lines.filter((line) => !line.startsWith("node ")), ["fast out", "exit 0", "slow out", "exit 0"]);
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "passed");
  assert.deepStrictEqual(run.checks.map((check) => check.exit_code), [0, 0]);
  assert.strictEqual(run.slow.length, 1);

  const marker = path.join(tmp, `slow-unreached${Date.now()}.txt`);
  const failing = repoWith([script("process.exit(2)")], { slow: [script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)] });
  const refuted = printed(await runCli(["verify"], { cwd: failing }));
  assert.strictEqual(refuted[refuted.length - 1], "exit 2");
  assert.strictEqual(fs.existsSync(marker), false, "a failing command means the slow check never starts");
  assert.strictEqual(lastRun(failing).verdict, "refuted");
});

test("verify: each root gets one line naming the file and key, project settings coming from CLAUDE_PROJECT_DIR", async () => {
  const outer = makeRepo({
    files: {
      "a.txt": "a\n",
      ".claude/settings.json": JSON.stringify({ disableAllHooks: true }),
      "inner/.claude/settings.json": JSON.stringify({ enabledPlugins: { "krites@krites": false } }),
    },
  });
  const inner = path.join(outer, "inner");
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [script("process.exit(0)")], timeoutSeconds: 60 }));
  fs.writeFileSync(path.join(outer, "krites.toml"), toml({ commands: [script("process.exit(0)")], timeoutSeconds: 60 }));
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(outer);
  seed(inner, outer);
  const OFF_LINE = "Krites hooks are off for this repo: .claude/settings.json sets disableAllHooks.";

  const lines = printed(await runCli(["verify"], { cwd: inner, env: { CLAUDE_PROJECT_DIR: outer } }));
  assert.deepStrictEqual(lines.filter((line) => line.startsWith("Krites hooks")), [OFF_LINE, OFF_LINE], "the inner root's own file is not read");
  lines.forEach((line, at) => line === OFF_LINE && assert.strictEqual(lines[at - 1], "exit 0", "each line follows the checks of its root"));
  assert.deepStrictEqual(lines.filter((line) => line.startsWith("## ")), ["## .", "## .."], lines.join("\n"));

  const bare = makeRepo({ files: { "a.txt": "a\n" } });
  configure(bare, { commands: [script("process.exit(0)")], timeoutSeconds: 60 });
  seed(bare);
  const clean = printed(await runCli(["verify"], { cwd: bare }));
  assert.ok(!clean.some((line) => line.includes("Krites")), clean.join("\n"));
});

test("verify: a managed directory from KRITES_MANAGED_SETTINGS_DIR is read, allowManagedHooksOnly there is may-be", async () => {
  const repo = repoWith([script("process.exit(0)")]);
  const managed = (settings) => ({ KRITES_MANAGED_SETTINGS_DIR: makeDir({ "managed-settings.json": JSON.stringify(settings) }) });
  const off = printed(await runCli(["verify"], { cwd: repo, env: managed({ disableAllHooks: true }) }));
  assert.strictEqual(off[off.length - 1], "Krites hooks are off for this repo: managed-settings.json sets disableAllHooks.", off.join("\n"));
  const may = printed(await runCli(["verify"], { cwd: repo, env: managed({ allowManagedHooksOnly: true }) }));
  assert.strictEqual(may[may.length - 1], "Krites hooks may be disabled for this repo: managed-settings.json sets allowManagedHooksOnly.", may.join("\n"));
  assert.strictEqual(lastRun(repo).verdict, "passed", "the checks still run and are recorded");
});

test("verify: a settings file that does not parse is named, and the others are still read", async () => {
  const repo = repoWith([script("process.exit(0)")]);
  const env = { CLAUDE_CONFIG_DIR: makeDir({ "settings.json": "{broken" }), KRITES_MANAGED_SETTINGS_DIR: makeDir({ "managed-settings.json": JSON.stringify({ disableAllHooks: true }) }) };
  const lines = printed(await runCli(["verify"], { cwd: repo, env }));
  assert.deepStrictEqual(lines.slice(-2), [
    "Krites cannot read $CLAUDE_CONFIG_DIR/settings.json, so its hooks setting is unknown.",
    "Krites hooks are off for this repo: managed-settings.json sets disableAllHooks.",
  ]);
});
