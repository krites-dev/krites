const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { configure, git, makeDir, makeRepo, runCli, runHook, script, seed, toml } = require("./helpers.js");

const COMMIT = path.join(__dirname, "..", "hooks", "commit.js");
const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const SILENT = { code: 0, stdout: "", stderr: "" };
const WINDOWS = process.platform === "win32";
const RERUN = /Let the checks run on everything this commit carries \(end your turn, or run node ".+cli\.js" verify with the tool's timeout at 600000\), then commit it all at once\.$/;

const call = (tool) => (cwd, command) => ({ hook_event_name: "PreToolUse", tool_name: tool, session_id: "s1", cwd, tool_input: { command } });
const bash = call("Bash");
const powershell = call("PowerShell");
const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });
const write = (repo, files) => Object.entries(files).forEach(([rel, text]) => fs.writeFileSync(path.join(repo, rel), text));
const { decide } = require(COMMIT);

async function checked({ check = "process.exit(0)", change = { "a.txt": "changed\n" }, run = true } = {}) {
  const repo = makeRepo({ files: { "a.txt": "a\n", "b.txt": "b\n" } });
  configure(repo, { commands: [script(check)] });
  seed(repo);
  write(repo, change);
  // The run's time is whole seconds, so a change written in that second would read as written after it.
  const before = new Date(Date.now() - 3600000);
  for (const rel of Object.keys(change)) fs.utimesSync(path.join(repo, rel), before, before);
  if (run) await runHook(GATE, stop(repo), { cwd: repo });
  return repo;
}

// decide() loaded fresh with spawnSync counted, as protect.test.js counts the walk's.
function spawnsOf(run) {
  const child = require("node:child_process");
  const { spawnSync } = child;
  const files = [COMMIT, "../lib/config.js", "../lib/state.js"].map((file) => require.resolve(file));
  const cached = files.map((file) => require.cache[file]);
  const calls = [];
  child.spawnSync = (...args) => (calls.push(args), spawnSync(...args));
  try {
    files.forEach((file) => delete require.cache[file]);
    run(require(COMMIT).decide);
  } finally {
    child.spawnSync = spawnSync;
    files.forEach((file, i) => (require.cache[file] = cached[i]));
  }
  return calls;
}

test("commit: held with no run, after a red run, and after an edit to a checked path", async () => {
  const none = await checked({ run: false });
  const reason = decide(bash(none, "git commit -am x"));
  assert.match(reason, /^Krites held the commit: no passing check run\. /);
  assert.match(reason, RERUN);

  const red = await checked({ check: "process.exit(1)" });
  assert.match(decide(bash(red, "git commit -am x")), /^Krites held the commit: the last check run refuted\. /);

  const edited = await checked({ change: { "a.txt": "changed\n", "b.txt": "also\n" } });
  write(edited, { "a.txt": "changed again\n" });
  assert.match(decide(bash(edited, "git commit -am x")), /^Krites held the commit: changed since the last passing check run: a\.txt\. Let the checks/);

  const deleted = await checked();
  fs.rmSync(path.join(deleted, "b.txt"));
  assert.match(decide(bash(deleted, "git commit -am x")), /^Krites held the commit: changed since the last passing check run\. Let the checks/, "a deleted path has no time to list it by");
});

test("commit: judging rewrites no index, and a submodule's own dirty tree holds nothing", async () => {
  const source = makeRepo({ files: { "s.txt": "s\n" } });
  const repo = makeRepo({ files: { "a.txt": "a\n", "b.txt": "b\n" } });
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
  configure(repo, { commands: [script("process.exit(0)")] });
  seed(repo);
  write(repo, { "a.txt": "changed\n" });
  await runHook(GATE, stop(repo), { cwd: repo });
  write(path.join(repo, "sub"), { "s.txt": "dirty\n", "u.txt": "new\n" });
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(path.join(repo, "b.txt"), later, later);
  const index = () => fs.readFileSync(path.join(repo, ".git", "index"));
  const before = index();
  assert.match(decide(bash(repo, "git commit -m x")), /would leave out: a\.txt\. /);
  assert.strictEqual(decide(bash(repo, "git commit -am x")), null);
  assert.deepStrictEqual(index(), before);
});

test("commit: a passing run on an unborn HEAD lets the first commit through, and harness worktrees are not left out", async () => {
  const fresh = makeRepo({ files: { "krites.toml": toml({ commands: [script("process.exit(0)")] }), "a.txt": "a\n" }, commit: false });
  seed(fresh);
  await runHook(GATE, stop(fresh), { cwd: fresh });
  git(fresh, "add", "-A");
  assert.strictEqual(decide(bash(fresh, "git commit -m x")), null);

  const repo = await checked();
  git(repo, "add", "-A");
  fs.mkdirSync(path.join(repo, ".claude", "worktrees", "x"), { recursive: true });
  write(repo, { ".claude/worktrees/x/a.txt": "elsewhere\n" });
  assert.strictEqual(decide(bash(repo, "git commit -m x")), null);
});

test("commit: a git that cannot read the root holds the commit and sends it to the user", async () => {
  const repo = await checked();
  git(repo, "add", "-A");
  fs.writeFileSync(path.join(repo, ".git", "index"), "not an index");
  assert.strictEqual(decide(bash(repo, "git commit -m x")), "Krites held the commit: git could not list what changed in this root, so nothing can be judged. Tell the user.");
});

test("commit: held for what it would leave out, and allowed for the whole checked change", async () => {
  const repo = await checked({ change: { "a.txt": "changed\n", "new.txt": "new\n" } });
  git(repo, "add", "a.txt");
  const reason = decide(bash(repo, "git commit -m x"));
  assert.match(reason, /^Krites held the commit: the commit would leave out: new\.txt\. Run git add in a call of its own, then git commit\. /);
  assert.doesNotMatch(reason, RERUN, "the checks already passed on it, so the advice is to stage, not to run them again");
  assert.match(decide(bash(repo, "git commit -am x")), /would leave out: new\.txt/, "-a stages no untracked file");
  assert.match(decide(bash(repo, "git add -A && git commit -m x")), /would leave out: new\.txt/, "the index is read before the line runs");

  const unstaged = await checked();
  assert.match(decide(bash(unstaged, "git commit -m x")), /would leave out: a\.txt\./);
  assert.strictEqual(decide(bash(unstaged, "git commit -am x")), null, "-a carries the unstaged tracked change");
  assert.strictEqual(decide(powershell(unstaged, "git commit -a -m x")), null);
  git(unstaged, "add", "-A");
  assert.strictEqual(decide(bash(unstaged, "git commit -m x")), null);
  assert.strictEqual(decide(bash(unstaged, "git commit -m \"$(cat <<'EOF'\nfix: \"a\" then git push\nEOF\n)\"")), null);
  write(unstaged, { "a.txt": "edited after staging\n" });
  assert.match(decide(bash(unstaged, "git commit -am x")), /changed since the last passing check run: a\.txt\./);

  const many = await checked({ change: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`n${String(i).padStart(2, "0")}.txt`, "n\n"])) });
  const listed = decide(bash(many, "git commit -am x"));
  assert.match(listed, /leave out: n00\.txt, .*n19\.txt, and 5 more\. /);
  assert.doesNotMatch(listed, /n20\.txt/);
});

test("commit: a commit that names paths is held before anything else", async () => {
  const repo = await checked();
  git(repo, "add", "-A");
  for (const command of ["git commit -m x a.txt", "git commit -m x -- a.txt", "git commit --pathspec-from-file=list -m x"]) {
    assert.strictEqual(
      decide(bash(repo, command)),
      "Krites held the commit: it names paths, and Krites judges only what is staged. Stage them with git add, then run git commit without paths.",
      command,
    );
  }
});

test("commit: a line with no git commit starts no process, and a root with no checks or no root lets a commit through", async () => {
  const repo = await checked({ run: false });
  const commands = ["git status", 'echo "git commit"', "git log --grep commit", "git commit-tree x", "# git commit", "cat > a.md <<'EOF'\ngit commit\nEOF"];
  const calls = spawnsOf((fresh) => {
    for (const command of commands) assert.strictEqual(fresh(bash(repo, command)), null, command);
    assert.strictEqual(fresh(powershell(repo, "$x = @'\ngit commit\n'@; Get-ChildItem")), null);
    assert.strictEqual(fresh({ tool_name: "Bash", cwd: repo, tool_input: { command: 42 } }), null);
    assert.strictEqual(fresh(null), null);
  });
  assert.deepStrictEqual(calls, []);

  const quiet = makeRepo({ files: { "krites.toml": toml({ commands: [] }), "a.txt": "a\n" } });
  write(quiet, { "a.txt": "changed\n" });
  assert.deepStrictEqual(spawnsOf((fresh) => assert.strictEqual(fresh(bash(quiet, "git commit -am x")), null)), [], "no checks, no git");
  assert.deepStrictEqual(spawnsOf((fresh) => assert.strictEqual(fresh(bash(makeDir(), "git commit -am x")), null)), [], "no repo, no git");
  const unrooted = makeRepo({ files: { "a.txt": "a\n" } });
  const asked = spawnsOf((fresh) => assert.strictEqual(fresh(bash(unrooted, "git commit -am x")), null, "no root"));
  assert.deepStrictEqual(asked.map(([, args]) => args.join(" ")), ["cat-file -e HEAD:krites.toml"], "one question per repo the walk meets");

  const broken = makeRepo({ files: { "a.txt": "a\n" } });
  configure(broken, "version = 1\n\n[checks]\nnope = 1\n");
  assert.match(decide(bash(broken, "git commit -am x")), /^Krites held the commit: krites\.toml line 4: /);
});

test("commit: a recorded head that is not an object name is no passing run, and reaches no git argument", async () => {
  const repo = await checked();
  git(repo, "add", "-A");
  const file = path.join(repo, ".krites", "last-run.json");
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(decide(bash(repo, "git commit -m x")), null);
  fs.writeFileSync(file, JSON.stringify({ ...run, head: "--output=written.txt" }));
  assert.match(decide(bash(repo, "git commit -m x")), /no passing check run/);
  assert.ok(!fs.existsSync(path.join(repo, "written.txt")));
  fs.writeFileSync(file, JSON.stringify({ ...run, head: "1".repeat(40) }));
  assert.match(decide(bash(repo, "git commit -m x")), /^Krites held the commit: no passing check run\. Let the checks/, "a head this repo no longer has");
  fs.writeFileSync(file, JSON.stringify({ ...run, config_hash: "0".repeat(64) }));
  assert.match(decide(bash(repo, "git commit -m x")), /no passing check run/, "a pass under another krites.toml");
  const { content, ...older } = run;
  assert.match(content, /^[0-9a-f]{64}$/);
  fs.writeFileSync(file, JSON.stringify(older));
  assert.match(decide(bash(repo, "git commit -m x")), /no passing check run/, "a pass recorded with no content");
});

test("commit: the directory a commit runs in picks its root", async () => {
  const repo = await checked({ run: false });
  const plain = makeDir();
  const held = /no passing check run/;
  assert.match(decide(bash(plain, `cd '${repo}' && git commit -am x`)), held);
  assert.match(decide(bash(plain, `git -C '${repo}' commit -am x`)), held);
  assert.match(decide(powershell(plain, `Set-Location '${repo}'; git commit -am x`)), held);
  assert.strictEqual(decide(bash(repo, `cd '${plain}' && git commit -am x`)), null, "a commit outside every root");
  assert.match(decide(bash(repo, "cd $HOME && git commit -am x")), /^Krites held the commit: it cannot tell which directory the commit runs in\. Name the directory without variables\.$/);
  assert.match(decide(powershell(repo, "Set-Location $env:USERPROFILE; git commit -am x")), /cannot tell which directory/);
  assert.strictEqual(decide(bash(plain, "cd $HOME && git commit -am x")), null, "outside a root with checks, an unknown directory is let through");
  if (WINDOWS) {
    const msys = `/${repo[0].toLowerCase()}${repo.slice(2).replace(/\\/g, "/")}`;
    assert.match(decide(bash(plain, `cd '${msys}' && git commit -am x`)), held, "Git Bash's /d/... form");
    assert.strictEqual(decide(powershell(plain, `Set-Location '${msys}'; git commit -am x`)), null, "PowerShell reads /d/... on the current drive");
    assert.match(decide(bash(repo, `cd '${msys}' && git commit -am x`)), RERUN, "a lowercase drive letter is still the cwd's own root");
    const across = decide(bash(/^z/i.test(repo) ? "Y:\\" : "Z:\\", `git -C '${repo}' commit -am x`));
    assert.match(across, new RegExp(`\\(run node ".+cli\\.js" verify from inside ${path.basename(repo)} with`));
    assert.ok(!across.includes(repo), "a root on another drive is named, not spelled out");
  }

  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = repo;
  try {
    assert.match(decide(bash(plain, "cd ~ && git commit -am x")), held);
    assert.match(decide(bash(plain, "cd && git commit -am x")), held, "a bare cd goes home");
    assert.match(decide(powershell(plain, "Set-Location ~/.; git commit -am x")), held);
  } finally {
    for (const [name, value] of Object.entries(home)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("commit: a nested root with its own passing run judges its own content only", async () => {
  const outer = makeRepo({ files: { "a.txt": "a\n", ".gitignore": "target/\n" } });
  configure(outer, { commands: [script("process.exit(1)")] });
  seed(outer);
  const nested = path.join(outer, "target", "wt", "x");
  fs.mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q");
  write(nested, { "a.txt": "a\n" });
  git(nested, "add", "a.txt");
  configure(nested, { commands: [script("process.exit(0)")] });
  seed(nested);
  write(nested, { "a.txt": "changed\n" });
  assert.match(decide(bash(outer, "cd target/wt/x && git commit -am x")), /\(run cd "target\/wt\/x" && node ".+cli\.js" verify with the tool's timeout at 600000\)/);
  assert.match(decide(powershell(outer, "Set-Location target/wt/x; git commit -am x")), /\(run cd "target\/wt\/x"; node ".+cli\.js" verify/, "PowerShell 5.1 has no &&");
  assert.match(decide(bash(nested, "git commit -am x")), RERUN, "from inside it, the stop and a plain verify reach it");
  await runCli(["verify"], { cwd: nested });
  write(outer, { "a.txt": "changed\n" });
  for (const payload of [bash(nested, "git commit -am x"), bash(outer, "cd target/wt/x && git commit -am x"), bash(outer, "git -C target/wt/x commit -am x")]) {
    assert.strictEqual(decide(payload), null, payload.tool_input.command);
  }
  assert.match(decide(bash(outer, "git commit -am x")), /no passing check run/);
});

test("commit: a root inside a larger repo is held only for its own paths", async () => {
  const repo = makeRepo({ files: { "top.txt": "t\n", "root/a.txt": "a\n", "root/krites.toml": toml({ commands: [script("process.exit(0)")] }) } });
  const root = path.join(repo, "root");
  seed(root, repo);
  write(root, { "a.txt": "changed\n" });
  await runHook(GATE, stop(root), { cwd: root });
  write(repo, { "top.txt": "changed above\n", "loose.txt": "loose\n" });
  assert.strictEqual(decide(bash(root, "git commit -am x")), null);
  git(repo, "add", "root/a.txt");
  assert.strictEqual(decide(bash(root, "git commit -m x")), null, "what is unstaged or untracked above the root is not its to judge");
  git(repo, "reset", "-q");
  assert.strictEqual(
    decide(bash(root, "git commit -m x")),
    "Krites held the commit: the commit would leave out: a.txt. Run git add in a call of its own, then git commit. A file that does not belong in the commit is removed or ignored, and the checks run again.",
    "named from the root, as the gate names them",
  );
});

test("commit: the hook denies through PreToolUse JSON for Bash and PowerShell, and lets a bad payload through", async () => {
  const repo = await checked({ run: false });
  for (const payload of [bash(repo, "git commit -am x"), powershell(repo, "git commit -am x")]) {
    const result = await runHook(COMMIT, payload, { cwd: repo });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, "");
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.deepStrictEqual([out.hookEventName, out.permissionDecision], ["PreToolUse", "deny"]);
    assert.match(out.permissionDecisionReason, /no passing check run/);
  }
  assert.deepStrictEqual(await runHook(COMMIT, "{not json", { cwd: repo }), SILENT);
  assert.deepStrictEqual(await runHook(COMMIT, bash(repo, "git status"), { cwd: repo }), SILENT);
});
