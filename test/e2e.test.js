const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { ABSOLUTE, assertBlock, fixtureRepo, runCli, runHook, textOf, tmp } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const VERIFIER = path.join(__dirname, "..", "verify-receipt.js");
const SILENT = { code: 0, stdout: "", stderr: "" };
// Two real gate runs of up to the fixtures' 300 s deadline each, plus a cold cargo build or an npm ci on a CI runner.
const TIMEOUT_MS = 900000;

// Signing happens here, so the key goes under the OS temp directory and never under the real user config directory.
process.env.KRITES_CONFIG_DIR = path.join(tmp, "e2e-config");

const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "e2e", cwd });
const lastRun = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8"));

// One turn of the real loop: the checks refute the break in the tool's own words, pass the fix, and sign the pass.
async function endToEnd({ fixture, file, from, broken, fixed, code }) {
  const repo = fixtureRepo(fixture);
  const source = path.join(repo, file);
  const committed = fs.readFileSync(source, "utf8");
  assert.ok(committed.includes(from), `${file} no longer holds ${from}`);

  fs.writeFileSync(source, committed.replace(from, broken));
  const reason = assertBlock(await runHook(GATE, stop(repo), { cwd: repo }), code);
  assert.match(reason, /Krites refuted the stop/);
  const refuted = lastRun(repo);
  assert.strictEqual(refuted.verdict, "refuted");
  assert.match(refuted.checks[refuted.checks.length - 1].tail, code, "the tool's own output is what was recorded");
  assert.doesNotMatch(textOf(refuted), ABSOLUTE, "no absolute path in last-run.json");

  fs.writeFileSync(source, committed.replace(from, fixed));
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT, "the fixed tree stops silently");
  assert.strictEqual(lastRun(repo).verdict, "passed");

  const written = await runCli(["receipt"], { cwd: repo });
  assert.strictEqual(written.code, 0);
  assert.strictEqual(written.stderr, "");
  assert.doesNotMatch(written.stdout, ABSOLUTE);
  const [json, md] = written.stdout.trimEnd().split("\n");
  assert.match(json, /^receipts\/[0-9A-Za-z._-]+\.json$/, written.stdout);
  assert.strictEqual(md, json.replace(/\.json$/, ".md"));
  // Without the signature: base64 that opens with "//" reads as a UNC path to the scanner, about one key in 3300.
  const body = JSON.parse(fs.readFileSync(path.join(repo, json), "utf8"));
  delete body.signature;
  assert.doesNotMatch(textOf(body), ABSOLUTE, "no absolute path in the receipt");
  assert.doesNotMatch(fs.readFileSync(path.join(repo, md), "utf8"), ABSOLUTE, "no absolute path in the receipt markdown");

  const checked = spawnSync(process.execPath, [VERIFIER, path.join(repo, json)], { cwd: tmp, encoding: "utf8", windowsHide: true });
  assert.strictEqual(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /^valid: signed by [0-9a-f]{64}, verdict passed, signer not pinned \(pass --key\)\n$/);
}

test("end to end: cargo refutes a stop in rustc's own words, and the pass is signed", { timeout: TIMEOUT_MS }, () =>
  endToEnd({
    fixture: "rust",
    file: "src/lib.rs",
    from: "pub const SEED: i32 = 1;",
    broken: 'pub const SEED: i32 = "one";',
    fixed: "pub const SEED: i32 = 2;",
    code: /error\[E0308\]/,
  }));

test("end to end: tsc refutes a stop in its own words, and the pass is signed", { timeout: TIMEOUT_MS }, () =>
  endToEnd({
    fixture: "ts",
    file: "src/index.ts",
    from: "export const seed: number = 1;",
    broken: 'export const seed: number = "one";',
    fixed: "export const seed: number = 2;",
    code: /error TS2322/,
  }));
