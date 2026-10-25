const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const config = require("../lib/config.js");
const state = require("../lib/state.js");
const { assertBlock, configure, git, head, makeDir, makeRepo, runCli, runHook, tmp } = require("./helpers.js");

const COMMIT = path.join(__dirname, "..", "hooks", "commit.js");
const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const PROTECT = path.join(__dirname, "..", "hooks", "protect.js");
const SESSION = path.join(__dirname, "..", "hooks", "session.js");
const SILENT = { code: 0, stdout: "", stderr: "" };
const WINDOWS = process.platform === "win32";

const LINE = (command) => `Krites found no krites.toml, so the stop gate runs "${command}". Run /krites:init to customize.`;
const NOT_ON_PATH = (command, program) =>
  `Krites found no krites.toml and would run "${command}" at each stop, but ${program} is not on PATH, so nothing is checked. Run /krites:init to set the command.`;
const NUDGE = "Krites is installed but this repo has no krites.toml, so nothing is being checked. Run /krites:init to create one.";
const GAVE_UP = "in the last session the Krites stop gate gave up after 3 blocked attempts, so that work ended without passing its checks. Run /krites:verify.";
const GUESS = "Krites guessed this command because the repo has no krites.toml; a person can change it with /krites:init.";
const STUB = 'echo "Error: no test specified" && exit 1';

const start = (cwd, source = "startup") => ({ hook_event_name: "SessionStart", source, session_id: "s1", cwd });
const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });
const edit = (file, cwd) => ({ hook_event_name: "PreToolUse", tool_name: "Write", session_id: "s1", cwd, tool_input: { file_path: file, content: "x" } });
const krites = (repo, name) => path.join(repo, ".krites", name);
const has = (repo, name) => fs.existsSync(krites(repo, name));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const lastRun = (repo) => readJson(krites(repo, "last-run.json"));

function message(result) {
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  const out = JSON.parse(result.stdout);
  assert.deepStrictEqual(Object.keys(out), ["systemMessage"]);
  return out.systemMessage;
}

function assertDeny(result, pattern) {
  assert.strictEqual(result.code, 0);
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  assert.strictEqual(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, pattern);
}

let marks = 0;

// npm runs t.js, which leaves a mark outside the repo, so a test can tell a skipped stop from one that ran the command.
function zeroRepo({ exit = 0, test: script = "node t.js", files = {} } = {}) {
  const mark = path.join(tmp, `ran${++marks}.txt`);
  const repo = makeRepo({
    files: {
      "package.json": JSON.stringify({ name: "zero", version: "1.0.0", scripts: { test: script } }),
      "t.js": `require("fs").appendFileSync(${JSON.stringify(mark)}, "ran\\n");\nconsole.log("zero suite says ${exit === 0 ? "fine" : "broken"}");\nprocess.exit(${exit});\n`,
      "a.txt": "a\n",
      ...files,
    },
  });
  return { repo, ran: () => (fs.existsSync(mark) ? fs.readFileSync(mark, "utf8").split("\n").filter(Boolean).length : 0) };
}

const change = (repo, text = "changed\n") => fs.writeFileSync(path.join(repo, "a.txt"), text);

async function started(repo, options = {}) {
  return message(await runHook(SESSION, start(repo), { cwd: repo, ...options }));
}

test("zero-config: a fresh startup names the guessed test command and records it, writing no session-head or config-hash", async () => {
  const { repo, ran } = zeroRepo();
  assert.strictEqual(await started(repo), LINE("npm test"));
  const record = readJson(krites(repo, "zero.json"));
  assert.deepStrictEqual(record, { head: head(repo), command: ["npm", "test"], fingerprint: state.fingerprint(repo), session: "s1" });
  assert.strictEqual(has(repo, "session-head"), false, "a session-head would make the repo look gated before");
  assert.strictEqual(has(repo, "config-hash"), false);
  assert.strictEqual(ran(), 0, "the startup runs nothing");
});

test("zero-config: a stop after a change that fails the command blocks with its output and says the command is a guess", async () => {
  const { repo, ran } = zeroRepo({ exit: 1 });
  await started(repo);
  change(repo);
  const reason = assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /^Krites refuted the stop: npm test\n/);
  assert.match(reason, /zero suite says broken/);
  assert.ok(reason.endsWith(`\n${GUESS}`), reason);
  assert.strictEqual(ran(), 1);
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "refuted");
  assert.deepStrictEqual(run.commands, [["npm", "test"]]);
  assert.strictEqual("config_hash" in run, false);
  assert.strictEqual(state.readBlockCount(repo), 1);
});

test("zero-config: a passing stop moves the record to the new HEAD and still writes no session-head", async () => {
  const { repo, ran } = zeroRepo();
  await started(repo);
  change(repo);
  git(repo, "commit", "-q", "-am", "work");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(ran(), 1);
  const record = readJson(krites(repo, "zero.json"));
  assert.strictEqual(record.head, head(repo));
  assert.strictEqual(record.fingerprint, state.fingerprint(repo));
  assert.strictEqual(has(repo, "session-head"), false);
  assert.strictEqual(has(repo, "config-hash"), false);
  assert.strictEqual(state.readBlockCount(repo), 0);
  assert.strictEqual(lastRun(repo).verdict, "passed");
  assert.deepStrictEqual(await runHook(PROTECT, edit(path.join(repo, "a.txt"), repo), { cwd: repo }), SILENT, "edits still go through");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(ran(), 1, "a clean tree at the recorded head skips");
});

test("zero-config: a tree left as it was at startup, dirty or clean, is not checked", async () => {
  const clean = zeroRepo({ exit: 1 });
  await started(clean.repo);
  assert.deepStrictEqual(await runHook(GATE, stop(clean.repo), { cwd: clean.repo }), SILENT);
  assert.strictEqual(clean.ran(), 0);

  const dirty = zeroRepo({ exit: 1 });
  change(dirty.repo, "work in progress\n");
  await started(dirty.repo);
  assert.deepStrictEqual(await runHook(GATE, stop(dirty.repo), { cwd: dirty.repo }), SILENT, "a question-only turn");
  assert.strictEqual(dirty.ran(), 0);
  change(dirty.repo, "the agent's change\n");
  assertBlock(await runHook(GATE, stop(dirty.repo), { cwd: dirty.repo }), /npm test/);
  assert.strictEqual(dirty.ran(), 1);
  change(dirty.repo, "work in progress\n");
  assert.deepStrictEqual(await runHook(GATE, stop(dirty.repo), { cwd: dirty.repo }), SILENT, "a revert to the startup tree");
  assert.strictEqual(state.readBlockCount(dirty.repo), 0, "and the attempts go back");
});

test("zero-config: a second session start leaves the first session's work to be checked", async () => {
  const { repo, ran } = zeroRepo({ exit: 1 });
  await started(repo);
  change(repo);
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /npm test/);
  const second = { ...start(repo), session_id: "s2" };
  assert.strictEqual(message(await runHook(SESSION, second, { cwd: repo })), LINE("npm test"));
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /npm test/, "the tree is still the first session's work");
  assert.deepStrictEqual(await runHook(GATE, { ...stop(repo), session_id: "s2" }, { cwd: repo }), SILENT, "the second session found it this way");
  assert.strictEqual(ran(), 2);
});

test("zero-config: a tree that passed is not run again, from any session", async () => {
  const { repo, ran } = zeroRepo();
  await started(repo);
  change(repo);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.deepStrictEqual(await runHook(GATE, { ...stop(repo), session_id: "s2" }, { cwd: repo }), SILENT);
  assert.strictEqual(ran(), 1);
  assert.strictEqual(readJson(krites(repo, "zero.json")).session, null);
});

test("zero-config: a repo with no commit yet records no head and still checks a change", async () => {
  const mark = path.join(tmp, `ran${++marks}.txt`);
  const repo = makeRepo({
    commit: false,
    files: {
      "package.json": JSON.stringify({ scripts: { test: "node t.js" } }),
      "t.js": `require("fs").appendFileSync(${JSON.stringify(mark)}, "ran\\n");\nprocess.exit(1);\n`,
      "a.txt": "a\n",
    },
  });
  assert.strictEqual(await started(repo), LINE("npm test"));
  assert.strictEqual(readJson(krites(repo, "zero.json")).head, null);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  change(repo);
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /npm test/);
  assert.strictEqual(fs.existsSync(mark), true);
});

test("zero-config: in a repo with no commit at startup, a committed krites.toml is still refuted", async () => {
  const repo = makeRepo({ commit: false, files: { "package.json": JSON.stringify({ scripts: { test: "node -e process.exit(1)" } }), "a.txt": "a\n" } });
  await started(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "work");
  configure(repo, "version = 1\n\n[checks]\ncommands = []\n");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: krites\.toml/);
});

// npm can share git's folder, so git gets a folder of its own; Git for Windows' launcher finds its install
// from where it sits, so there its folder is kept.
function gitAlone() {
  const where = spawnSync(WINDOWS ? "where" : "which", ["git"], { encoding: "utf8", windowsHide: true });
  const git = where.stdout.split(/\r?\n/)[0].trim();
  assert.ok(git, "git is on PATH");
  if (WINDOWS) return path.dirname(git);
  const dir = makeDir();
  fs.symlinkSync(git, path.join(dir, "git"));
  return dir;
}

test("zero-config: a session start without the program on PATH leaves another session's record and gate alone", async (t) => {
  const gitDir = gitAlone();
  if (["npm", "npm.cmd", "npm.exe"].some((name) => fs.existsSync(path.join(gitDir, name)))) return t.skip(`npm sits beside git in ${gitDir}`);
  const { repo, ran } = zeroRepo({ exit: 1 });
  await started(repo);
  const before = fs.readFileSync(krites(repo, "zero.json"), "utf8");
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") || "PATH";
  const bare = { [key]: gitDir };
  assert.strictEqual(message(await runHook(SESSION, { ...start(repo), session_id: "s2" }, { cwd: repo, env: bare })), NOT_ON_PATH("npm test", "npm"));
  assert.strictEqual(fs.readFileSync(krites(repo, "zero.json"), "utf8"), before);
  change(repo);
  assert.deepStrictEqual(await runHook(GATE, { ...stop(repo), session_id: "s2" }, { cwd: repo, env: bare }), SILENT, "nothing is checked where npm is missing");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /npm test/);
  assert.strictEqual(ran(), 1);
});

test("zero-config: a /clear hands the startup tree to the session it starts", async () => {
  const { repo, ran } = zeroRepo({ exit: 1 });
  change(repo, "work in progress\n");
  await started(repo);
  assert.deepStrictEqual(await runHook(SESSION, { ...start(repo, "clear"), session_id: "s3" }, { cwd: repo }), SILENT);
  assert.strictEqual(readJson(krites(repo, "zero.json")).session, "s3");
  assert.deepStrictEqual(await runHook(GATE, { ...stop(repo), session_id: "s3" }, { cwd: repo }), SILENT);
  assert.strictEqual(ran(), 0);
});

test("zero-config: a startup with no session id records no startup tree to skip", async () => {
  const { repo, ran } = zeroRepo({ exit: 1 });
  change(repo, "work in progress\n");
  const anonymous = start(repo);
  delete anonymous.session_id;
  assert.strictEqual(message(await runHook(SESSION, anonymous, { cwd: repo })), LINE("npm test"));
  assert.deepStrictEqual(readJson(krites(repo, "zero.json")).fingerprint, null);
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /npm test/);
  assert.strictEqual(ran(), 1);
});

test("zero-config: a Cargo repo's line names cargo test", async (t) => {
  if (!config.onPath("cargo")) return t.skip("cargo is not on PATH");
  const repo = makeRepo({ files: { "Cargo.toml": "[package]\nname = \"zero\"\n", "src/lib.rs": "" } });
  assert.strictEqual(await started(repo), LINE("cargo test"));
  assert.deepStrictEqual(readJson(krites(repo, "zero.json")).command, ["cargo", "test"]);
});

test("zero-config: the budget is three blocks, and the next startup reports the chain that gave up", async () => {
  const { repo } = zeroRepo({ exit: 1 });
  await started(repo);
  change(repo);
  for (let attempt = 1; attempt <= 3; attempt += 1) assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /npm test/);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(lastRun(repo).reason, "attempt budget exhausted");
  assert.strictEqual(await started(repo), `${GAVE_UP}\n${LINE("npm test")}`);
  assert.strictEqual(state.readBlockCount(repo), 0);
});

test("zero-config: a /clear reports a spent budget and resets it, and keeps the record", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  const before = fs.readFileSync(krites(repo, "zero.json"), "utf8");
  state.writeBlockCount(repo, 4);
  assert.strictEqual(message(await runHook(SESSION, start(repo, "clear"), { cwd: repo })), GAVE_UP);
  assert.strictEqual(state.readBlockCount(repo), 0);
  assert.strictEqual(fs.readFileSync(krites(repo, "zero.json"), "utf8"), before);
  assert.deepStrictEqual(await runHook(SESSION, start(repo, "clear"), { cwd: repo }), SILENT);
});

test("zero-config: a krites.toml the agent commits mid-session is refuted against the recorded head", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  configure(repo, "version = 1\n\n[checks]\ncommands = []\n");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: krites\.toml/);
  assert.strictEqual(has(repo, "config-hash"), false, "the agent's config is never recorded as accepted");
});

test("zero-config: a krites.toml a person writes with /krites:init-write mid-session is accepted at the next stop", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  const written = await runCli(["init", "--write"], { cwd: repo });
  assert.match(written.stdout, /krites\.toml is written and the gate accepts it/);
  change(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "config and work");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  const run = lastRun(repo);
  assert.strictEqual(run.verdict, "passed");
  assert.deepStrictEqual(run.diff.files.sort(), ["a.txt", "krites.toml"], "judged from the head zero-config recorded, not from HEAD");
});

test("zero-config: the agent's git commit is not held, as the README says, even after a refuted stop", async () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.ok(readme.includes("- The agent's `git commit` is not held until there is a `krites.toml`."), "the no-setup list says so");
  assert.ok(readme.includes("through the Bash or PowerShell tool in a repo whose `krites.toml` has checks,"), "the Commit bullet says so");
  const { repo } = zeroRepo({ exit: 1 });
  await started(repo);
  change(repo);
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /^Krites refuted the stop: npm test\n/);
  const commit = { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1", cwd: repo, tool_input: { command: "git commit -am x" } };
  assert.deepStrictEqual(await runHook(COMMIT, commit, { cwd: repo }), SILENT);
  configure(repo, { commands: [["npm", "test"]] });
  assertDeny(await runHook(COMMIT, commit, { cwd: repo }), /^Krites held the commit: /);
});

test("zero-config: the edit tools cannot touch krites.toml, .krites, .git or the settings that turn hooks off, and everything else stays open", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  const rels = [".krites/zero.json", ".krites/block-count", "krites.toml", ".git/config", "sub/krites.toml", ".claude/settings.json", ".claude/settings.local.json", "sub/.claude/settings.json"];
  for (const rel of rels) assertDeny(await runHook(PROTECT, edit(path.join(repo, rel), repo), { cwd: repo }), /is protected/);
  assertDeny(await runHook(PROTECT, edit(".krites/zero.json", repo), { cwd: repo }), /is protected/);
  fs.mkdirSync(path.join(repo, "src"));
  assertDeny(await runHook(PROTECT, edit(path.join("..", ".krites", "zero.json"), path.join(repo, "src")), { cwd: repo }), /is protected/);
  if (WINDOWS) {
    assertDeny(await runHook(PROTECT, edit(path.join(repo, ".krites.", "zero.json"), repo), { cwd: repo }), /is protected/);
    assertDeny(await runHook(PROTECT, edit(path.join(repo, "krites.toml::$DATA"), repo), { cwd: repo }), /alternate data stream/);
  }
  const own = [path.join(os.homedir(), ".claude", "settings.json"), path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), path.join(process.env.KRITES_CONFIG_DIR, "config.toml")];
  for (const file of own) assertDeny(await runHook(PROTECT, edit(file, repo), { cwd: repo }), /own configuration/);
  assertDeny(await runHook(PROTECT, edit("\\\\localhost\\share\\krites.toml", repo), { cwd: repo }), /network or device path/);
  for (const file of [path.join(repo, "a.txt"), path.join(repo, "src", "new.js"), path.join(tmp, "outside.txt")]) {
    assert.deepStrictEqual(await runHook(PROTECT, edit(file, repo), { cwd: repo }), SILENT, file);
  }
  const project = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "zero");
  const memory = { ...edit(path.join(project, "memory", "note.md"), repo), transcript_path: path.join(project, "s1.jsonl") };
  assert.deepStrictEqual(await runHook(PROTECT, memory, { cwd: repo }), SILENT, "this project's memory folder stays open");
  if (WINDOWS) {
    for (const prefix of ["\\\\?\\", "\\\\.\\", "//?/"]) {
      assertDeny(await runHook(PROTECT, edit(`${prefix}${path.join(repo, "krites.toml")}`, repo), { cwd: repo }), /is protected/, prefix);
    }
    assert.deepStrictEqual(await runHook(PROTECT, edit(`\\\\?\\${path.join(tmp, "outside.txt")}`, repo), { cwd: repo }), SILENT);
    const shares = ["\\\\?\\GLOBALROOT\\Device\\Mup\\localhost\\c$\\x", "\\\\.\\GLOBALROOT\\Device\\Mup\\localhost\\c$\\x", "\\\\?\\UNC\\localhost\\c$\\x", "\\\\.\\UNC\\localhost\\c$\\x"];
    for (const file of shares) assertDeny(await runHook(PROTECT, edit(file, repo), { cwd: repo }), /network or device path/, file);
  }
});

test("zero-config: a git that will not run hides neither the record nor a change", async () => {
  const bad = path.join(makeDir({ "gitconfig": "[broken\n" }), "gitconfig");
  const env = { GIT_CONFIG_GLOBAL: bad };
  const { repo, ran } = zeroRepo();
  await started(repo);
  assert.notStrictEqual(spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, env: { ...process.env, ...env } }).status, 0, "git refuses to run");
  assertDeny(await runHook(PROTECT, edit(path.join(repo, ".krites", "zero.json"), repo), { cwd: repo, env }), /is protected/);
  change(repo);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT);
  assert.strictEqual(readJson(krites(repo, "zero.json")).fingerprint, null, "a tree git cannot list is no tree to skip");
  change(repo, "changed again\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT);
  assert.strictEqual(ran(), 2);
});

test("zero-config: the gate and protect find the repo the session start recorded, as git finds it", async () => {
  const { repo, ran } = zeroRepo({ exit: 1, files: { "sub/b.txt": "b\n" } });
  const sub = path.join(repo, "sub");
  const link = path.join(makeDir(), "link");
  fs.symlinkSync(sub, link, WINDOWS ? "junction" : "dir");
  const env = { CLAUDE_PROJECT_DIR: link };
  assert.strictEqual(message(await runHook(SESSION, start(link), { cwd: link, env })), LINE("npm test"));
  assert.strictEqual(has(repo, "zero.json"), true);
  fs.mkdirSync(path.join(sub, ".krites"));
  fs.writeFileSync(path.join(sub, ".krites", "zero.json"), fs.readFileSync(krites(repo, "zero.json")));
  for (const project of [link, sub]) {
    const at = { CLAUDE_PROJECT_DIR: project };
    assertDeny(await runHook(PROTECT, edit(path.join(repo, ".krites", "zero.json"), project), { cwd: project, env: at }), /is protected/, project);
  }
  change(repo);
  assertBlock(await runHook(GATE, stop(link), { cwd: link, env }), /npm test/);
  assert.strictEqual(ran(), 1);
  const stub = path.join(repo, "stub");
  fs.mkdirSync(path.join(stub, ".git"), { recursive: true });
  const below = { CLAUDE_PROJECT_DIR: stub };
  assertDeny(await runHook(PROTECT, edit(path.join(repo, ".krites", "zero.json"), stub), { cwd: stub, env: below }), /is protected/, "an empty .git is no repo to git");
});

test("zero-config: a folder git has left is not gated by the record it left behind", async () => {
  const { repo, ran } = zeroRepo({ exit: 1, files: { "x/c.txt": "c\n" } });
  await started(repo);
  fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
  const inner = path.join(repo, "x");
  const env = { CLAUDE_PROJECT_DIR: inner };
  change(repo);
  assert.deepStrictEqual(await runHook(GATE, stop(inner), { cwd: inner, env }), SILENT);
  assert.deepStrictEqual(await runHook(PROTECT, edit(path.join(repo, "krites.toml"), inner), { cwd: inner, env }), SILENT);
  assert.strictEqual(ran(), 0);
});

test("zero-config: a start that cannot reach a newly detected program drops a record that names another command", async (t) => {
  const where = spawnSync(WINDOWS ? "where" : "which", ["git"], { encoding: "utf8", windowsHide: true });
  const reach = [path.dirname(where.stdout.split(/\r?\n/)[0].trim()), path.dirname(process.execPath)].join(path.delimiter);
  if (config.onPath("cargo", { PATH: reach, PATHEXT: process.env.PATHEXT }) || !config.onPath("npm", { PATH: reach, PATHEXT: process.env.PATHEXT })) {
    return t.skip("needs npm beside node and no cargo there");
  }
  const { repo } = zeroRepo();
  await started(repo);
  fs.writeFileSync(path.join(repo, "Cargo.toml"), "[package]\nname = \"zero\"\n");
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") || "PATH";
  const second = { ...start(repo), session_id: "s2" };
  assert.strictEqual(message(await runHook(SESSION, second, { cwd: repo, env: { [key]: reach } })), NOT_ON_PATH("cargo test", "cargo"));
  assert.strictEqual(has(repo, "zero.json"), false);
});

test("zero-config: the project dir decides the repo, so a cd into a nested repo does not escape the gate", async () => {
  const { repo, ran } = zeroRepo({ exit: 1 });
  const nested = path.join(repo, "nested");
  fs.mkdirSync(nested);
  git(nested, "init", "-q");
  const env = { CLAUDE_PROJECT_DIR: repo };
  assert.strictEqual(message(await runHook(SESSION, start(nested), { cwd: nested, env })), LINE("npm test"));
  change(repo);
  assertBlock(await runHook(GATE, stop(nested), { cwd: nested, env }), /npm test/);
  assert.strictEqual(ran(), 1);
});

test("zero-config: a hook that fails to read its payload spends from the budget, so it cannot block without end", async () => {
  const { repo } = zeroRepo({ exit: 1 });
  await started(repo);
  const env = { CLAUDE_PROJECT_DIR: repo };
  for (let attempt = 1; attempt <= 3; attempt += 1) assertBlock(await runHook(GATE, "{not json", { env }), /payload|hook/);
  assert.deepStrictEqual(await runHook(GATE, "{not json", { env }), SILENT);
});

test("zero-config: a program missing from PATH is named, and nothing is recorded or checked", async (t) => {
  const where = spawnSync(WINDOWS ? "where" : "which", ["git"], { encoding: "utf8", windowsHide: true });
  const gitDir = path.dirname(where.stdout.split(/\r?\n/)[0].trim());
  if (config.onPath("pytest", { PATH: gitDir, PATHEXT: process.env.PATHEXT })) return t.skip("pytest sits beside git");
  const repo = makeRepo({ files: { "pyproject.toml": "[project]\nname = 'zero'\n", "a.py": "a = 1\n" } });
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") || "PATH";
  const env = { [key]: gitDir };
  assert.strictEqual(await started(repo, { env }), NOT_ON_PATH("pytest", "pytest"));
  assert.strictEqual(has(repo, "zero.json"), false);
  fs.writeFileSync(path.join(repo, "a.py"), "a = 2\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT);
});

test("zero-config: KRITES_ZERO_CONFIG=off keeps today's nudge and writes nothing", async () => {
  for (const value of ["off", "OFF"]) {
    const { repo, ran } = zeroRepo({ exit: 1 });
    const env = { KRITES_ZERO_CONFIG: value };
    assert.strictEqual(await started(repo, { env }), NUDGE);
    change(repo);
    assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT);
    assert.deepStrictEqual(await runHook(PROTECT, edit(path.join(repo, "krites.toml"), repo), { cwd: repo, env }), SILENT);
    assert.strictEqual(fs.existsSync(path.join(repo, ".krites")), false);
    assert.strictEqual(ran(), 0);
  }
});

test("zero-config: a repo whose top level is the home folder is not gated", async () => {
  const { repo } = zeroRepo({ exit: 1 });
  const env = { HOME: repo, USERPROFILE: repo };
  assert.strictEqual(await started(repo, { env }), NUDGE);
  assert.strictEqual(fs.existsSync(path.join(repo, ".krites")), false);
});

test("zero-config: a startup that finds no test command drops a stale record and nudges", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "zero", scripts: { lint: "eslint ." } }));
  assert.strictEqual(await started(repo), NUDGE);
  assert.strictEqual(has(repo, "zero.json"), false);
  change(repo);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
});

test("zero-config: a record whose command is not one Krites would guess is ignored", async () => {
  const { repo, ran } = zeroRepo({ exit: 1 });
  await started(repo);
  const record = readJson(krites(repo, "zero.json"));
  change(repo);
  for (const command of [["node", "-e", "0"], ["npm test"]]) {
    fs.writeFileSync(krites(repo, "zero.json"), JSON.stringify({ ...record, command }));
    assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT, JSON.stringify(command));
  }
  assert.strictEqual(ran(), 0);
  assert.strictEqual(has(repo, "last-run.json"), false);
});

test("readZero: a record with a bad head, command, fingerprint or session is no record", () => {
  const repo = makeDir();
  const good = { head: "a".repeat(40), command: ["npm", "test"], fingerprint: "b".repeat(64), session: "s1" };
  state.writeZero(repo, good);
  assert.deepStrictEqual(state.readZero(repo), good);
  state.writeZero(repo, { ...good, head: "", session: undefined });
  assert.deepStrictEqual(state.readZero(repo), { ...good, head: null, session: null });
  const bad = [
    { ...good, head: "-x" },
    { ...good, head: 5 },
    { ...good, command: [] },
    { ...good, command: ["npm", ""] },
    { ...good, command: "npm test" },
    { ...good, fingerprint: "x" },
    { ...good, session: "has space" },
    [],
    "text",
  ];
  for (const value of bad) {
    fs.writeFileSync(krites(repo, "zero.json"), JSON.stringify(value));
    assert.strictEqual(state.readZero(repo), null, JSON.stringify(value));
  }
  fs.writeFileSync(krites(repo, "zero.json"), "{not json");
  assert.strictEqual(state.readZero(repo), null);
});

test("zero-config: a startup in a krites root drops the record zero-config left there", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  configure(repo, "version = 1\n\n[checks]\ncommands = []\n");
  await runHook(SESSION, start(repo), { cwd: repo });
  assert.strictEqual(has(repo, "zero.json"), false);
  assert.strictEqual(has(repo, "session-head"), true);
});

test("testCommand: the last command /krites:init would propose that runs the tests", () => {
  const cases = [
    [{ "Cargo.toml": "" }, "cargo test"],
    [{ "Cargo.toml": "", ".config/nextest.toml": "" }, "cargo nextest run"],
    [{ "pyproject.toml": "" }, "pytest"],
    [{ "pytest.ini": "" }, "pytest"],
    [{ "go.mod": "" }, "go test ./..."],
    [{ "package.json": JSON.stringify({ scripts: { lint: "x", test: "y" } }) }, "npm test"],
    [{ "package.json": JSON.stringify({ scripts: { test: "y" } }), "pnpm-lock.yaml": "" }, "pnpm test"],
    [{ "package.json": JSON.stringify({ scripts: { test: "y" } }), "yarn.lock": "" }, "yarn test"],
    [{ "package.json": JSON.stringify({ scripts: { lint: "x", typecheck: "y" } }) }, null],
    [{ "package.json": "{}", "tsconfig.json": "{}" }, null],
    [{ "package.json": "{not json" }, null],
    [{ "package.json": JSON.stringify({ scripts: { test: STUB } }) }, null],
    [{ "README.md": "" }, null],
  ];
  for (const [files, expected] of cases) assert.strictEqual(config.testCommand(makeDir(files)), expected, JSON.stringify(files));
});

test("detect: the npm init stub is no test script, for /krites:init too", () => {
  assert.deepStrictEqual(config.detect(makeDir({ "package.json": JSON.stringify({ scripts: { lint: "x", test: STUB } }) })), ["npm run lint"]);
});

test("zeroConfig: init's defaults around the one command, and pytest writes no bytecode", () => {
  const npm = config.zeroConfig(["npm", "test"]);
  assert.strictEqual(npm.ok, true);
  assert.strictEqual(npm.zero, true);
  assert.strictEqual(npm.hash, undefined);
  assert.deepStrictEqual(npm.config.checks, { commands: [["npm", "test"]], slow: [], env: {}, timeout_seconds: 600, max_blocks: 3 });
  assert.deepStrictEqual(npm.config.protect.globs, ["**/.claude/settings.json", "**/.claude/settings.local.json"]);
  assert.strictEqual(npm.config.receipts.dir, "receipts");
  assert.deepStrictEqual({ ...config.zeroConfig(["pytest"]).config.checks.env }, { PYTHONDONTWRITEBYTECODE: "1" });
});

test("onPath: a program file in a PATH folder, with PATHEXT on Windows", () => {
  const dir = makeDir({ [WINDOWS ? "tool.CMD" : "tool"]: "" });
  const env = { PATH: [path.join(tmp, "missing"), `"${dir}"`].join(path.delimiter), PATHEXT: ".EXE;.CMD" };
  assert.strictEqual(config.onPath("tool", env), true);
  assert.strictEqual(config.onPath("other", env), false);
  assert.strictEqual(config.onPath("tool", { PATH: "" }), false);
});

test("zero-config guard: a repo gated before keeps blocking, whatever test script it has", async () => {
  const { repo } = zeroRepo();
  state.writeBaseline(repo, head(repo));
  assert.match(await started(repo), /gated before/);
  assert.strictEqual(has(repo, "zero.json"), false);
  change(repo);
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /gated before/);
});

test("zero-config guard: a committed krites.toml missing from the tree keeps blocking", async () => {
  const { repo } = zeroRepo();
  configure(repo, "version = 1\n");
  fs.rmSync(path.join(repo, "krites.toml"));
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /tracked but missing/);
  assert.strictEqual(has(repo, "zero.json"), false);
});

test("zero-config guard: no marker, no test script, or no git leaves the repo as it is today", async () => {
  for (const files of [{ "src/a.rs": "a\n" }, { "package.json": JSON.stringify({ scripts: { lint: "x" } }) }]) {
    const repo = makeRepo({ files });
    assert.strictEqual(await started(repo), NUDGE);
    assert.strictEqual(fs.existsSync(path.join(repo, ".krites")), false);
  }
  const folder = makeDir({ "package.json": JSON.stringify({ scripts: { test: "node -e process.exit(1)" } }) });
  assert.deepStrictEqual(await runHook(SESSION, start(folder), { cwd: folder }), SILENT);
  assert.deepStrictEqual(await runHook(GATE, stop(folder), { cwd: folder }), SILENT);
  assert.strictEqual(fs.existsSync(path.join(folder, ".krites")), false);
});

const NO_ROOT = "This repo has no krites.toml, so Krites is checking nothing. Run /krites:init.\n";
const NOTHING_TO_APPROVE = (command) =>
  `This repo has no krites.toml, so there is nothing to approve: the stop gate runs "${command}" and judges no protected path. Nothing was written.`;

test("zero-config commands: /krites:verify runs the recorded command, and a pass moves the record, not a session-head", async () => {
  const failing = zeroRepo({ exit: 1 });
  await started(failing.repo);
  const refuted = await runCli(["verify"], { cwd: failing.repo });
  assert.strictEqual(refuted.stdout, "npm test\n" + refuted.stdout.slice("npm test\n".length));
  assert.match(refuted.stdout, /zero suite says broken/);
  assert.match(refuted.stdout, /\nexit 1\n$/);
  assert.strictEqual(failing.ran(), 1);

  const passing = zeroRepo();
  await started(passing.repo);
  change(passing.repo);
  git(passing.repo, "commit", "-q", "-am", "work");
  const passed = await runCli(["verify"], { cwd: passing.repo });
  assert.match(passed.stdout, /^npm test\n[^]*\nexit 0\n$/);
  assert.strictEqual(has(passing.repo, "session-head"), false);
  assert.strictEqual(has(passing.repo, "config-hash"), false);
  assert.strictEqual(readJson(krites(passing.repo, "zero.json")).head, head(passing.repo));
  assert.strictEqual(lastRun(passing.repo).verdict, "passed");
});

test("zero-config commands: /krites:verify judges a krites.toml the agent committed from the recorded head, as the gate does", async () => {
  const { repo, ran } = zeroRepo();
  await started(repo);
  configure(repo, "version = 1\n\n[checks]\ncommands = []\n");
  assert.match((await runCli(["verify"], { cwd: repo })).stdout, /protected path changed: krites\.toml/);
  assert.strictEqual(ran(), 0);
  assert.strictEqual(has(repo, "config-hash"), false);
});

test("zero-config commands: with no record, the commands still say nothing is checked", async () => {
  const { repo, ran } = zeroRepo({ exit: 1 });
  for (const args of [["verify"], ["receipt"], ["approve"]]) {
    assert.strictEqual((await runCli(args, { cwd: repo })).stdout, NO_ROOT, args[0]);
  }
  assert.strictEqual(ran(), 0);
});

test("zero-config commands: /krites:receipt signs a zero-config run, and its Markdown names no config", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  change(repo);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  const result = await runCli(["receipt"], { cwd: repo });
  const written = result.stdout.trimEnd().split("\n");
  assert.strictEqual(written.length, 2, result.stdout);
  const verifier = path.join(__dirname, "..", "verify-receipt.js");
  const checked = spawnSync(process.execPath, [verifier, path.join(repo, written[0])], { cwd: tmp, encoding: "utf8", windowsHide: true });
  assert.strictEqual(checked.status, 0, checked.stdout + checked.stderr);
  assert.strictEqual(readJson(path.join(repo, written[0])).config_hash, null);
  assert.match(fs.readFileSync(path.join(repo, written[1]), "utf8"), /\nConfig hash: none \(no krites\.toml\)\n/);
});

test("zero-config commands: /krites:approve in a zero-config repo has nothing to approve", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  for (const args of [["approve"], ["approve", "--write"]]) {
    assert.strictEqual((await runCli(args, { cwd: repo })).stdout, `${NOTHING_TO_APPROVE("npm test")}\n`, args.join(" "));
  }
  assert.strictEqual(has(repo, "approved-head"), false);
});

// A person writes krites.toml mid-session and commits a protected file with it; approve reads the gate's own baseline.
async function approvedAfterInit(repo) {
  assert.match((await runCli(["init", "--write"], { cwd: repo })).stdout, /krites\.toml is written and the gate accepts it/);
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "{}\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "config and settings");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: \.claude\/settings\.json/);
  const shown = await runCli(["approve"], { cwd: repo });
  assert.match(shown.stdout, /^Protected paths changed in commits since the baseline [0-9a-f]+:\n\* \.claude\/settings\.json\n/, shown.stdout);
  assert.match(shown.stdout, /config and settings/);
  assert.match((await runCli(["approve", "--write"], { cwd: repo })).stdout, /^Approved these protected changes up to [0-9a-f]+:\n\* \.claude\/settings\.json\n/);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(lastRun(repo).verdict, "passed");
}

test("zero-config commands: a person's protected commit after a mid-session /krites:init-write can be approved", async () => {
  const { repo } = zeroRepo();
  await started(repo);
  await approvedAfterInit(repo);
});

test("zero-config commands: the same holds for a session that started before the first commit", async () => {
  const repo = makeRepo({ commit: false, files: { "package.json": JSON.stringify({ scripts: { test: "node -e 0" } }), "a.txt": "a\n" } });
  await started(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  await approvedAfterInit(repo);
});
