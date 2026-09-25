const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const cli = require("../cli.js");
const { loadConfig } = require("../lib/config.js");
const { hashText, readConfigHash } = require("../lib/state.js");
const { ABSOLUTE, assertBlock, configure, makeDir, makeRepo, runCli, runHook, script, seed } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const SILENT = { code: 0, stdout: "", stderr: "" };
const GLOBS = [
  "tests/krites/**",
  "krites.toml",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks/**",
  ".claude/agents/**",
  ".claude/commands/**",
  ".claude/skills/**",
  ".mcp.json",
  ".claude/output-styles/**",
  ".claude/rules/**",
];
const CARGO = ["cargo fmt --check", "cargo clippy --all-targets -- -D warnings"];
const SCRIPTS = JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", test: "node --test" } });

const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });

function listing(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listing(full, base, out);
    else out[path.relative(base, full).replace(/\\/g, "/")] = fs.readFileSync(full, "utf8");
  }
  return out;
}

const DETECTED = [
  ["cargo with nextest", { "Cargo.toml": "[package]\n", ".config/nextest.toml": "\n" }, [...CARGO, "cargo nextest run"]],
  ["cargo without nextest", { "Cargo.toml": "[package]\n" }, [...CARGO, "cargo test"]],
  ["npm scripts", { "package.json": SCRIPTS }, ["npm run typecheck", "npm run lint", "npm test"]],
  ["pnpm scripts", { "package.json": SCRIPTS, "pnpm-lock.yaml": "\n" }, ["pnpm run typecheck", "pnpm run lint", "pnpm test"]],
  ["yarn scripts", { "package.json": SCRIPTS, "yarn.lock": "\n" }, ["yarn run typecheck", "yarn run lint", "yarn test"]],
  ["some scripts", { "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }) }, ["npm run lint"]],
  ["no scripts but a tsconfig", { "package.json": "{}\n", "tsconfig.json": "{}\n" }, ["npx tsc --noEmit"]],
  ["no scripts and no tsconfig", { "package.json": "{}\n" }, []],
  ["pyproject", { "pyproject.toml": "\n" }, ["ruff check", "pytest"]],
  ["pytest.ini", { "pytest.ini": "\n" }, ["ruff check", "pytest"]],
  ["go.mod", { "go.mod": "module x\n" }, ["go vet ./...", "go test ./..."]],
  ["cargo before package.json", { "Cargo.toml": "[package]\n", "package.json": SCRIPTS }, [...CARGO, "cargo test"]],
  ["package.json before pyproject", { "package.json": "{}\n", "pyproject.toml": "\n" }, []],
  ["pyproject before go.mod", { "pyproject.toml": "\n", "go.mod": "module x\n" }, ["ruff check", "pytest"]],
];

test("init: detection reads files only, first match wins, and every proposal loads", () => {
  for (const [label, files, commands] of DETECTED) {
    const dir = makeDir(files);
    const before = listing(dir);
    assert.deepStrictEqual(cli.detect(dir), commands, label);
    assert.deepStrictEqual(listing(dir), before, `${label}: detection writes nothing`);

    const loaded = loadConfig(makeDir({ "krites.toml": cli.proposal(commands) }));
    assert.strictEqual(loaded.ok, true, `${label}: ${loaded.error}`);
    assert.deepStrictEqual(
      loaded.config.checks.commands,
      commands.map((command) => command.split(" ")),
      label,
    );
    assert.strictEqual(loaded.config.checks.timeout_seconds, 600, label);
    assert.strictEqual(loaded.config.checks.max_blocks, 3, label);
    assert.deepStrictEqual(loaded.config.protect.globs, GLOBS, label);
    assert.strictEqual(loaded.config.receipts.dir, "receipts", label);
  }
  assert.strictEqual(cli.detect(makeDir({ "README.md": "x\n" })), null, "no marker file is nothing detected");
});

test("init: plain init prints the Node line and the proposal and writes nothing at all", async () => {
  const dir = makeDir({ "Cargo.toml": '[package]\nname = "x"\n' });
  const before = listing(dir);

  const result = await runCli(["init"], { cwd: dir });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.ok(result.stdout.includes(`Node ${process.version} detected. Krites needs Node 20 or later.`), result.stdout);
  assert.ok(result.stdout.includes(cli.proposal(cli.detect(dir)).trimEnd()), "the proposal is shown exactly as it would be written");
  assert.match(result.stdout, /Nothing was written\. Run \/krites:init --write to create it\.$/m);
  assert.doesNotMatch(result.stdout, ABSOLUTE);
  assert.deepStrictEqual(listing(dir), before, "plain init writes nothing at all");
});

test("init: nothing detected says so, and --write writes nothing either", async () => {
  const dir = makeDir({ "README.md": "x\n" });
  const before = listing(dir);
  for (const args of [["init"], ["init", "--write"]]) {
    const result = await runCli(args, { cwd: dir });
    assert.strictEqual(result.code, 0, args.join(" "));
    assert.match(result.stdout, /nothing to propose/, args.join(" "));
    assert.deepStrictEqual(listing(dir), before, args.join(" "));
  }
});

test("init: --write creates the config, the ignore file and the hash, and the next stop is not refuted for it", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n", "package.json": "{}\n" } });
  const result = await runCli(["init", "--write"], { cwd: repo });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.doesNotMatch(result.stdout, ABSOLUTE);

  const text = fs.readFileSync(path.join(repo, "krites.toml"), "utf8");
  assert.strictEqual(text, cli.proposal([]), "the file holds the proposal that was shown");
  assert.strictEqual(fs.readFileSync(path.join(repo, ".krites", ".gitignore"), "utf8"), "*\n");
  assert.strictEqual(readConfigHash(repo), hashText(text));

  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT, "the config the user just approved is not a protected change");
});

test("init: --write on an existing krites.toml records its hash and never changes its bytes", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] });
  seed(repo);
  fs.appendFileSync(path.join(repo, "krites.toml"), "\n# approved by hand\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), /protected path changed: krites\.toml/);

  const before = fs.readFileSync(path.join(repo, "krites.toml"));
  const result = await runCli(["init", "--write"], { cwd: repo });
  assert.strictEqual(result.code, 0);
  assert.ok(fs.readFileSync(path.join(repo, "krites.toml")).equals(before), "an existing krites.toml is never rewritten");
  assert.strictEqual(readConfigHash(repo), hashText(before.toString("utf8")));
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT, "the stop passes once the config is approved");
});

test("init: approving a krites.toml shows the [checks.env] it runs with", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, `version = 1\n\n[checks]\ncommands = ["make vulncheck"]\n\n[checks.env]\nGOTOOLCHAIN = "go1.26.6"\nAPI_TOKEN = "sk-abcdefghijklmnopqrstuvwxyz0123"\n`);
  const result = await runCli(["init"], { cwd: repo });
  assert.match(result.stdout, /runs:\n {2}make vulncheck\nwith this environment:\n {2}GOTOOLCHAIN=go1\.26\.6\n {2}API_TOKEN=<redacted>\n/);
  assert.ok(!result.stdout.includes("sk-abcdefghij"));
});

test("init: approving a krites.toml lists its slow checks apart, and says when a stop runs none", async () => {
  const both = makeRepo({ files: { "a.txt": "a\n" } });
  configure(both, 'version = 1\n\n[checks]\ncommands = ["cargo test"]\nslow = ["cargo test --release"]\n');
  assert.match((await runCli(["init"], { cwd: both })).stdout, /runs:\n {2}cargo test\nand under \/krites:verify only:\n {2}cargo test --release\n/);

  const onlySlow = makeRepo({ files: { "a.txt": "a\n" } });
  configure(onlySlow, 'version = 1\n\n[checks]\nslow = ["cargo test --release"]\n');
  const out = (await runCli(["init"], { cwd: onlySlow })).stdout;
  assert.match(out, /krites\.toml is here and runs no check at a stop\.\nand under \/krites:verify only:\n {2}cargo test --release\n/);
  assert.doesNotMatch(out, /configures no checks/);
});

test("init: an existing krites.toml that does not load prints the error and writes nothing", async () => {
  const dir = makeDir({ "krites.toml": "version = 1\n\n[checks]\nnope = 1\n" });
  const before = listing(dir);
  for (const args of [["init"], ["init", "--write"]]) {
    const result = await runCli(args, { cwd: dir });
    assert.strictEqual(result.code, 0, args.join(" "));
    assert.match(result.stdout, /krites\.toml line 4: .*Run \/krites:init\./, args.join(" "));
    assert.deepStrictEqual(listing(dir), before, args.join(" "));
  }
});

test("init: --write rewrites its own config-hash record, whatever is standing in its place", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] });
  const record = path.join(repo, ".krites", "config-hash");
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.mkdirSync(record);

  const empty = await runCli(["init", "--write"], { cwd: repo });
  assert.strictEqual(empty.code, 0);
  assert.strictEqual(empty.stderr, "");
  assert.strictEqual(readConfigHash(repo), hashText(fs.readFileSync(path.join(repo, "krites.toml"), "utf8")), "the hash is recorded");

  fs.rmSync(record);
  fs.mkdirSync(record);
  fs.writeFileSync(path.join(record, "keep.txt"), "keep\n");
  const full = await runCli(["init", "--write"], { cwd: repo });
  assert.strictEqual(full.code, 0);
  assert.strictEqual(full.stderr, "", "a directory it cannot clear is answered, not thrown");
  assert.match(full.stdout, /Krites could not finish: ENOTEMPTY\./);
  assert.doesNotMatch(full.stdout, ABSOLUTE);
  assert.strictEqual(fs.readFileSync(path.join(record, "keep.txt"), "utf8"), "keep\n", "nothing of the user's is removed");
});

test("init: an unknown argument prints one usage line even when the consent question is still open", async () => {
  const dir = makeDir({ "Cargo.toml": "[package]\n" });
  const env = { KRITES_PING_ENDPOINT: "http://127.0.0.1:9/never-reached" };
  for (const args of [["init", "--bogus"], ["init", "--write", "extra"], ["nonsense"], ["telemetry", "maybe"]]) {
    const label = args.join(" ");
    const result = await runCli(args, { cwd: dir, env });
    assert.strictEqual(result.code, 0, label);
    assert.strictEqual(result.stderr, "", label);
    assert.match(result.stdout, /^usage: /, label);
    assert.strictEqual(result.stdout.split("\n").filter(Boolean).length, 1, `${label}: the usage line and nothing else`);
  }
});

test("init: an unknown subcommand or argument prints one usage line and writes nothing", async () => {
  const dir = makeDir({ "Cargo.toml": "[package]\n" });
  const before = listing(dir);
  const bad = [[], ["init", "--force"], ["init", "--write", "extra"], ["nonsense"], ["verify", "--now"], ["receipt", "x"], ["telemetry", "maybe"]];
  for (const args of bad) {
    const label = args.join(" ") || "no subcommand";
    const result = await runCli(args, { cwd: dir });
    assert.strictEqual(result.code, 0, label);
    assert.strictEqual(result.stderr, "", label);
    assert.match(result.stdout, /^usage: /, label);
    assert.strictEqual(result.stdout.split("\n").filter(Boolean).length, 1, `${label}: one usage line`);
    assert.deepStrictEqual(listing(dir), before, label);
  }
});

test("init: the proposed globs protect Claude Code's settings, hooks, agents, commands and skills and leave the rest of .claude editable", async () => {
  const { decide } = require("../hooks/protect.js");
  const { findRoots } = require("../lib/config.js");
  const repo = makeRepo({ files: { "a.txt": "a\n", "package.json": "{}\n" } });
  assert.strictEqual((await runCli(["init", "--write"], { cwd: repo })).code, 0);
  assert.match(fs.readFileSync(path.join(repo, "krites.toml"), "utf8"), /^globs = \["tests\/krites\/\*\*", "krites\.toml", "\.claude\/settings\.json", "\.claude\/settings\.local\.json", "\.claude\/hooks\/\*\*", "\.claude\/agents\/\*\*", "\.claude\/commands\/\*\*", "\.claude\/skills\/\*\*", "\.mcp\.json", "\.claude\/output-styles\/\*\*", "\.claude\/rules\/\*\*"\]$/m);

  const roots = findRoots({ cwd: repo, processCwd: repo });
  const edit = (...parts) => decide({ tool_input: { file_path: path.join(repo, ...parts) } }, roots);
  assert.strictEqual(edit(".claude", "notes", "STATE.md"), null);
  for (const parts of [[".claude", "settings.json"], [".claude", "settings.local.json"], [".claude", "hooks", "guard.js"], [".claude", "agents", "x.md"], [".claude", "commands", "c.md"], [".claude", "skills", "s", "SKILL.md"], [".mcp.json"], [".claude", "output-styles", "o.md"], [".claude", "rules", "r.md"]]) {
    assert.match(edit(...parts), /is protected/, parts.join("/"));
  }
});

const hooked = (...commands) =>
  JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: commands.map((command) => ({ type: "command", command })) }] } });
const globsOf = (stdout) => JSON.parse(stdout.match(/^globs = (\[.*\])$/m)[1]);

test("init: a repo hook script outside .claude/hooks is proposed after the fixed globs, and nothing else is", async () => {
  const dir = makeDir({
    "package.json": "{}",
    "scripts/guard.js": "x",
    "tools/check.sh": "x",
    "tools/local.js": "x",
    "tests/krites/covered.js": "x",
    ".claude/hooks/x.js": "x",
    ".claude/settings.json": hooked("node scripts/guard.js", '"$CLAUDE_PROJECT_DIR"/tools/check.sh', "node .claude/hooks/x.js", "npx something", "node tests/krites/covered.js", "node scripts/missing.js"),
    ".claude/settings.local.json": hooked("node ${CLAUDE_PROJECT_DIR}/tools/local.js"),
  });
  const before = listing(dir);
  const result = await runCli(["init"], { cwd: dir });
  assert.deepStrictEqual(globsOf(result.stdout), [...GLOBS, "scripts/guard.js", "tools/check.sh", "tools/local.js"]);
  assert.doesNotMatch(result.stdout, ABSOLUTE);
  assert.deepStrictEqual(listing(dir), before, "plain init writes nothing");

  const written = await runCli(["init", "--write"], { cwd: dir });
  assert.strictEqual(written.code, 0, written.stdout);
  const loaded = loadConfig(dir);
  assert.strictEqual(loaded.ok, true, loaded.error);
  assert.deepStrictEqual(loaded.config.protect.globs, [...GLOBS, "scripts/guard.js", "tools/check.sh", "tools/local.js"]);
});

test("init: a settings file that does not parse still gives the fixed globs", async () => {
  const dir = makeDir({ "package.json": "{}", "scripts/guard.js": "x", ".claude/settings.json": "{ not json", ".claude/settings.local.json": '{"hooks": 3}' });
  const result = await runCli(["init"], { cwd: dir });
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(globsOf(result.stdout), GLOBS);
});

const WINDOWS = process.platform === "win32";
const scriptsFor = (files, ...commands) => cli.hookScripts(makeDir({ ...files, ".claude/settings.json": hooked(...commands) }));

test("init: only scripts are proposed, never the data files a command names", () => {
  const files = { "src/index.css": "x", "package.json": "{}", "scripts/guard.js": "x", "bin/hook": "x", "notes.txt": "x" };
  assert.deepStrictEqual(scriptsFor(files, "npx prettier --check src/index.ts src/index.css package.json"), []);
  assert.deepStrictEqual(scriptsFor(files, "node scripts/guard.js notes.txt"), ["scripts/guard.js"]);
  assert.deepStrictEqual(scriptsFor(files, "bin/hook notes.txt"), ["bin/hook"], "the first token counts whatever its extension");
});

test("init: a quoted script path keeps its spaces", () => {
  const files = { "my scripts/g.js": "x", "scripts/g.js": "x" };
  assert.deepStrictEqual(scriptsFor(files, 'node "$CLAUDE_PROJECT_DIR/my scripts/g.js"'), ["my scripts/g.js"]);
  assert.deepStrictEqual(scriptsFor(files, "node '${CLAUDE_PROJECT_DIR}/my scripts/g.js'"), ["my scripts/g.js"]);
});

test("init: a script reached through a link is proposed by both names, and one whose real path leaves the repo never is", () => {
  const dir = makeDir({ "real/g.js": "x", ".claude/settings.json": hooked("node linked/g.js", "node away/x.js") });
  const away = makeDir({ "x.js": "x" });
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linked"), "junction");
  fs.symlinkSync(away, path.join(dir, "away"), "junction");
  assert.deepStrictEqual(cli.hookScripts(dir), ["linked/g.js", "real/g.js"]);
});

test("init: a $ in the repo path is taken literally", () => {
  const dir = path.join(makeDir(), "a$&b");
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, "tools", "check.sh"), "x");
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), hooked('"$CLAUDE_PROJECT_DIR"/tools/check.sh'));
  assert.deepStrictEqual(cli.hookScripts(dir), ["tools/check.sh"]);
});

test("init: a name with * ? a backslash or a control character is never proposed, and brackets are written as they are", () => {
  const files = { "a[1].js": "x", "b{c}.js": "x", ...(WINDOWS ? {} : { "q?.js": "x", "s*.js": "x", "c\u0001.js": "x", "d\\e.js": "x" }) };
  const names = Object.keys(files);
  assert.deepStrictEqual(scriptsFor(files, `node ${names.map((name) => `'${name}'`).join(" ")}`), ["a[1].js", "b{c}.js"]);
});

test("init: a settings path that is not a regular file is skipped", { skip: WINDOWS && "win32 has no FIFO" }, () => {
  const dir = makeDir({ "scripts/g.js": "x", ".claude/settings.local.json/x": "x" });
  assert.strictEqual(require("node:child_process").spawnSync("mkfifo", [path.join(dir, ".claude", "settings.json")]).status, 0);
  assert.deepStrictEqual(cli.hookScripts(dir), []);
});

test("init: a settings path that is a directory is skipped", () => {
  assert.deepStrictEqual(cli.hookScripts(makeDir({ "scripts/g.js": "x", ".claude/settings.json/x": "x" })), []);
});

test("init: absolute, dotted and backslashed script paths resolve against the repo", () => {
  const outside = makeDir({ "x.js": "x" });
  const dir = makeDir({ "scripts/abs.js": "x", "tools/t.js": "x", "scripts/guard.js": "x" });
  fs.mkdirSync(path.join(dir, ".claude"));
  const commands = [`node "${path.join(dir, "scripts", "abs.js")}"`, "node scripts/../tools/t.js", `node ../${path.basename(outside)}/x.js`, "node scripts\\guard.js"];
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), hooked(...commands));
  assert.deepStrictEqual(cli.hookScripts(dir), WINDOWS ? ["scripts/abs.js", "scripts/guard.js", "tools/t.js"] : ["scripts/abs.js", "tools/t.js"]);
});
