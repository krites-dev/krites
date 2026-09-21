const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { scrub } = require("../lib/scrub.js");
const { writeBlockCount } = require("../lib/state.js");
const { ABSOLUTE, configure, hookText, makeDir, makeRepo, runCli, runHook, script, seed, textOf, tmp, toml } = require("./helpers.js");

const HOOKS = path.join(__dirname, "..", "hooks");
const PLUGIN = path.join(__dirname, "..");
const WINDOWS = process.platform === "win32";
const hook = (name) => path.join(HOOKS, `${name}.js`);

// The receipt command signs, so the key goes under the OS temp directory.
process.env.KRITES_CONFIG_DIR = path.join(tmp, "output-config");

// Base64 of a random key is not text: about one key in 3000 opens with "//", which the path scan reads as a UNC share.
function signed(text) {
  const receipt = JSON.parse(text);
  delete receipt.signature;
  return receipt;
}

const stop = (cwd, extra) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd, ...extra });
const edit = (file, cwd) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd, tool_input: { file_path: file } });
const start = (cwd) => ({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd });

function assertClean(label, result) {
  assert.strictEqual(result.code, 0, `${label}: exit 0, never 2`);
  assert.strictEqual(result.stderr, "", `${label}: nothing on stderr`);
  const out = hookText(result);
  assert.doesNotMatch(out, ABSOLUTE, `${label}: no absolute path`);
  for (const secret of [PLUGIN, HOOKS, "gate.js", "protect.js", "session.js", "hookio", "CLAUDE_PLUGIN_ROOT", os.homedir()]) {
    assert.ok(!out.includes(secret), `${label}: the hook's own command line stays out of the output (${secret})`);
  }
  return out;
}

test("output: every hook path exits 0 with no absolute path and no command line", { timeout: 60000 }, async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } });
  configure(repo, { commands: [script(`console.log("failing in " + process.cwd()); process.exit(2);`)], globs: ["secrets/**"] });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  const settled = makeRepo({ files: { "a.txt": "a\n" } });
  configure(settled, { commands: [script("process.exit(0)")] });
  seed(settled);

  const broken = makeRepo({ files: { "a.txt": "a\n" } });
  configure(broken, "version = 1\n\n[checks]\nnope = 1\n");

  const spent = makeRepo({ files: { "a.txt": "a\n" } });
  configure(spent, { commands: [script(`console.log("failing in " + process.cwd()); process.exit(2);`)] });
  seed(spent);
  writeBlockCount(spent, 9);
  fs.writeFileSync(path.join(spent, "a.txt"), "changed\n");

  const repeat = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repeat, { commands: [script("process.exit(1)")] });
  seed(repeat);
  fs.writeFileSync(path.join(repeat, "a.txt"), "changed\n");

  const unwritable = makeRepo({ files: { "a.txt": "a\n" } });
  configure(unwritable, { commands: [script("process.exit(1)")] });
  seed(unwritable);
  fs.writeFileSync(path.join(unwritable, "a.txt"), "changed\n");
  fs.mkdirSync(path.join(unwritable, ".krites", "block-count", "held"), { recursive: true });

  const bare = makeRepo({ files: { "a.txt": "a\n" } });
  const plain = makeDir({ "a.txt": "a\n" });

  const runs = [
    ["gate block", hook("gate"), stop(repo), repo],
    ["gate skip", hook("gate"), stop(settled), settled],
    ["gate config error", hook("gate"), stop(broken), broken],
    ["gate budget spent", hook("gate"), stop(spent), spent],
    ["session budget spent", hook("session"), start(spent), spent],
    ["gate repeat stop", hook("gate"), stop(repeat, { stop_hook_active: true }), repeat],
    ["gate unwritable counter", hook("gate"), stop(unwritable), unwritable],
    ["gate malformed", hook("gate"), "{not json", settled],
    ["gate inert", hook("gate"), stop(plain), plain],
    ["protect deny", hook("protect"), edit(path.join(repo, "secrets", "rule.md"), repo), repo],
    ["protect outside", hook("protect"), edit(path.join(os.homedir(), "x.txt"), repo), repo],
    ["protect config error", hook("protect"), edit(path.join(broken, "a.txt"), broken), broken],
    ["protect allow", hook("protect"), edit(path.join(repo, "a.txt"), repo), repo],
    ["protect malformed", hook("protect"), "{not json", repo],
    ["session nudge", hook("session"), start(bare), bare],
    ["session config error", hook("session"), start(broken), broken],
    ["session ok", hook("session"), start(settled), settled],
    ["session malformed", hook("session"), "{not json", settled],
  ];

  const seen = new Map();
  for (const [label, file, payload, cwd] of runs) seen.set(label, assertClean(label, await runHook(file, payload, { cwd })));
  assert.match(seen.get("gate repeat stop"), /refuted/, "a repeat stop on a dirty tree is refused, not waved through");
  assert.match(seen.get("gate unwritable counter"), /block-count cannot be written/, "the counter that gave way is named, without a path");

  for (const dir of [repo, spent]) {
    const written = textOf(JSON.parse(fs.readFileSync(path.join(dir, ".krites", "last-run.json"), "utf8")));
    assert.doesNotMatch(written, ABSOLUTE, "no absolute path in last-run.json");
    assert.ok(!written.includes(os.homedir()) && !written.includes(PLUGIN), "no home or install path in last-run.json");
  }
});

test("output: a timed-out gate and a no_checks gate keep the same guarantees", { timeout: 60000 }, async () => {
  const slow = makeRepo({ files: { "a.txt": "a\n" } });
  // A check that outlives the kill would hold the pipes its parent reads, so it lets them go and ends by itself.
  const hang = [
    "process.stdout.destroy();",
    "process.stderr.destroy();",
    "setTimeout(() => {}, 30000);",
  ].join("\n");
  configure(slow, { commands: [script(hang)], timeoutSeconds: 3 });
  seed(slow);
  fs.writeFileSync(path.join(slow, "a.txt"), "changed\n");
  assertClean("gate timeout", await runHook(hook("gate"), stop(slow), { cwd: slow }));

  const quiet = makeRepo({ files: { "krites.toml": toml({ commands: [] }), "a.txt": "a\n" } });
  fs.writeFileSync(path.join(quiet, "a.txt"), "changed\n");
  assertClean("gate no_checks", await runHook(hook("gate"), stop(quiet), { cwd: quiet }));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(quiet, ".krites", "last-run.json"), "utf8")).verdict, "no_checks");
});

test("output: every command path exits 0 with no absolute path, no command line and no receipt that leaks one", { timeout: 120000 }, async () => {
  const failing = makeRepo({ files: { "a.txt": "a\n" } });
  configure(failing, { commands: [script('console.log("failing in " + process.cwd()); process.exit(2);')], timeoutSeconds: 60 });
  seed(failing);
  fs.writeFileSync(path.join(failing, "a.txt"), "changed\n");

  const passing = makeRepo({ files: { "a.txt": "a\n" } });
  configure(passing, { commands: [script('console.log("passing in " + process.cwd());')], timeoutSeconds: 60 });
  seed(passing);
  fs.writeFileSync(path.join(passing, "a.txt"), "changed\n");

  const broken = makeRepo({ files: { "a.txt": "a\n" } });
  configure(broken, "version = 1\n\n[checks]\nnope = 1\n");
  const fresh = makeDir({ "package.json": "{}\n" });
  const plain = makeDir({ "a.txt": "a\n" });

  const runs = [
    ["init", ["init"], fresh],
    ["init --write", ["init", "--write"], fresh],
    ["init on an existing config", ["init"], failing],
    ["init nothing detected", ["init"], plain],
    ["verify refuted", ["verify"], failing],
    ["verify passed", ["verify"], passing],
    ["verify config error", ["verify"], broken],
    ["verify no root", ["verify"], plain],
    ["receipt", ["receipt"], passing],
    ["receipt again", ["receipt"], passing],
    ["receipt with a config error", ["receipt"], broken],
    ["receipt with nothing to sign", ["receipt"], fresh],
    ["telemetry", ["telemetry", "on"], passing],
    ["usage", ["nonsense"], passing],
  ];

  for (const [label, args, cwd] of runs) {
    const result = await runCli(args, { cwd });
    assert.strictEqual(result.code, 0, `${label}: exit 0, never 2`);
    assert.strictEqual(result.stderr, "", `${label}: nothing on stderr`);
    assert.doesNotMatch(result.stdout, ABSOLUTE, `${label}: no absolute path`);
    for (const secret of [PLUGIN, HOOKS, "cli.js", "gate.js", "CLAUDE_PLUGIN_ROOT", os.homedir()]) {
      assert.ok(!result.stdout.includes(secret), `${label}: the plugin's own location stays out of the output (${secret})`);
    }
  }

  const dir = path.join(passing, "receipts");
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 2, "one run, one receipt in each form");
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    assert.doesNotMatch(name.endsWith(".json") ? textOf(signed(text)) : text, ABSOLUTE, `no absolute path in ${name}`);
    assert.ok(!text.includes(os.homedir()) && !text.includes(PLUGIN), `no home or install path in ${name}`);
  }
});

test("output: a command whose stdout is gone still exits 0 with nothing on stderr", { timeout: 60000 }, async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n", "Cargo.toml": "[package]\n" } });
  configure(repo, { commands: [script("console.log('plenty of output')")], timeoutSeconds: 60 });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  // The helpers' own rules for a spawned child: no project dir, no endpoint, a config dir under the test temp dir.
  const env = { ...process.env, KRITES_CONFIG_DIR: path.join(tmp, "output-config") };
  for (const name of ["CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_ROOT", "KRITES_PING_ENDPOINT"]) delete env[name];

  for (const args of [["verify"], ["init"]]) {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "cli.js"), ...args], { cwd: repo, env, windowsHide: true });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.strictEqual(stderr, "", `${args[0]}: a pipe nobody reads prints no stack`);
    assert.strictEqual(code, 0, `${args[0]}: a pipe nobody reads is not a failure`);
  }
});

test("output: scrub removes the path forms compilers print and redacts token shapes", () => {
  const root = WINDOWS ? "D:\\Work\\Krites" : "/usr/work/krites";
  const leaks = [
    "at C:\\Program Files\\Acme Tool\\secret dir\\key.pem:4",
    "open \\\\fileserver\\share\\team\\q3.xlsx failed",
    "open //fileserver/share/team/q3.xlsx failed",
    "in \\\\?\\UNC\\fileserver\\share\\team\\q3.xlsx",
    "import file:///usr/work/client/app.mjs",
    "PATH=/usr/local/bin:/usr/secret/tools/bin",
    "-I/usr/include/secret `/usr/lib/x.so` [/usr/lib/y.so],/usr/lib/z.so",
    "at /usr/secret dir/tools/x.rs:9",
    "at /usr/donn\u00e9es/clients/x.rs:9",
    `sibling ${root}Other${path.sep}private${path.sep}x.txt`,
  ];
  for (const line of leaks) assert.doesNotMatch(scrub(line, root), ABSOLUTE, line);
  assert.ok(!scrub(`sibling ${root}Other${path.sep}x.txt`, root).includes(".Other"), "a sibling directory is not the repo root");
  assert.ok(scrub(leaks[0], root).includes("key.pem:4"), "the file name and line survive");
  assert.strictEqual(scrub(`at ${root}${path.sep}src${path.sep}lib.rs:3`, root), `at .${path.sep}src${path.sep}lib.rs:3`);
  assert.strictEqual(scrub("red \x1b[31mtext\x1b[0m", root), "red text");

  for (const token of ["sk-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz012345", "Bearer abcdefghijklmnopqrst"]) {
    assert.strictEqual(scrub(`key ${token} end`, root), "key <redacted> end", token);
  }

  const users = [
    "at C:\\Users\\someone\\proj\\a.rs:1",
    "at \\Users\\someone\\proj\\a.rs:1",
    "at ../../Users/someone/proj/a.rs:1",
    "at /home/someone/proj/a.rs:1",
    "at /c/Users/someone/proj/a.rs:1",
    "at C:\\Users\\someone else\\proj\\a.rs:1",
    "at ..\\Users\\someone else\\proj\\a.rs:1",
  ];
  for (const line of users) {
    assert.match(line, ABSOLUTE, `the scan flags ${line}`);
    const clean = scrub(line, root);
    assert.doesNotMatch(clean, ABSOLUTE, line);
    assert.ok(!clean.includes("someone") && !clean.includes("else"), `no part of the user name survives: ${line} -> ${clean}`);
  }
  if (WINDOWS) assert.ok(scrub("at /d/Other/secret/x.rs:9", root).endsWith("x.rs:9"), "an MSYS path keeps its file name only");
  for (const line of ['expected "/api/v1/users" got "/api/v2/users"', "GET /api/v1/users 404", "see https://example.com/usr/docs/page", "sed s/foo/bar/g"]) {
    assert.strictEqual(scrub(line, root), line);
  }
});
