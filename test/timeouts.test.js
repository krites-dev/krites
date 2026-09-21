const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { BUDGET_MS, WATCHDOG_MS } = require("../hooks/gate.js");
const { loadConfig } = require("../lib/config.js");
const { STDIN_DEADLINE_MS } = require("../lib/hookio.js");
const { makeDir } = require("./helpers.js");

const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hooks", "hooks.json"), "utf8")).hooks;
const timeoutOf = (event) => hooks[event][0].hooks[0].timeout;

const accepts = (seconds) => loadConfig(makeDir({ "krites.toml": `version = 1\n\n[checks]\ntimeout_seconds = ${seconds}\n` })).ok;

test("timeouts: the Stop hook gets 900 s and the budget leaves a real margin under it", () => {
  const stop = timeoutOf("Stop");
  const ceiling = 820;
  assert.strictEqual(stop, 900);
  assert.ok(accepts(ceiling), `${ceiling} s is the highest gate deadline a repo may configure`);
  assert.ok(!accepts(ceiling + 1), "anything above the ceiling is a config error");
  assert.strictEqual(BUDGET_MS, ceiling * 1000, "every root of one run shares the config ceiling");
  // A timer cannot pre-empt a synchronous git call or a hash, so the margin has to be real time, not a watchdog promise.
  assert.ok(stop * 1000 - BUDGET_MS >= 60000, `the gate has ${stop * 1000 - BUDGET_MS} ms of slack for git, hashing and the kill`);
  assert.ok(BUDGET_MS < WATCHDOG_MS && WATCHDOG_MS < stop * 1000, `budget ${BUDGET_MS} < watchdog ${WATCHDOG_MS} < hook timeout ${stop * 1000}`);
});

test("timeouts: the fast hooks get 10 s, above the deadline their input reader uses", () => {
  assert.strictEqual(timeoutOf("SessionStart"), 10);
  assert.strictEqual(timeoutOf("PreToolUse"), 10);
  assert.ok(STDIN_DEADLINE_MS / 1000 <= 5, "the stdin deadline answers well inside the 10 s hook timeout");
});

test("timeouts: the Stop entry runs gate.js and SessionStart matches startup only", () => {
  assert.deepStrictEqual(hooks.Stop[0].hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/hooks/gate.js"]);
  assert.deepStrictEqual(hooks.SessionStart[0].hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/hooks/session.js"]);
  assert.strictEqual(hooks.SessionStart[0].matcher, "startup");
});
