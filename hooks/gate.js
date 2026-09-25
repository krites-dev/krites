const { runChecks } = require("../lib/checks.js");
const { DEFAULT_MAX_BLOCKS, findRoots, loadConfig, protectedGlobs } = require("../lib/config.js");
const { matches } = require("../lib/glob.js");
const hookio = require("../lib/hookio.js");
const ping = require("../lib/ping.js");
const { wellFormed } = require("../lib/receipt.js");
const { scrub } = require("../lib/scrub.js");
const state = require("../lib/state.js");

const VERSION = require("../.claude-plugin/plugin.json").version;
const ADVICE = "Fix it and let the checks run before stopping. Do not describe results; the gate reads them.";
const APPROVE = "If you changed it yourself, run /krites:init to approve it.";
const EXHAUSTED = "attempt budget exhausted";
const UNLISTED = "could not list the changed paths, so no check can be trusted";
const UNWRITABLE = (code) =>
  `Krites could not record this attempt: .krites/block-count cannot be written (${code}). The gate keeps blocking until that is fixed.`;
// The watchdog cannot pre-empt a synchronous git call or a hash, so the real margin is the 80 s the budget leaves.
const BUDGET_MS = 820000;
const WATCHDOG_MS = 880000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STARTED = Date.now();
// Per hook run: the count each root had before its checks ran, what it was charged, and the root being judged,
// which owns a watchdog or a crash on its watch.
const counted = new Map();
const charged = new Map();
const unwritable = new Map();
// What this run holds so far. The watchdog and the fail path read it too: they must never allow a stop it would block.
const heldReasons = [];
let current = null;
let timedOut = false;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const budgetMs = (elapsedMs, seconds, totalMs = BUDGET_MS) => Math.max(0, Math.min(seconds * 1000, totalMs - elapsedMs));

// Every block spends one attempt from the root's budget; once it is spent the stop is allowed, so no chain of stops blocks without end.
// One answer per root per hook run: a throw after the spend reaches the fail path, which must not charge the same block again.
function spend(root, maxBlocks) {
  if (charged.has(root)) return charged.get(root);
  // A check can wipe .krites (git clean -fdx), so the count taken before the checks ran is the one that goes up.
  const count = counted.has(root) ? counted.get(root) : state.readBlockCount(root);
  try {
    state.writeBlockCount(root, count + 1);
    charged.set(root, count >= maxBlocks);
  } catch (err) {
    // An attempt that cannot be recorded bounds nothing, so the block stands and the reason says which file gave way.
    unwritable.set(root, err.code || err.name);
    charged.set(root, false);
  }
  return charged.get(root);
}

const named = (root, reason) => (unwritable.has(root) ? `${reason}\n${UNWRITABLE(unwritable.get(root))}` : reason);

const bounded = (root, maxBlocks, reason) => (spend(root, maxBlocks) ? null : named(root, reason));

// A block that spends no attempt never ends on its own, so it is held instead of answered: the roots behind it
// are still judged, and the held reason is part of whatever the loop answers.
const answer = (reason, held = false) => (reason === null ? null : { reason, held });

// A block outside any root's own verdict goes to the root being judged, or to every root in reach when none is.
// It is never spread over roots that passed or were not reached: their budgets are theirs.
function boundedByAll(reason, { cwd, projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
  try {
    const owners = current ? [current] : findRoots({ cwd, projectDir });
    let left = owners.length === 0;
    for (const entry of owners) {
      const loaded = entry.error ? { ok: false } : loadConfig(entry.root);
      if (!spend(entry.root, loaded.ok ? loaded.config.checks.max_blocks : DEFAULT_MAX_BLOCKS)) left = true;
    }
    const gaveWay = owners.find((entry) => unwritable.has(entry.root));
    const own = left ? [gaveWay ? named(gaveWay.root, reason) : reason] : [];
    return own.length + heldReasons.length === 0 ? null : [...own, ...heldReasons].join("\n");
  } catch {
    return [reason, ...heldReasons].join("\n");
  }
}

async function gateRoot(entry, payload, budget) {
  counted.set(entry.root, state.readBlockCount(entry.root));
  const loaded = entry.error ? { ok: false, error: entry.error } : loadConfig(entry.root);
  // A config the gate cannot read judges nothing, so it is no attempt: it spends nothing and blocks until it is fixed.
  if (!loaded.ok) return answer(scrub(`Krites blocked the stop: ${loaded.error}`, entry.root), true);
  try {
    const blocked = await runRoot(entry.root, loaded, payload, budget);
    return blocked === null ? null : answer(scrub(blocked.reason, entry.root), blocked.held);
  } catch (err) {
    // A crash inside one root is that root's block, so it ends with that root's budget and the next root is still judged.
    return answer(bounded(entry.root, loaded.config.checks.max_blocks, `Krites blocked the stop: the gate hook failed (${err.code || err.name}). ${ADVICE}`));
  }
}

function treeState(root) {
  const head = (state.git(root, ["rev-parse", "HEAD"]) || "").trim();
  const status = state.git(root, ["status", "--porcelain", "--untracked-files=normal"]);
  return { head, dirty: status === null || status.trim() !== "", baseline: state.readBaseline(root) };
}

// The whole judgement, shared with /krites:verify: the bypass check, the checks between two fingerprints, and the reason.
// `failed` is a clause the caller words for its own event; every other field is what the caller records.
async function judge(root, loaded, { baseline, deadline, commands = loaded.config.checks.commands }) {
  const config = loaded.config;
  // The directory and its .gitignore land before the first fingerprint, so the gate's own writes never change it.
  state.ensureDir(root);
  const before = state.fingerprint(root);
  const changed = state.changedPaths(root, baseline);
  if (changed === null) return { failed: UNLISTED };

  const globs = protectedGlobs(config);
  const record = state.readConfigHash(root);
  // Only a recorded hash can excuse the root's own krites.toml, which git reports as untracked right after /krites:init.
  const configChanged = record === null ? baseline !== null : record !== loaded.hash;
  const candidates = record === null ? changed : changed.filter((rel) => rel !== "krites.toml");
  const touched = configChanged ? "krites.toml" : candidates.find((rel) => globs.some((glob) => matches(glob, rel)));
  const deadlineMs = deadline();
  const run = touched ? { verdict: "refuted", checks: [], failed: null } : await runChecks({ commands, env: config.checks.env, root, deadlineMs });

  if (state.fingerprint(root) !== before) return { failed: "the tree changed while the gate ran, so the checks say nothing" };
  const reason =
    run.verdict === "passed" || run.verdict === "no_checks"
      ? null
      : touched
        ? `Krites refuted the stop: protected path changed: ${touched}. ${touched === "krites.toml" ? APPROVE : ADVICE}`
        : run.verdict === "timed_out"
          ? `Krites blocked the stop: gate timed out after ${Math.round(deadlineMs / 1000)} s while running ${run.failed.command}. ${ADVICE}`
          : `Krites refuted the stop: ${run.failed.command}\n${run.failed.tail}\n${ADVICE}`;
  return { run, reason, touched, deadlineMs, before, record };
}

// Only a whole, clean pass is carried: a carried failure would contradict the stop's own passed verdict.
function carriedSlow(root, loaded, judged) {
  const { commands, slow } = loaded.config.checks;
  if (judged.run.verdict !== "passed" || judged.run.checks.length !== commands.length || slow.length === 0) return [];
  const previous = state.readLastRun(root);
  if (!previous || previous.verdict !== "passed" || previous.fingerprint !== judged.before || previous.config_hash !== loaded.hash) return [];
  const checks = previous.checks;
  if (!Array.isArray(checks) || checks.length !== commands.length + slow.length) return [];
  return checks.every((check) => wellFormed(check) && check.exit_code === 0) ? checks.slice(commands.length) : [];
}

function recordRun(root, loaded, judged, { head, dirty, baseline, reason, session_id: sessionId }) {
  state.writeLastRun(root, {
    schema: "krites.last-run/0.1",
    plugin_version: VERSION,
    created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    root_hash: state.sha256(root),
    head,
    dirty,
    fingerprint: judged.before,
    config_hash: loaded.hash,
    commands: loaded.config.checks.commands,
    slow: loaded.config.checks.slow,
    env: Object.entries(loaded.config.checks.env).map(([name, value]) => `${name}=${value}`),
    diff: state.diffStat(root, baseline),
    checks: [...judged.run.checks, ...carriedSlow(root, loaded, judged)],
    verdict: judged.run.verdict,
    reason,
    session_id: sessionId,
  });

  if (judged.run.verdict === "passed") {
    state.writeBaseline(root, head);
    // A root the session never saw gets its record here, so its next stop is not refuted for a config nobody edited.
    if (judged.record === null && loaded.hash !== undefined) state.writeConfigHash(root, loaded.hash);
    // Last, so a pass that cannot be recorded keeps its count and ends with the budget instead of blocking forever.
    state.writeBlockCount(root, 0);
  }
}

async function runRoot(root, loaded, payload, budget) {
  const { timeout_seconds: seconds, max_blocks: maxBlocks } = loaded.config.checks;
  const { head, dirty, baseline } = treeState(root);
  if (!dirty && baseline !== null && baseline === head) {
    // A clean tree at the baseline holds nothing the blocks were about, so the attempts go back.
    try {
      if (counted.get(root) !== 0) state.writeBlockCount(root, 0);
    } catch {
      // A skip never blocks, so a reset it cannot write is nothing to answer for.
    }
    return null;
  }

  const deadline = () => budgetMs(Date.now() - budget.startedAt, seconds, budget.totalMs);
  const judged = await judge(root, loaded, { baseline, deadline });
  if (judged.failed) {
    const reason = `Krites blocked the stop: ${judged.failed}. ${ADVICE}`;
    // Git could not say what changed: nothing was judged, so it is no attempt, and it blocks until it is fixed.
    return judged.failed === UNLISTED ? answer(reason, true) : answer(bounded(root, maxBlocks, reason));
  }
  if (judged.run.verdict === "timed_out") timedOut = true;

  const exhausted = judged.reason !== null && spend(root, maxBlocks);
  recordRun(root, loaded, judged, {
    head,
    dirty,
    baseline,
    reason: exhausted ? EXHAUSTED : judged.reason,
    session_id: typeof payload.session_id === "string" && SESSION_ID.test(payload.session_id) ? payload.session_id : null,
  });
  return exhausted ? null : answer(named(root, judged.reason));
}

async function gate(payload, { totalMs = BUDGET_MS, startedAt = STARTED, projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
  counted.clear();
  charged.clear();
  unwritable.clear();
  heldReasons.length = 0;
  current = null;
  timedOut = false;
  if (!isObject(payload)) return boundedByAll(`Krites blocked the stop: the hook payload is not an object. ${ADVICE}`, { projectDir });
  for (const entry of findRoots({ cwd: payload.cwd, projectDir })) {
    current = entry;
    const blocked = await gateRoot(entry, payload, { totalMs, startedAt });
    if (blocked === null) continue;
    if (!blocked.held) return [blocked.reason, ...heldReasons].join("\n");
    heldReasons.push(blocked.reason);
  }
  current = null;
  if (heldReasons.length > 0) return heldReasons.join("\n");
  // Only the allowed stop at the end of the chain pings, never a run already over its budget, and never past it.
  if (!timedOut && Date.now() - startedAt < totalMs) await ping.send();
  return null;
}

const block = (reason) => (reason ? JSON.stringify({ decision: "block", reason }) : "");

// One hook run, one budget: whatever is still running when the watchdog fires, the stop is answered.
function guarded(payload, options = {}) {
  const settings = { projectDir: process.env.CLAUDE_PROJECT_DIR, watchdogMs: WATCHDOG_MS, ...options };
  const where = { cwd: isObject(payload) ? payload.cwd : undefined, projectDir: settings.projectDir };
  let timer;
  const watchdog = new Promise((resolve) => {
    const reason = `Krites blocked the stop: gate timed out after ${settings.watchdogMs / 1000} s. ${ADVICE}`;
    timer = setTimeout(() => resolve(boundedByAll(reason, where)), settings.watchdogMs);
  });
  return Promise.race([gate(payload, settings), watchdog]).finally(() => clearTimeout(timer));
}

if (require.main === module) {
  hookio.run({
    handle: async (payload) => block(await guarded(payload)),
    fail: (what) => block(boundedByAll(`Krites blocked the stop: the gate hook ${what}. ${ADVICE}`)),
  });
}

module.exports = { BUDGET_MS, WATCHDOG_MS, budgetMs, gate, guarded, judge, recordRun, treeState };
