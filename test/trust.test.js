const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { fingerprint, hashText, readBlockCount, readConfigHash, sha256, writeConfigHash, writeLastRun } = require("../lib/state.js");
const {
  CHANGED_SESSION,
  CHANGED_STOP,
  CHANGED_VERIFY,
  FILE,
  UNAPPROVED_SESSION,
  UNAPPROVED_STOP,
  UNAPPROVED_VERIFY,
  isTrusted,
  trustedHash,
} = require("../lib/trust.js");
const { ABSOLUTE, assertBlock, configure, git, head, makeDir, makeRepo, runCli, runHook, script, tmp, toml } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const PROTECT = path.join(__dirname, "..", "hooks", "protect.js");
const SESSION = path.join(__dirname, "..", "hooks", "session.js");
const SILENT = { code: 0, stdout: "", stderr: "" };

const start = (cwd) => ({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd });
const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });
const edit = (file, cwd) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", session_id: "s1", cwd, tool_input: { file_path: file }, permission_mode: "default" });
const world = () => ({ KRITES_CONFIG_DIR: makeDir() });

test("trust: a newly cloned repo's krites.toml is never auto-approved or executed until /krites:init-write", async () => {
  const env = world();
  const marker = path.join(tmp, `untrusted-clone-${Date.now()}.txt`);
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)] }, { approved: false });

  const started = await runHook(SESSION, start(repo), { cwd: repo, env });
  assert.strictEqual(started.code, 0);
  assert.strictEqual(JSON.parse(started.stdout).systemMessage, UNAPPROVED_SESSION);
  assert.strictEqual(readConfigHash(repo), null, "session start does not write config-hash for an unapproved repo");

  // A read-only stop on a clean tree still skips without running checks.
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT);
  assert.strictEqual(fs.existsSync(marker), false);

  // Any change to the tree blocks without executing krites.toml and spends no attempt.
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(assertBlock(await runHook(GATE, stop(repo), { cwd: repo, env }), /not approved/), UNAPPROVED_STOP);
    assert.strictEqual(readBlockCount(repo), 0, "an unapproved config is held and spends no attempt");
  }
  assert.strictEqual(fs.existsSync(marker), false, "stop gate never executed the unapproved check");

  // /krites:verify also refuses to execute unapproved commands.
  const verify = await runCli(["verify"], { cwd: repo, env });
  assert.strictEqual(verify.code, 0);
  assert.strictEqual(verify.stdout.trim(), UNAPPROVED_VERIFY);
  assert.strictEqual(fs.existsSync(marker), false, "verify never executed the unapproved check");

  // After explicit /krites:init-write, the hash is trusted in user configDir and checks run.
  const approved = await runCli(["init", "--write"], { cwd: repo, env });
  assert.strictEqual(approved.code, 0);
  assert.match(approved.stdout, /The gate now accepts this krites\.toml\./);
  const hash = hashText(fs.readFileSync(path.join(repo, "krites.toml"), "utf8"));
  assert.strictEqual(isTrusted(repo, hash, env.KRITES_CONFIG_DIR), true);

  assert.deepStrictEqual(await runHook(SESSION, start(repo), { cwd: repo, env }), SILENT);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed again\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT);
  assert.strictEqual(fs.existsSync(marker), true, "checks execute once the user approves krites.toml");
});

test("trust: a repo committing forged .krites/config-hash and .krites/last-run.json cannot bypass approval", async () => {
  const env = world();
  const marker = path.join(tmp, `untrusted-forged-${Date.now()}.txt`);
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  const cmd = script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
  configure(repo, { commands: [cmd] }, { approved: false });
  const hash = hashText(fs.readFileSync(path.join(repo, "krites.toml"), "utf8"));

  fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
  writeConfigHash(repo, hash);
  writeLastRun(repo, {
    schema: "krites.last-run/0.1",
    plugin_version: "0.5.1",
    created_at: "2026-11-21T00:00:00Z",
    root_hash: sha256(repo),
    head: head(repo),
    dirty: true,
    fingerprint: fingerprint(repo),
    config_hash: hash,
    commands: [cmd],
    slow: [],
    env: [],
    diff: { files_changed: 1, insertions: 1, deletions: 1, files: ["a.txt"] },
    checks: [{ command: cmd.join(" "), exit_code: 0, duration_ms: 1, tail: "" }],
    verdict: "passed",
    reason: null,
    session_id: "s1",
  });

  assert.strictEqual(assertBlock(await runHook(GATE, stop(repo), { cwd: repo, env }), /not approved/), UNAPPROVED_STOP);
  assert.strictEqual(fs.existsSync(marker), false);
});

test("trust: pulling a changed krites.toml between sessions invalidates trust until re-approved", async () => {
  const env = world();
  const evil = path.join(tmp, `untrusted-pr-${Date.now()}.txt`);
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] }, { approved: false });
  assert.strictEqual((await runCli(["init", "--write"], { cwd: repo, env })).code, 0);
  const firstHash = trustedHash(repo, env.KRITES_CONFIG_DIR);
  assert.ok(firstHash);

  // Simulate pulling a PR that replaces krites.toml with a malicious command, then starting a fresh session.
  fs.writeFileSync(path.join(repo, "krites.toml"), toml({ commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(evil)}, "pwned");`)] }));
  git(repo, "add", "krites.toml");
  git(repo, "commit", "-q", "-m", "pr changing krites.toml");
  // Drop repo-local config-hash as a fresh checkout would have none.
  fs.rmSync(path.join(repo, ".krites", "config-hash"), { force: true });

  const started = await runHook(SESSION, start(repo), { cwd: repo, env });
  assert.strictEqual(JSON.parse(started.stdout).systemMessage, CHANGED_SESSION);

  fs.writeFileSync(path.join(repo, "a.txt"), "work\n");
  assert.strictEqual(assertBlock(await runHook(GATE, stop(repo), { cwd: repo, env }), /changed since you last approved/), CHANGED_STOP);
  assert.strictEqual((await runCli(["verify"], { cwd: repo, env })).stdout.trim(), CHANGED_VERIFY);
  assert.strictEqual(fs.existsSync(evil), false, "the PR's malicious check never ran");
});

test("trust: /krites:approve-write updates user trust for a committed krites.toml change", async () => {
  const env = world();
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] }, { approved: false });
  assert.strictEqual((await runCli(["init", "--write"], { cwd: repo, env })).code, 0);
  assert.deepStrictEqual(await runHook(SESSION, start(repo), { cwd: repo, env }), SILENT);

  fs.appendFileSync(path.join(repo, "krites.toml"), "# approved commit\n");
  git(repo, "add", "krites.toml");
  git(repo, "commit", "-q", "-m", "update config");

  assert.strictEqual((await runCli(["approve"], { cwd: repo, env })).code, 0);
  assert.strictEqual((await runCli(["approve", "--write"], { cwd: repo, env })).code, 0);
  const newHash = hashText(fs.readFileSync(path.join(repo, "krites.toml"), "utf8"));
  assert.strictEqual(isTrusted(repo, newHash, env.KRITES_CONFIG_DIR), true);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT);
});

test("trust: a damaged trust file fails closed and edit tools cannot modify trusted-configs.json", async () => {
  const env = world();
  const dir = env.KRITES_CONFIG_DIR;
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] }, { approved: false });
  assert.strictEqual((await runCli(["init", "--write"], { cwd: repo, env })).code, 0);

  // Corrupt trusted-configs.json -> fail closed.
  fs.writeFileSync(path.join(dir, FILE), "{broken json");
  fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
  assert.strictEqual(assertBlock(await runHook(GATE, stop(repo), { cwd: repo, env }), /not approved/), UNAPPROVED_STOP);

  // Even with allow_outside opening KRITES_CONFIG_DIR, protect.js denies editing trusted-configs.json.
  fs.writeFileSync(path.join(dir, "config.toml"), `[protect]\nallow_outside = ["${dir.replace(/\\/g, "/")}/**"]\n`);
  const denied = await runHook(PROTECT, edit(path.join(dir, FILE), repo), { cwd: repo, env });
  const out = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.strictEqual(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /own configuration/);
  assert.doesNotMatch(out.permissionDecisionReason, ABSOLUTE);
});

test("trust: an unapproved nested repo is held with its folder label and never runs checks", async () => {
  const env = world();
  const marker = path.join(tmp, `untrusted-nested-${Date.now()}.txt`);
  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  configure(outer, { commands: [script("process.exit(0)")] }, { approved: false });
  assert.strictEqual((await runCli(["init", "--write"], { cwd: outer, env })).code, 0);
  assert.deepStrictEqual(await runHook(SESSION, start(outer), { cwd: outer, env }), SILENT);

  const nested = path.join(outer, "sub");
  fs.mkdirSync(nested);
  git(nested, "init", "-q");
  fs.writeFileSync(path.join(nested, "b.txt"), "b\n");
  fs.writeFileSync(path.join(nested, "krites.toml"), toml({ commands: [script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`)] }));
  git(nested, "add", "-A");
  git(nested, "commit", "-q", "-m", "nested");

  // Edit inside nested root records it in outer's touched list.
  const write = { hook_event_name: "PreToolUse", tool_name: "Write", session_id: "s1", cwd: outer, tool_input: { file_path: path.join(nested, "b.txt") } };
  assert.deepStrictEqual(await runHook(PROTECT, write, { cwd: outer, env }), SILENT);
  fs.writeFileSync(path.join(nested, "b.txt"), "changed\n");

  const reason = assertBlock(await runHook(GATE, stop(outer), { cwd: outer, env }), /^In sub: Krites blocked the stop: krites\.toml is not approved/);
  assert.match(reason, /\/krites:init from a session started in sub/);
  assert.match(reason, /\/krites:init-write from a session started in sub/);
  assert.strictEqual(fs.existsSync(marker), false);
});
