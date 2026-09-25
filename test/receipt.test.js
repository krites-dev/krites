const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const receipts = require("../lib/receipt.js");
const sign = require("../lib/sign.js");
const { writeBlockCount } = require("../lib/state.js");
const verifier = require("../verify-receipt.js");
const { ABSOLUTE, configure, git, makeRepo, runCli, runHook, script, seed, textOf, tmp, toml } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const VERIFIER = path.join(__dirname, "..", "verify-receipt.js");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIR = "receipts";
const KEY_FILE = "signing-key.pem";
const LAST_RUN = path.join(".krites", "last-run.json");
const NOT_THE_GATE = "the recorded run is not one the gate wrote; run /krites:verify";
const UNPINNED = ", signer not pinned (pass --key)";
const POSIX = process.platform !== "win32";

const listing = (dir) => {
  try {
    return fs.readdirSync(dir).sort().join(",");
  } catch {
    return null;
  }
};

// The real location is read once, with the override out of the way, and is expected untouched at the end.
const saved = process.env.KRITES_CONFIG_DIR;
delete process.env.KRITES_CONFIG_DIR;
const REAL = sign.configDir();
if (saved !== undefined) process.env.KRITES_CONFIG_DIR = saved;
const REAL_BEFORE = listing(REAL);

let configs = 0;
const freshConfig = () => (process.env.KRITES_CONFIG_DIR = path.join(tmp, `config${++configs}`));
freshConfig();

const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });

async function ran(options, { spent = false } = {}) {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, options);
  seed(repo);
  if (spent) writeBlockCount(repo, 9);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  await runHook(GATE, stop(repo), { cwd: repo });
  return repo;
}

// The same bytes spelled a second way: the unused bits of the last base64 character.
function sloppy(value) {
  const raw = Buffer.from(value, "base64");
  const at = value.replace(/=+$/, "").length - 1;
  for (const ch of ALPHABET) {
    const candidate = `${value.slice(0, at)}${ch}${value.slice(at + 1)}`;
    if (candidate !== value && Buffer.from(candidate, "base64").equals(raw)) return candidate;
  }
  return null;
}

const runVerifier = (args) => spawnSync(process.execPath, [VERIFIER, ...args], { cwd: tmp, encoding: "utf8", windowsHide: true });

test("receipt: the signing key is created once under KRITES_CONFIG_DIR and reused", () => {
  const dir = freshConfig();
  const file = path.join(dir, KEY_FILE);
  assert.strictEqual(fs.existsSync(dir), false, "the directory is the plugin's to create");

  const first = sign.loadOrCreateKey();
  const pem = fs.readFileSync(file);
  const second = sign.loadOrCreateKey();

  assert.strictEqual(second.public_key, first.public_key, "the second call reads the key it found");
  assert.ok(fs.readFileSync(file).equals(pem), "the key file is left as it was");
  assert.strictEqual(Buffer.from(first.public_key, "base64").length, 32);
  assert.match(sign.fingerprintOf(first.public_key), /^[0-9a-f]{64}$/);

});

test("receipt: the key and the directory that holds it are the owner's alone", (t) => {
  if (!POSIX) return t.skip("win32 has no POSIX file mode, so 0600 and 0700 say nothing there");
  const dir = freshConfig();
  sign.loadOrCreateKey();
  assert.strictEqual(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o777, 0o600, "the key is readable by its owner only");
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, "so is the directory that holds it");
});

test("receipt: a signing key that does not parse is an error and is left in place", () => {
  const dir = freshConfig();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, KEY_FILE);
  fs.writeFileSync(file, "not a key\n");

  assert.throws(
    () => sign.loadOrCreateKey(),
    (err) => {
      assert.doesNotMatch(err.message, ABSOLUTE, "the error names no path");
      return /does not parse/.test(err.message);
    },
  );
  assert.strictEqual(fs.readFileSync(file, "utf8"), "not a key\n", "a key that does not parse is never replaced");
  // The poisoned directory is left as it is, so every test after this one signs somewhere else.
  freshConfig();
});

test("receipt: the two canonical implementations agree, sort every depth and reject what a receipt cannot carry", () => {
  const table = [
    null,
    true,
    false,
    0,
    -1,
    1.5,
    1e21,
    "",
    "a\nb\\c\"d",
    "é☃",
    [],
    [1, [2, { b: 1, a: 2 }]],
    {},
    { b: 1, a: { d: [1, 2], c: null }, A: "x", "0": "zero", "": "empty" },
    { schema: "krites.receipt/0.1", checks: [{ tail: "x", command: "y", exit_code: 0 }], verdict: "passed" },
  ];
  for (const value of table) {
    assert.strictEqual(sign.canonical(value), verifier.canonical(value), JSON.stringify(value));
  }

  assert.strictEqual(sign.canonical({ b: 1, a: { d: 2, c: 3 } }), '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  assert.strictEqual(sign.canonical([2, 1]), "[\n  2,\n  1\n]\n", "arrays keep their order");

  for (const bad of [undefined, NaN, Infinity, new Date(0), new Map(), Symbol("x"), { a: undefined }, [() => {}]]) {
    assert.throws(() => sign.canonical(bad), String(typeof bad));
    assert.throws(() => verifier.canonical(bad), String(typeof bad));
  }
});

test("receipt: nothing to sign without a gate run, and nothing signed after the tree changed", async () => {
  const fresh = makeRepo({ files: { "a.txt": "a\n" } });
  configure(fresh, { commands: [] });
  const none = receipts.build(fresh);
  assert.strictEqual(none.ok, false);
  assert.match(none.reason, /nothing to sign/);

  const repo = await ran({ commands: [script("process.exit(0)")] });
  fs.writeFileSync(path.join(repo, "a.txt"), "changed again\n");
  const stale = receipts.build(repo);
  assert.strictEqual(stale.ok, false);
  assert.match(stale.reason, /tree changed since the last gate run/);
  assert.strictEqual(fs.existsSync(path.join(repo, DIR)), false, "a refusal writes nothing");
});

const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

// The gate writes .krites/last-run.json, and an agent with a shell can rewrite it before the export.
// Every entry has one rule of gateWrote to itself: with that rule deleted, the entry is signed.
const FORGED = [
  ["a verdict the gate never writes", (run) => ({ ...run, verdict: "verified", checks: [{ ...run.checks[0], exit_code: 1 }] })],
  ["a plugin version that is not a string", (run) => ({ ...run, plugin_version: 5 })],
  ["a config hash that is not a string", (run) => ({ ...run, config_hash: 5 })],
  ["a diff that is not an object", (run) => ({ ...run, diff: null })],
  ["a diff whose insertions are not a number", (run) => ({ ...run, diff: { ...run.diff, insertions: "1" } })],
  ["a diff whose deletions are not a number", (run) => ({ ...run, diff: { ...run.diff, deletions: null } })],
  ["a diff whose files are not strings", (run) => ({ ...run, diff: { ...run.diff, files: [1] } })],
  ["a diff count that is not a number", (run) => ({ ...run, diff: { ...run.diff, files_changed: "1" } })],
  ["a check whose command is not a string", (run) => ({ ...run, checks: [{ ...run.checks[0], command: 5 }] })],
  ["a check whose tail is not a string", (run) => ({ ...run, checks: [{ ...run.checks[0], tail: 5 }] })],
  ["a check whose duration is not a number", (run) => ({ ...run, checks: [{ ...run.checks[0], duration_ms: "12" }] })],
  ["an exit code that is not a whole number", (run) => ({ ...run, verdict: "refuted", checks: [{ ...run.checks[0], exit_code: 0.5 }] })],
  ["a failing check under a passing verdict", (run) => ({ ...run, checks: [{ ...run.checks[0], exit_code: 1 }] })],
  ["a passing verdict with no check at all", (run) => ({ ...run, checks: [], commands: [] })],
  ["checks that are not an array", (run) => ({ ...run, checks: 5 })],
  ["a check that is not an object", (run) => ({ ...run, checks: [null] })],
  ["a check whose tail is missing", (run) => ({ ...run, checks: run.checks.map((check) => without(check, "tail")) })],
  ["a missing fingerprint", (run) => without(run, "fingerprint")],
  ["another schema", (run) => ({ ...run, schema: "krites.last-run/9.9" })],
  ["commands that are not arrays of strings", (run) => ({ ...run, commands: ["cargo test"] })],
  ["a diff without its counts", (run) => ({ ...run, diff: { files: [] } })],
  ["a reason that is neither a string nor null", (run) => ({ ...run, reason: 7 })],
  ["a created_at of any length", (run) => ({ ...run, created_at: `${run.created_at}${"0".repeat(300)}` })],
  ["a head that is no object name", (run) => ({ ...run, head: "not-a-hash" })],
  ["a dirty flag that is a string", (run) => ({ ...run, dirty: String(run.dirty) })],
  ["an extra key inside diff", (run) => ({ ...run, diff: { ...run.diff, note: "x" } })],
  ["an extra key inside a check", (run) => ({ ...run, checks: [{ ...run.checks[0], note: "x" }] })],
  ["more checks than commands", (run) => ({ ...run, verdict: "refuted", checks: [run.checks[0], { ...run.checks[0], exit_code: 1 }] })],
  ["passed with fewer checks than commands", (run) => ({ ...run, commands: [...run.commands, ["extra"]] })],
  ["no_checks while commands lists one", (run) => ({ ...run, verdict: "no_checks", checks: [] })],
  ["timed_out with no check", (run) => ({ ...run, verdict: "timed_out", checks: [] })],
  ["timed_out with every exit code 0", (run) => ({ ...run, verdict: "timed_out" })],
  [
    "a check that failed before the last one",
    (run) => ({ ...run, verdict: "refuted", commands: [...run.commands, ["extra"]], checks: [{ ...run.checks[0], exit_code: 1 }, { ...run.checks[0], exit_code: 1 }] }),
  ],
  [
    "timed_out with a check that failed before the last one",
    (run) => ({ ...run, verdict: "timed_out", commands: [...run.commands, ["extra"]], checks: [{ ...run.checks[0], exit_code: 1 }, { ...run.checks[0], exit_code: null }] }),
  ],
  ["refuted with a check that passed", (run) => ({ ...run, verdict: "refuted" })],
  ["refuted with neither a check nor a reason", (run) => ({ ...run, verdict: "refuted", checks: [], reason: null })],
  ["a passing verdict that carries a reason", (run) => ({ ...run, reason: "every check was fine" })],
  ["no_checks that carries a reason", (run) => ({ ...run, verdict: "no_checks", checks: [], commands: [], reason: "nothing to do" })],
  ["a check-refuted run with no reason", (run) => ({ ...run, verdict: "refuted", checks: [{ ...run.checks[0], exit_code: 1 }], reason: null })],
  ["a timed-out run with no reason", (run) => ({ ...run, verdict: "timed_out", checks: [{ ...run.checks[0], exit_code: null }], reason: null })],
  ["a diff count that is not the number of files", (run) => ({ ...run, diff: { ...run.diff, files_changed: run.diff.files.length + 1 } })],
  ["a diff count that is not a whole number", (run) => ({ ...run, diff: { ...run.diff, insertions: 1.5 } })],
  ["insertions in a diff that changed no file", (run) => ({ ...run, diff: { files_changed: 0, files: [], insertions: 500, deletions: 0 } })],
  ["a file listed twice", (run) => ({ ...run, diff: { ...run.diff, files_changed: 2, files: ["a.txt", "a.txt"] } })],
  ["slow commands that are not arrays of strings", (run) => ({ ...run, slow: ["cargo test"] })],
  ["an env that is not a list of strings", (run) => ({ ...run, env: [5] })],
  ["passed with a slow check that has no exit code", (run) => ({ ...run, slow: [["slow"]], checks: [...run.checks, { ...run.checks[0], exit_code: null }] })],
  ["more checks than commands and slow together", (run) => ({ ...run, slow: [["slow"]], checks: [run.checks[0], run.checks[0], run.checks[0]] })],
  ["passed with only some of the slow checks run", (run) => ({ ...run, slow: [["b"], ["c"]], checks: [run.checks[0], run.checks[0]] })],
  ["no_checks with a slow check that ran",(run) => ({ ...run, verdict: "no_checks", commands: [], slow: [["slow"]] })],
];

// Every shape the gate and /krites:verify really write, so tightening gateWrote cannot refuse a true run.
async function realRuns() {
  const hang = "setTimeout(() => {}, 30000);";
  const protectedRepo = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } });
  configure(protectedRepo, { commands: [script("process.exit(0)")], globs: ["secrets/**"] });
  seed(protectedRepo);
  fs.writeFileSync(path.join(protectedRepo, "secrets", "rule.md"), "weakened\n");
  await runHook(GATE, stop(protectedRepo), { cwd: protectedRepo });

  const fresh = makeRepo({ files: { "a.txt": "a\n", "krites.toml": toml({ commands: [script("process.exit(0)")] }) }, commit: false });
  seed(fresh);
  await runHook(GATE, stop(fresh), { cwd: fresh });

  const outer = makeRepo({ files: { "a.txt": "a\n" } });
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "krites.toml"), toml({ commands: [script("process.exit(0)")] }));
  fs.writeFileSync(path.join(inner, "b.txt"), "b\n");
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "config");
  seed(inner, outer);
  fs.writeFileSync(path.join(inner, "b.txt"), "changed\n");
  await runHook(GATE, stop(inner), { cwd: inner });

  const noId = makeRepo({ files: { "a.txt": "a\n" } });
  configure(noId, { commands: [script("process.exit(0)")] });
  seed(noId);
  fs.writeFileSync(path.join(noId, "a.txt"), "changed\n");
  await runHook(GATE, { hook_event_name: "Stop", stop_hook_active: false, cwd: noId }, { cwd: noId });

  const verified = makeRepo({ files: { "a.txt": "a\n" } });
  configure(verified, { commands: [script("console.log('out')"), script("process.exit(4)")], timeoutSeconds: 60 });
  seed(verified);
  await runCli(["verify"], { cwd: verified });

  const emptied = makeRepo({ files: { "a.txt": "a\n" } });
  configure(emptied, { commands: [], timeoutSeconds: 60 });
  seed(emptied);
  await runCli(["verify"], { cwd: emptied });

  const slowRan = makeRepo({ files: { "a.txt": "a\n" } });
  configure(slowRan, { commands: [script("process.exit(0)")], slow: [script("process.exit(0)")], timeoutSeconds: 60 });
  seed(slowRan);
  await runCli(["verify"], { cwd: slowRan });

  const onlySlow = makeRepo({ files: { "a.txt": "a\n" } });
  configure(onlySlow, { commands: [], slow: [script("process.exit(0)")], timeoutSeconds: 60 });
  seed(onlySlow);
  await runCli(["verify"], { cwd: onlySlow });

  return [
    ["passed, from the gate", await ran({ commands: [script("console.log('fine')")] }), "passed"],
    ["refuted by a check", await ran({ commands: [script("console.log('boom'); process.exit(1)")] }), "refuted"],
    ["refuted by a protected path", protectedRepo, "refuted"],
    ["timed out", await ran({ commands: [script(hang)], timeoutSeconds: 1 }), "timed_out"],
    ["no_checks", await ran({ commands: [] }), "no_checks"],
    ["the attempt budget exhausted", await ran({ commands: [script("process.exit(1)")] }, { spent: true }), "refuted"],
    ["a repo with no commits", fresh, "passed"],
    ["a root below the git toplevel", inner, "passed"],
    ["a payload with no session id", noId, "passed"],
    ["refuted under /krites:verify", verified, "refuted"],
    ["no_checks under /krites:verify", emptied, "no_checks"],
    ["passed at a stop with a slow check not run", await ran({ commands: [script("process.exit(0)")], slow: [script("process.exit(0)")] }), "passed"],
    ["no_checks at a stop with only a slow check", await ran({ commands: [], slow: [script("process.exit(0)")] }), "no_checks"],
    ["passed under /krites:verify with the slow check", slowRan, "passed"],
    ["passed under /krites:verify with only a slow check", onlySlow, "passed"],
  ];
}

test("receipt: every run the gate and /krites:verify really write is signed and accepted", { timeout: 180000 }, async () => {
  for (const [label, repo, verdict] of await realRuns()) {
    const run = JSON.parse(fs.readFileSync(path.join(repo, LAST_RUN), "utf8"));
    assert.strictEqual(run.verdict, verdict, `${label}: the run under test`);

    const built = receipts.build(repo);
    assert.strictEqual(built.ok, true, `${label}: ${built.reason}`);
    const written = receipts.write(repo, built.receipt, DIR);
    const checked = runVerifier([path.join(repo, written.json)]);
    assert.strictEqual(checked.status, 0, `${label}: ${checked.stdout}${checked.stderr}`);
    assert.ok(checked.stdout.startsWith(`valid: signed by `), `${label}: ${checked.stdout}`);
    assert.ok(checked.stdout.includes(`verdict ${verdict}${UNPINNED}`), `${label}: ${checked.stdout}`);
  }
});

test("receipt: only a run the gate could have written is signed", async () => {
  const repo = await ran({ commands: [script("process.exit(0)")] });
  const file = path.join(repo, LAST_RUN);
  const recorded = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(receipts.build(repo).ok, true, "a well-formed run still signs");

  for (const [label, forge] of FORGED) {
    fs.writeFileSync(file, `${JSON.stringify(forge(recorded), null, 2)}\n`);
    const built = receipts.build(repo);
    assert.strictEqual(built.ok, false, label);
    assert.strictEqual(built.reason, NOT_THE_GATE, label);
  }

  fs.writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);
  assert.strictEqual(receipts.build(repo).ok, true, "the run the gate wrote is signed again");
  assert.strictEqual(fs.existsSync(path.join(repo, DIR)), false, "a refusal writes nothing");
});

test("receipt: a clock that steps back during a check leaves no negative duration, and the run still signs", async () => {
  const { runChecks } = require("../lib/checks.js");
  const real = Date.now;
  let tick = real();
  let out;
  try {
    // Every reading lands a second before the last one, which is what a clock correction looks like mid-check.
    Date.now = () => (tick -= 1000);
    out = await runChecks({ commands: [script("process.exit(0)")], root: tmp, deadlineMs: 30000 });
  } finally {
    Date.now = real;
  }
  assert.strictEqual(out.checks[0].duration_ms, 0, "a check that ends before it started took no time, not less than none");

  const repo = await ran({ commands: [script("process.exit(0)")] });
  const file = path.join(repo, LAST_RUN);
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  run.checks[0].duration_ms = out.checks[0].duration_ms;
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  const built = receipts.build(repo);
  assert.strictEqual(built.ok, true, built.reason);
});

test("receipt: the verifier takes only the shape write() produces", async () => {
  const repo = await ran({ commands: [script("process.exit(0)")] });
  const built = receipts.build(repo);
  const of = (receipt) => Buffer.from(sign.canonical(receipt), "utf8");

  const extra = verifier.check(of({ ...built.receipt, signature: { ...built.receipt.signature, note: "trust me" } }), null);
  assert.strictEqual(extra.ok, false, "an unsigned key alongside alg, public_key and sig");
  assert.match(extra.line, /^invalid: /);

  for (const verdict of ["verified", "passed\u001b[2K\u001b[1Gvalid", { word: "passed" }, null, 5, "PASSED"]) {
    const line = verifier.check(of({ ...built.receipt, verdict }), null).line;
    assert.strictEqual(line, "invalid: the verdict is not one Krites writes", JSON.stringify(verdict));
  }

  for (const body of ["null\n", "5\n", "[]\n", '"x"\n']) {
    const result = verifier.check(Buffer.from(body, "utf8"), null);
    assert.strictEqual(result.ok, false, body);
    assert.match(result.line, /^invalid: /, body);

    const file = path.join(tmp, `not-a-receipt${Buffer.from(body).toString("hex")}.json`);
    fs.writeFileSync(file, body);
    const spawned = runVerifier([file]);
    assert.strictEqual(spawned.status, 1, body);
    assert.strictEqual(spawned.stderr, "", body);
    assert.deepStrictEqual(spawned.stdout.split("\n").length, 2, `${body}: exactly one line`);
  }
});

test("receipt: a run signed right after the gate verifies, and a second export is byte-identical", async () => {
  const repo = await ran({ commands: [script("console.log('fine')")] });
  const built = receipts.build(repo);
  assert.strictEqual(built.ok, true, built.reason);
  const run = JSON.parse(fs.readFileSync(path.join(repo, LAST_RUN), "utf8"));
  assert.strictEqual(built.receipt.schema, "krites.receipt/0.3");
  assert.strictEqual(built.receipt.verdict, "passed");
  assert.strictEqual(built.receipt.created_at, run.created_at);
  assert.strictEqual(built.receipt.tree_fingerprint, run.fingerprint, "the tree state the gate recorded");
  assert.strictEqual("fingerprint" in built.receipt, false, "no field a reader could pass to --key");

  const where = receipts.write(repo, built.receipt, DIR);
  const json = fs.readFileSync(path.join(repo, where.json));
  const md = fs.readFileSync(path.join(repo, where.md), "utf8");
  assert.ok(Buffer.from(sign.canonical(built.receipt), "utf8").equals(json), "the file holds exactly the canonical bytes");
  assert.strictEqual(verifier.check(json, null).ok, true, verifier.check(json, null).line);

  receipts.write(repo, built.receipt, DIR);
  assert.ok(fs.readFileSync(path.join(repo, where.json)).equals(json), "exporting twice gives the same JSON bytes");
  assert.strictEqual(fs.readFileSync(path.join(repo, where.md), "utf8"), md, "and the same Markdown");

  // The signature is base64 of random bytes, where about one key in 3000 opens with "//" and reads as a UNC share.
  assert.doesNotMatch(textOf(without(JSON.parse(json.toString("utf8")), "signature")), ABSOLUTE, "no absolute path in the receipt");
  assert.doesNotMatch(md, ABSOLUTE, "no absolute path in the Markdown");
  assert.ok(md.includes(sign.fingerprintOf(built.receipt.signature.public_key)), "the key fingerprint is in the footer");

  const body = { ...built.receipt };
  delete body.signature;
  assert.strictEqual(sign.verify(body, built.receipt.signature), true);
  assert.strictEqual(sign.verify({ ...body, verdict: "refuted" }, built.receipt.signature), false);
});

test("receipt: a refuted, a no_checks and an exhausted run each keep their verdict and reason", async () => {
  const cases = [
    [await ran({ commands: [script("console.log('boom'); process.exit(1)")] }), "refuted", /Krites refuted the stop/],
    [await ran({ commands: [] }), "no_checks", null],
    [await ran({ commands: [script("process.exit(1)")] }, { spent: true }), "refuted", /^attempt budget exhausted$/],
  ];
  for (const [repo, verdict, reason] of cases) {
    const built = receipts.build(repo);
    assert.strictEqual(built.ok, true, `${verdict}: ${built.reason}`);
    assert.strictEqual(built.receipt.verdict, verdict);
    if (reason === null) assert.strictEqual(built.receipt.reason, null, verdict);
    else assert.match(built.receipt.reason, reason);

    const where = receipts.write(repo, built.receipt, DIR);
    const json = fs.readFileSync(path.join(repo, where.json));
    assert.strictEqual(verifier.check(json, null).ok, true, verdict);
    assert.ok(verifier.check(json, null).line.endsWith(`verdict ${verdict}${UNPINNED}`), verdict);
    assert.doesNotMatch(fs.readFileSync(path.join(repo, where.md), "utf8"), ABSOLUTE, `no absolute path in the ${verdict} Markdown`);
  }
});

test("receipt: every single-byte change to a receipt is rejected", async () => {
  const repo = await ran({ commands: [script("console.log('fine')")] });
  const built = receipts.build(repo);
  const bytes = fs.readFileSync(path.join(repo, receipts.write(repo, built.receipt, DIR).json));
  assert.strictEqual(verifier.check(bytes, null).ok, true);
  assert.ok(bytes.length > 500, `a whole receipt is swept, not a stub (${bytes.length} bytes)`);
  assert.ok(Buffer.from(sign.canonical(JSON.parse(bytes.toString("utf8"))), "utf8").equals(bytes), "re-serializing gives the file's bytes");

  for (let i = 0; i < bytes.length; i += 1) {
    const flipped = Buffer.from(bytes);
    flipped[i] ^= 0x01;
    assert.notStrictEqual(flipped[i], bytes[i], `byte ${i} really changed`);
    assert.strictEqual(verifier.check(flipped, null).ok, false, `byte ${i} of ${bytes.length}`);
  }

  const compact = Buffer.from(JSON.stringify(JSON.parse(bytes.toString("utf8"))), "utf8");
  assert.strictEqual(verifier.check(compact, null).ok, false, "the same content spelled differently is not the receipt");
});

test("receipt: base64 that does not round-trip is rejected", async () => {
  const repo = await ran({ commands: [script("process.exit(0)")] });
  const built = receipts.build(repo);
  const of = (change) => Buffer.from(sign.canonical({ ...built.receipt, signature: { ...built.receipt.signature, ...change } }), "utf8");

  for (const field of ["public_key", "sig"]) {
    const other = sloppy(built.receipt.signature[field]);
    assert.ok(other !== null, `${field} has a second spelling`);
    assert.ok(Buffer.from(other, "base64").equals(Buffer.from(built.receipt.signature[field], "base64")), `${field} decodes the same`);
    const result = verifier.check(of({ [field]: other }), null);
    assert.strictEqual(result.ok, false, field);
    assert.match(result.line, /base64/);
  }

  assert.strictEqual(verifier.check(of({ sig: Buffer.alloc(63).toString("base64") }), null).ok, false, "a 63-byte signature");
  assert.strictEqual(verifier.check(of({ public_key: Buffer.alloc(33).toString("base64") }), null).ok, false, "a 33-byte key");
  assert.strictEqual(verifier.check(of({ alg: "rsa" }), null).ok, false, "another algorithm");
  assert.strictEqual(verifier.check(of({ sig: 7 }), null).ok, false, "a signature that is not a string");
});

test("receipt: the verifier prints one line with exit 0 or 1, and --key pins the signer", async () => {
  const repo = await ran({ commands: [script("process.exit(0)")] });
  const built = receipts.build(repo);
  const file = path.join(repo, receipts.write(repo, built.receipt, DIR).json);
  const fingerprint = sign.fingerprintOf(built.receipt.signature.public_key);

  const runs = [
    [[file], 0, /^valid: signed by [0-9a-f]{64}, verdict passed, signer not pinned \(pass --key\)$/],
    [["--key", fingerprint, file], 0, /^valid: signed by [0-9a-f]{64}, verdict passed$/],
    [["--key", fingerprint.slice(0, 16), file], 0, /^valid: signed by [0-9a-f]{64}, verdict passed$/],
    [["--key", fingerprint.toUpperCase(), file], 0, /^valid: signed by [0-9a-f]{64}, verdict passed$/],
    [["--key", "0".repeat(64), file], 1, /^invalid: /],
    [["--key", fingerprint.slice(0, 15), file], 1, /^invalid: /],
    [["--key", file], 1, /^invalid: /],
    [[], 1, /^invalid: /],
    [[file, file], 1, /^invalid: /],
    [[path.join(repo, DIR, "missing.json")], 1, /^invalid: /],
  ];
  for (const [args, code, line] of runs) {
    const result = runVerifier(args);
    assert.strictEqual(result.status, code, `${JSON.stringify(args.map((a) => (a === file ? "<file>" : a)))}: exit ${code}`);
    assert.strictEqual(result.stderr, "", "nothing on stderr");
    const lines = result.stdout.split("\n");
    assert.strictEqual(lines.length, 2, "exactly one line, newline terminated");
    assert.strictEqual(lines[1], "");
    assert.match(lines[0], line);
    assert.doesNotMatch(lines[0], ABSOLUTE, "no absolute path in the verifier's output");
  }
});

test("receipt: a krites.receipt/0.1 receipt still verifies, pinned to the key that signed it", () => {
  const file = path.join(__dirname, "fixtures", "receipt-0.1.json");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(old.schema, "krites.receipt/0.1");
  assert.ok("fingerprint" in old && !("tree_fingerprint" in old), "the 0.1 shape");
  const result = runVerifier(["--key", "6b11164d362ea9b5", file]);
  assert.strictEqual(result.status, 0, result.stdout);
  assert.strictEqual(result.stdout, "valid: signed by 6b11164d362ea9b5c7711d8f5465d76c7d6da068a55f9b4253bd697171978bfa, verdict passed\n");
});

test("receipt: nothing was written under the real user config directory", () => {
  assert.strictEqual(listing(REAL), REAL_BEFORE, "the tests write only under the OS temp directory");
});

test("receipt: every configured check that did not run is listed as not run", async () => {
  const slow = script("process.exit(0)");
  const stopped = await ran({ commands: [script("process.exit(0)")], slow: [slow] });
  const built = receipts.build(stopped);
  assert.strictEqual(built.ok, true, built.reason);
  assert.strictEqual(built.receipt.verdict, "passed");
  assert.deepStrictEqual(built.receipt.not_run, [built.receipt.slow[0].join(" ")]);
  assert.strictEqual(built.receipt.checks.length, 1);
  const where = receipts.write(stopped, built.receipt, DIR);
  assert.strictEqual(verifier.check(fs.readFileSync(path.join(stopped, where.json)), null).ok, true);
  const md = fs.readFileSync(path.join(stopped, where.md), "utf8");
  assert.match(md, /\| `node [^|`]*check\d+\.js` \| not run \| \|\n/);
  assert.match(md, /\nEnv: none\n/);

  const verified = makeRepo({ files: { "a.txt": "a\n" } });
  configure(verified, { commands: [script("process.exit(0)")], slow: [slow], timeoutSeconds: 60 });
  seed(verified);
  await runCli(["verify"], { cwd: verified });
  assert.deepStrictEqual(receipts.build(verified).receipt.not_run, []);

  const refuted = await ran({ commands: [script("process.exit(1)"), script("process.exit(0)")], slow: [slow] });
  const failed = receipts.build(refuted).receipt;
  assert.strictEqual(failed.verdict, "refuted");
  assert.deepStrictEqual(failed.not_run, [failed.commands[1].join(" "), failed.slow[0].join(" ")]);
});

test("receipt: env comes from the run file scrubbed, and a run file without it signs with none", async () => {
  const repo = await ran({ commands: [script("process.exit(0)")] });
  const file = path.join(repo, LAST_RUN);
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(receipts.build(repo).receipt.env, []);

  fs.writeFileSync(file, `${JSON.stringify(without(without(run, "env"), "slow"), null, 2)}\n`);
  const older = receipts.build(repo);
  assert.strictEqual(older.ok, true, older.reason);
  assert.deepStrictEqual([older.receipt.env, older.receipt.slow, older.receipt.not_run], [[], [], []]);

  fs.writeFileSync(file, `${JSON.stringify({ ...run, env: ["GOTOOLCHAIN=go1.26.6", "API_TOKEN=sk-abcdefghijklmnopqrstuvwxyz0123"] }, null, 2)}\n`);
  const built = receipts.build(repo);
  assert.deepStrictEqual(built.receipt.env, ["GOTOOLCHAIN=go1.26.6", "API_TOKEN=<redacted>"]);
  const where = receipts.write(repo, built.receipt, DIR);
  assert.match(fs.readFileSync(path.join(repo, where.md), "utf8"), /\nEnv: `GOTOOLCHAIN=go1\.26\.6`\nEnv: `API_TOKEN=<redacted>`\n/);
});

const rendered = (fields) => {
  const receipt = {
    verdict: "failed",
    reason: null,
    checks: [],
    not_run: [],
    env: [],
    diff: { files_changed: 0, insertions: 0, deletions: 0 },
    repo: { head: "abcdef0123" },
    created_at: "2026-09-24T00:00:00Z",
    config_hash: "c",
    signature: { public_key: "AAAA" },
    ...fields,
  };
  return fs.readFileSync(path.join(tmp, receipts.write(tmp, receipt, "md-escape").md), "utf8");
};
const rowsOf = (md) => md.split("\n").filter((line) => line.startsWith("|")).slice(2);

test("receipt: run content cannot break the Markdown table or add lines", () => {
  const md = rendered({
    checks: [{ command: "echo a|b\n# x ```y", exit_code: 1, duration_ms: 5 }],
    not_run: ["`tick`"],
    env: ["A=1,2", "B=3|4"],
  });
  assert.deepStrictEqual(rowsOf(md), ["| ````echo a\\|b # x ```y```` | 1 | 5 |", "| `` `tick` `` | not run | |"]);
  assert.match(md, /\nConfig hash: `c`\nEnv: `A=1,2`\nEnv: `B=3\|4`\n/, "no cell escape outside the table");
});

test("receipt: the Markdown reason is its first line only, in a code span", () => {
  const md = rendered({ reason: "Krites refuted the stop: npm test\n| fake | row |\nVerdict: passed\n<img src=x>" });
  assert.match(md, /\nReason: `Krites refuted the stop: npm test`\n\n/);
  assert.doesNotMatch(md, /fake|<img/);
  assert.strictEqual(md.match(/^Verdict:/gm).length, 1);
  assert.deepStrictEqual(rowsOf(md), ["| none ran | | |"]);
  assert.match(rendered({}), /\nReason: none\n/);
});

test("receipt: code spans survive edge backticks, empty text and every control character", () => {
  const cases = {
    "a`": "`` a` ``",
    "```": "```` ``` ````",
    "": "` `",
    "a\rb\tc\x7fd\x85e\x9ff\u2028g\u2029h": "`a b c d e f g h`",
  };
  const md = rendered({ not_run: Object.keys(cases) });
  assert.deepStrictEqual(rowsOf(md), Object.values(cases).map((span) => `| ${span} | not run | |`));
});

test("receipt: a stop on the tree /krites:verify passed has nothing not run, and an edit in between lists slow", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")], slow: [script("process.exit(0)")], timeoutSeconds: 60 });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  await runCli(["verify"], { cwd: repo });
  const verified = receipts.build(repo).receipt;
  await runHook(GATE, stop(repo), { cwd: repo });
  const carried = receipts.build(repo);
  assert.strictEqual(carried.ok, true, carried.reason);
  assert.deepStrictEqual(carried.receipt.not_run, []);
  assert.deepStrictEqual(carried.receipt.checks.slice(1), verified.checks.slice(1));

  await runCli(["verify"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "edited again\n");
  await runHook(GATE, stop(repo), { cwd: repo });
  const edited = receipts.build(repo).receipt;
  assert.deepStrictEqual(edited.not_run, [edited.slow[0].join(" ")]);
});

test("receipt: only a passed verify run with every check whole and at exit 0 is carried into a stop", async () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")], slow: [script("process.exit(0)")], timeoutSeconds: 60 });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  await runCli(["verify"], { cwd: repo });
  const file = path.join(repo, LAST_RUN);
  const verified = JSON.parse(fs.readFileSync(file, "utf8"));
  const [first, second] = verified.checks;
  const cases = [
    ["a timed-out slow check", { checks: [first, { ...second, exit_code: null }] }],
    ["a slow check without duration_ms", { checks: [first, without(second, "duration_ms")] }],
    ["a slow check with an extra key", { checks: [first, { ...second, extra: 1 }] }],
    ["a slow check with a text duration", { checks: [first, { ...second, duration_ms: "5" }] }],
    ["a failed command before the slow check", { checks: [{ ...first, exit_code: 1 }, second] }],
    ["a run that is not passed", { verdict: "refuted", reason: "no" }],
  ];
  for (const [name, change] of cases) {
    fs.writeFileSync(file, `${JSON.stringify({ ...verified, ...change }, null, 2)}\n`);
    await runHook(GATE, stop(repo), { cwd: repo });
    const built = receipts.build(repo);
    assert.strictEqual(built.ok, true, `${name}: ${built.reason}`);
    assert.strictEqual(built.receipt.checks.length, 1, name);
    assert.deepStrictEqual(built.receipt.not_run, [built.receipt.slow[0].join(" ")], name);
  }
});
