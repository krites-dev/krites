const { DEFAULT_MAX_BLOCKS, findRoots, loadConfig, onPath, testCommand, zeroRoot } = require("../lib/config.js");
const hookio = require("../lib/hookio.js");
const {
  APPROVED,
  dropRange,
  dropZero,
  ensureDir,
  fingerprint,
  git,
  readBlockCount,
  readZero,
  SESSION_ID,
  writeBaseline,
  writeBlockCount,
  writeConfigHash,
  writeZero,
} = require("../lib/state.js");

const NUDGE = "Krites is installed but this repo has no krites.toml, so nothing is being checked. Run /krites:init to create one.";
const ZERO = (command) => `Krites found no krites.toml, so the stop gate runs "${command}". Run /krites:init to customize.`;
const NOT_ON_PATH = (command, program) =>
  `Krites found no krites.toml and would run "${command}" at each stop, but ${program} is not on PATH, so nothing is checked. Run /krites:init to set the command.`;
const NO_CHECKS = "krites.toml configures no checks, so nothing is being checked until [checks].commands names a command.";
const SLOW_ONLY = "krites.toml runs no check at a stop; [checks].slow runs only under /krites:verify.";
const GAVE_UP = (blocks) =>
  `in the last session the Krites stop gate gave up after ${blocks} blocked attempts, so that work ended without passing its checks. Run /krites:verify.`;

const insideGit = (cwd) => typeof cwd === "string" && (git(cwd, ["rev-parse", "--is-inside-work-tree"]) || "").trim() === "true";

const FAILED = (what) => `the Krites session hook ${what}, so the stop gate may compare against a stale baseline.`;

const say = (lines) => (lines.length === 0 ? "" : JSON.stringify({ systemMessage: lines.join("\n") }));

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function handle(payload) {
  const cwd = isObject(payload) ? payload.cwd : undefined;
  // A /clear can follow an interrupted turn that ran no gate, so it keeps the baseline, the approved config and any approval.
  const clearing = isObject(payload) && payload.source === "clear";
  const where = { cwd, projectDir: process.env.CLAUDE_PROJECT_DIR };
  const roots = findRoots(where);
  const lines = [];
  let zeroed = false;
  try {
    const session = isObject(payload) && typeof payload.session_id === "string" && SESSION_ID.test(payload.session_id) ? payload.session_id : null;
    zeroed = startZero(zeroRoot(where), lines, { clearing, session });
  } catch (err) {
    lines.push(FAILED(`failed (${err.code || err.name})`));
  }
  if (roots.length === 0) return say(!zeroed && !clearing && insideGit(cwd) ? [...lines, NUDGE] : lines);

  for (const entry of roots) {
    // One root that cannot record its state must not cost the roots behind it their report, reset and baseline.
    try {
      startRoot(entry, lines, clearing);
    } catch (err) {
      lines.push(FAILED(`failed (${err.code || err.name})`));
    }
  }
  return say(lines);
}

function startRoot(entry, lines, clearing) {
  const loaded = entry.error ? { ok: false, error: entry.error } : loadConfig(entry.root);
  // Above the budget, not at it: the extra count is the stop the gate let through after giving up.
  const budget = loaded.ok ? loaded.config.checks.max_blocks : DEFAULT_MAX_BLOCKS;
  const count = readBlockCount(entry.root);
  if (count > budget) lines.push(GAVE_UP(budget));
  if (count !== 0) writeBlockCount(entry.root, 0);
  if (!clearing) dropRange(entry.root, APPROVED);
  if (!loaded.ok) return lines.push(`Krites is not running: ${loaded.error}`);
  if (clearing) return;
  writeBaseline(entry.root, (git(entry.root, ["rev-parse", "HEAD"]) || "").trim());
  if (loaded.hash !== undefined) writeConfigHash(entry.root, loaded.hash);
  dropZero(entry.root);
  const { commands, slow } = loaded.config.checks;
  if (commands.length === 0) lines.push(slow.length === 0 ? NO_CHECKS : SLOW_ONLY);
}

// True when the repo is zero-config's to speak for, so the nudge stays away. A repo with no test command gets no record.
function startZero(root, lines, { clearing, session }) {
  if (root === null) return false;
  const count = readBlockCount(root);
  if (count > DEFAULT_MAX_BLOCKS) lines.push(GAVE_UP(DEFAULT_MAX_BLOCKS));
  if (count !== 0) writeBlockCount(root, 0);
  const record = readZero(root);
  if (clearing) {
    // A /clear goes on with the work it interrupts, so the tree its session started from passes to the new one.
    if (record !== null && record.session !== null && session !== null && record.session !== session) writeZero(root, { ...record, session });
    return record !== null;
  }
  const command = testCommand(root);
  if (command === null) {
    dropZero(root);
    return false;
  }
  const argv = command.split(" ");
  // Another session's record of this command stays: the gate skips a record whose program this session cannot reach.
  if (!onPath(argv[0])) {
    if (record !== null && record.command.join(" ") !== command) dropZero(root);
    lines.push(NOT_ON_PATH(command, argv[0]));
    return true;
  }
  // The directory lands before the fingerprint, as in the gate, so the plugin's own files never change it.
  ensureDir(root);
  const found = session === null ? null : fingerprint(root);
  writeZero(root, { head: (git(root, ["rev-parse", "HEAD"]) || "").trim(), command: argv, fingerprint: found, session });
  lines.push(ZERO(command));
  return true;
}

if (require.main === module) hookio.run({ handle, fail: (what) => say([FAILED(what)]) });
