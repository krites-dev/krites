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
const GLOBS = ["tests/krites/**", "krites.toml", ".claude/**"];
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
