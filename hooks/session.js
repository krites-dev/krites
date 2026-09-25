const { DEFAULT_MAX_BLOCKS, findRoots, loadConfig } = require("../lib/config.js");
const hookio = require("../lib/hookio.js");
const { git, readBlockCount, writeBaseline, writeBlockCount, writeConfigHash } = require("../lib/state.js");

const NUDGE = "Tell the user: Krites is installed but this repo has no krites.toml, so nothing is being checked. Run /krites:init to create one.";
const NO_CHECKS = "Tell the user: krites.toml configures no checks, so nothing is being checked until [checks].commands names a command.";
const SLOW_ONLY = "Tell the user: krites.toml runs no check at a stop; [checks].slow runs only under /krites:verify.";
const GAVE_UP = (blocks) =>
  `Tell the user: in the last session the Krites stop gate gave up after ${blocks} blocked attempts, so that work ended without passing its checks. Run /krites:verify.`;

const insideGit = (cwd) => typeof cwd === "string" && (git(cwd, ["rev-parse", "--is-inside-work-tree"]) || "").trim() === "true";

const FAILED = (what) => `Tell the user: the Krites session hook ${what}, so the stop gate may compare against a stale baseline.`;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function handle(payload) {
  const cwd = isObject(payload) ? payload.cwd : undefined;
  const roots = findRoots({ cwd, projectDir: process.env.CLAUDE_PROJECT_DIR });
  if (roots.length === 0) return insideGit(cwd) ? `${NUDGE}\n` : "";

  const lines = [];
  for (const entry of roots) {
    // One root that cannot record its state must not cost the roots behind it their report, reset and baseline.
    try {
      startRoot(entry, lines);
    } catch (err) {
      lines.push(FAILED(`failed (${err.code || err.name})`));
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function startRoot(entry, lines) {
  const loaded = entry.error ? { ok: false, error: entry.error } : loadConfig(entry.root);
  // Above the budget, not at it: the extra count is the stop the gate let through after giving up.
  const budget = loaded.ok ? loaded.config.checks.max_blocks : DEFAULT_MAX_BLOCKS;
  const count = readBlockCount(entry.root);
  if (count > budget) lines.push(GAVE_UP(budget));
  if (count !== 0) writeBlockCount(entry.root, 0);
  if (!loaded.ok) return lines.push(`Tell the user: Krites is not running: ${loaded.error}`);
  writeBaseline(entry.root, (git(entry.root, ["rev-parse", "HEAD"]) || "").trim());
  if (loaded.hash !== undefined) writeConfigHash(entry.root, loaded.hash);
  const { commands, slow } = loaded.config.checks;
  if (commands.length === 0) lines.push(slow.length === 0 ? NO_CHECKS : SLOW_ONLY);
}

if (require.main === module) hookio.run({ handle, fail: (what) => `${FAILED(what)}\n` });
