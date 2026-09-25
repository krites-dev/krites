const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { ABSOLUTE, configure, makeDir, makeRepo, runCli, runHook, script, seed, tmp } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const VERIFIER = path.join(__dirname, "..", "verify-receipt.js");
const DIR = "receipts";

// Signing happens here, so the key goes under the OS temp directory and never under the real user config directory.
process.env.KRITES_CONFIG_DIR = path.join(tmp, "cli-receipt-config");

const listing = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return null;
  }
};

async function ran(commands) {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands, timeoutSeconds: 60 });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  await runHook(GATE, { hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd: repo }, { cwd: repo });
  return repo;
}

test("receipt: with no gate run it reports nothing to sign and writes nothing", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] });
  seed(repo);

  const result = await runCli(["receipt"], { cwd: repo });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.match(result.stdout, /nothing to sign/);
  assert.strictEqual(listing(path.join(repo, DIR)), null, "a refusal writes no receipts directory");
});

test("receipt: a gate run is written as both files, named relative to the root, and the verifier accepts it", async () => {
  const repo = await ran([script("console.log('fine')")]);

  const result = await runCli(["receipt"], { cwd: repo });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.doesNotMatch(result.stdout, ABSOLUTE);
  const written = result.stdout.trimEnd().split("\n");
  assert.strictEqual(written.length, 2, result.stdout);
  assert.match(written[0], /^receipts\/[0-9A-Za-z._-]+\.json$/);
  assert.strictEqual(written[1], written[0].replace(/\.json$/, ".md"));

  const checked = spawnSync(process.execPath, [VERIFIER, path.join(repo, written[0])], { cwd: tmp, encoding: "utf8", windowsHide: true });
  assert.strictEqual(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /^valid: signed by [0-9a-f]{64}, verdict passed, signer not pinned \(pass --key\)\n$/);
});

test("receipt: a run the gate never wrote is refused and leaves nothing behind", async () => {
  const repo = await ran([script("console.log('fine')")]);
  const file = path.join(repo, ".krites", "last-run.json");
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, `${JSON.stringify({ ...run, verdict: "verified", checks: 5 }, null, 2)}\n`);

  const result = await runCli(["receipt"], { cwd: repo });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(result.stdout, "the recorded run is not one the gate wrote; run /krites:verify\n");
  assert.strictEqual(listing(path.join(repo, DIR)), null, "a refusal leaves no half-written receipt behind");
});

test("receipt: asking twice points at the file already written and writes nothing new", async () => {
  const repo = await ran([script("console.log('fine')")]);
  const first = await runCli(["receipt"], { cwd: repo });
  const written = first.stdout.trimEnd().split("\n");
  const before = listing(path.join(repo, DIR));
  const bytes = fs.readFileSync(path.join(repo, written[0]));

  const again = await runCli(["receipt"], { cwd: repo });
  assert.strictEqual(again.code, 0);
  assert.strictEqual(again.stdout, `This run's receipt is already at ${written[0]}.\n`);
  assert.deepStrictEqual(listing(path.join(repo, DIR)), before, "no second file for one run");
  assert.ok(fs.readFileSync(path.join(repo, written[0])).equals(bytes), "the receipt already written is left as it was");
});

test("receipt: settings that turn the hooks off are named and nothing is written", async () => {
  const repo = await ran([script("console.log('fine')")]);
  const user = makeDir({ "settings.json": JSON.stringify({ enabledPlugins: { "krites@krites": false } }) });

  const result = await runCli(["receipt"], { cwd: repo, env: { CLAUDE_CONFIG_DIR: user } });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(result.stdout, 'Krites hooks are off for this repo: $CLAUDE_CONFIG_DIR/settings.json sets enabledPlugins["krites@krites"].\n');
  assert.strictEqual(listing(path.join(repo, DIR)), null, "a refusal writes no receipts directory");
});

test("receipt: allowManagedHooksOnly alone does not refuse", async () => {
  const repo = await ran([script("console.log('fine')")]);
  const env = { KRITES_MANAGED_SETTINGS_DIR: makeDir({ "managed-settings.json": JSON.stringify({ allowManagedHooksOnly: true }) }) };

  const result = await runCli(["receipt"], { cwd: repo, env });
  assert.strictEqual(result.stderr, "");
  assert.match(result.stdout, /^receipts\/[0-9A-Za-z._-]+\.json\nreceipts\/[0-9A-Za-z._-]+\.md\n$/);
});

test("receipt: a settings file that does not parse is named and the receipt is still written", async () => {
  const repo = await ran([script("console.log('fine')")]);
  const env = { CLAUDE_CONFIG_DIR: makeDir({ "settings.json": `${String.fromCharCode(0xfeff)}{broken` }) };

  const result = await runCli(["receipt"], { cwd: repo, env });
  assert.strictEqual(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.strictEqual(lines[0], "Krites cannot read $CLAUDE_CONFIG_DIR/settings.json, so its hooks setting is unknown.");
  assert.match(lines[1], /^receipts\/[0-9A-Za-z._-]+\.json$/);
  assert.ok(fs.existsSync(path.join(repo, lines[1])), result.stdout);
});
