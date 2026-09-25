const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after } = require("node:test");

const ABSOLUTE =
  /(?<![A-Za-z])[A-Za-z]:[\\/]|(?<![:\w\\/])[\\/]{2}\w|(?:(?<![\w.~<>/-])|(?<=-[A-Za-z]))\/(home|Users|tmp|var|usr|opt|private|etc|mnt|root)\/|(?<![\w~])[\\/]([Uu]sers|[Hh]ome)[\\/]\w|[\\/][A-Za-z][\\/]([Uu]sers|[Hh]ome)[\\/]\w/;

const FIXTURES = path.join(__dirname, "fixtures");
const NOT_COPIED = new Set(["node_modules", "target"]);
const WINDOWS = process.platform === "win32";

const nonAscii = process.env.KRITES_TEST_NONASCII === "1";
const parent = nonAscii ? fs.mkdtempSync(path.join(os.tmpdir(), "krites tëst Проверка ")) : os.tmpdir();
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "krites-plugin-")));

// gate() and main() also run inside the test processes, where childEnvFor guards nothing. Unset, the endpoint
// would be the built-in krites.dev one, so it is switched off here and a test that needs one passes its own.
process.env.KRITES_CONFIG_DIR = path.join(tmp, "own-config");
process.env.KRITES_PING_ENDPOINT = "off";
// Children inherit these, so no run reads the developer's own user, project or managed settings.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(tmp, "claude-config-"));
process.env.KRITES_MANAGED_SETTINGS_DIR = fs.mkdtempSync(path.join(tmp, "managed-settings-"));
delete process.env.CLAUDE_PROJECT_DIR;

const junctions = [];
// Leftover processes are not killed here: by the end of a file a recorded pid may belong to something else,
// so every hang script a test starts ends by itself.
after(() => {
  // A precaution: the removal of the temp tree never has to deal with a standing link into the fixture's own install.
  for (const link of junctions) {
    try {
      fs.unlinkSync(link);
    } catch {
      continue;
    }
  }
  for (const dir of nonAscii ? [parent] : [tmp]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

let made = 0;

function makeDir(files = {}) {
  const dir = path.join(tmp, `d${++made}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return fs.realpathSync.native(dir);
}

// Identity comes from -c so the run never reads or writes the user's git config.
const git = (dir, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, windowsHide: true });

function gitInit(dir) {
  git(dir, "init", "-q");
  return dir;
}

function makeRepo({ files = {}, commit = true } = {}) {
  const dir = gitInit(makeDir(files));
  if (commit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

const head = (dir) => git(dir, "rev-parse", "HEAD").stdout.toString().trim();

// An in-process gate also gates the repo of the process cwd, so it runs from the temp dir, never the checkout.
async function fromTmp(run) {
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    return await run();
  } finally {
    process.chdir(cwd);
  }
}

// What session.js records at startup: the baseline HEAD and the hash of the config it read.
function seed(root, gitRoot = root) {
  const state = require("../lib/state.js");
  state.writeBaseline(root, head(gitRoot));
  const hash = state.configHash(root);
  if (hash !== null) state.writeConfigHash(root, hash);
  return root;
}

const installs = new Map();

// The fixture's own pinned dev dependency, installed once per fixture when it is missing; CI installs it before the tests.
function installOnce(fixture = path.join(FIXTURES, "ts")) {
  let install = installs.get(fixture);
  if (install === undefined) {
    const options = { cwd: fixture, encoding: "utf8", windowsHide: true };
    // Windows needs a shell to reach npm.cmd, and the command goes as one string so its arguments are not re-split (lib/checks.js).
    if (fs.existsSync(path.join(fixture, "node_modules"))) install = { status: 0 };
    else install = WINDOWS ? spawnSync("npm ci", { ...options, shell: true }) : spawnSync("npm", ["ci"], options);
    installs.set(fixture, install);
  }
  const said = [install.stdout, install.stderr, install.error].filter(Boolean).join("");
  assert.strictEqual(install.status, 0, `npm ci in test/fixtures/${path.basename(fixture)} failed:\n${said}`);
}

// A fixture repo is copied out of the tree so its checks can build in it, which keeps the cargo target directory
// inside the copy; node_modules is linked instead of copied, and the link is removed before the copy is.
function fixtureRepo(name) {
  const source = path.join(FIXTURES, name);
  const repo = gitInit(makeDir());
  fs.cpSync(source, repo, { recursive: true, filter: (from) => !NOT_COPIED.has(path.basename(from)) });
  if (fs.existsSync(path.join(source, "package.json"))) {
    installOnce(source);
    const link = path.join(repo, "node_modules");
    fs.symlinkSync(path.join(source, "node_modules"), link, "junction");
    junctions.push(link);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return seed(repo);
}

let checks = 0;

// Check scripts live outside every repo, so running one never changes a tree fingerprint.
function script(source) {
  const file = path.join(tmp, `check${++checks}.js`);
  fs.writeFileSync(file, source);
  return ["node", file];
}

const tomlString = (value) => `"${String(value).replace(/\\/g, "\\\\")}"`;

function toml({ commands = [], slow, timeoutSeconds, maxBlocks, globs } = {}) {
  const argv = (item) => `[${item.map(tomlString).join(", ")}]`;
  const out = ["version = 1", "", "[checks]", `commands = [${commands.map(argv).join(", ")}]`];
  if (slow !== undefined) out.push(`slow = [${slow.map(argv).join(", ")}]`);
  if (timeoutSeconds !== undefined) out.push(`timeout_seconds = ${timeoutSeconds}`);
  if (maxBlocks !== undefined) out.push(`max_blocks = ${maxBlocks}`);
  if (globs !== undefined) out.push("", "[protect]", `globs = [${globs.map(tomlString).join(", ")}]`);
  return `${out.join("\n")}\n`;
}

// Committed, because an untracked krites.toml is itself a changed protected path.
function configure(repo, options) {
  fs.writeFileSync(path.join(repo, "krites.toml"), typeof options === "string" ? options : toml(options));
  git(repo, "add", "krites.toml");
  git(repo, "commit", "-q", "-m", "config");
  return repo;
}

// JSON doubles every backslash, and a doubled one reads as a UNC path, so scans run over the decoded strings.
const textOf = (value) =>
  typeof value === "string" ? value : value && typeof value === "object" ? Object.values(value).map(textOf).join("\n") : "";

function hookText(result) {
  try {
    return `${textOf(JSON.parse(result.stdout))}\n${result.stderr}`;
  } catch {
    return result.stdout + result.stderr;
  }
}

function assertBlock(result, pattern) {
  assert.strictEqual(result.code, 0, "exit code is 0, never 2");
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.decision, "block");
  assert.match(out.reason, pattern);
  assert.doesNotMatch(hookText(result), ABSOLUTE, "no absolute path in hook output");
  assert.strictEqual(result.stderr, "", "nothing on stderr, so no stack trace naming the script");
  return out.reason;
}

// A child left to the built-in endpoint would ping krites.dev and write the developer's own telemetry.json.
function childEnvFor(env) {
  const childEnv = { ...process.env };
  delete childEnv.CLAUDE_PROJECT_DIR;
  delete childEnv.CLAUDE_PLUGIN_ROOT;
  childEnv.KRITES_PING_ENDPOINT = "off";
  if (!String(childEnv.KRITES_CONFIG_DIR).startsWith(tmp)) childEnv.KRITES_CONFIG_DIR = path.join(tmp, "child-config");
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name];
    else childEnv[name] = value;
  }
  // An override of undefined or "" would fall back to the built-in endpoint.
  if (!childEnv.KRITES_PING_ENDPOINT) childEnv.KRITES_PING_ENDPOINT = "off";
  return childEnv;
}

function collect(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// The commands take their arguments on the command line and read no stdin, so this is runHook without a payload.
const runCli = (args, { cwd = tmp, env = {} } = {}) =>
  collect(spawn(process.execPath, [path.join(__dirname, "..", "cli.js"), ...args], { cwd, env: childEnvFor(env), windowsHide: true }));

function runHook(script, payload, { cwd = tmp, env = {}, closeStdin = true } = {}) {
  const child = spawn(process.execPath, [script], { cwd, env: childEnvFor(env), windowsHide: true });
  const done = collect(child);
  if (payload !== null) child.stdin.write(typeof payload === "string" ? payload : JSON.stringify(payload));
  if (closeStdin) child.stdin.end();
  return done;
}

module.exports = {
  ABSOLUTE,
  assertBlock,
  configure,
  fixtureRepo,
  fromTmp,
  git,
  gitInit,
  head,
  hookText,
  installOnce,
  makeDir,
  makeRepo,
  runCli,
  runHook,
  script,
  seed,
  textOf,
  tmp,
  toml,
};
