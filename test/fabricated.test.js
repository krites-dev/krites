const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { configure, makeRepo, runCli, runHook, script, seed, tmp } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const SILENT = { code: 0, stdout: "", stderr: "" };
const CLAIM = "All tests pass. cargo nextest run --workspace: 412 passed, 0 failed.";

// A receipt would be signed if one were owed, so the key goes under the OS temp directory.
process.env.KRITES_CONFIG_DIR = path.join(tmp, "fabricated-config");

const lastRun = (repo) => path.join(repo, ".krites", "last-run.json");

function settled() {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")] });
  seed(repo);
  return repo;
}

test("fabricated: a claim of success with nothing to verify produces no last-run.json", async () => {
  const repo = settled();
  const payload = { hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd: repo, last_assistant_message: CLAIM };

  assert.deepStrictEqual(await runHook(GATE, payload, { cwd: repo }), SILENT);
  assert.strictEqual(fs.existsSync(lastRun(repo)), false, "a skipped gate signs nothing");
});

test("fabricated: a claim of success over work the gate never saw yields no receipt", async () => {
  const repo = settled();
  fs.writeFileSync(path.join(repo, "a.txt"), "checked\n");
  const payload = { hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd: repo, last_assistant_message: CLAIM };
  assert.deepStrictEqual(await runHook(GATE, payload, { cwd: repo }), SILENT, "the run that did happen passed");

  fs.writeFileSync(path.join(repo, "a.txt"), "written after the run\n");
  const result = await runCli(["receipt"], { cwd: repo });
  assert.strictEqual(result.code, 0);
  assert.match(result.stdout, /tree changed since the last gate run/);
  assert.strictEqual(fs.existsSync(path.join(repo, "receipts")), false, "no receipt covers work the checks never saw");
});

test("fabricated: a claim of success never refreshes an older last-run.json", async () => {
  const repo = settled();
  const stale = { schema: "krites.last-run/0.1", verdict: "refuted", head: "stale" };
  fs.writeFileSync(lastRun(repo), JSON.stringify(stale));
  const payload = { hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd: repo, last_assistant_message: CLAIM };

  assert.deepStrictEqual(await runHook(GATE, payload, { cwd: repo }), SILENT);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(lastRun(repo), "utf8")), stale, "the old run is left as it was");
});
