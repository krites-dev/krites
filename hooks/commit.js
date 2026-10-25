const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findRoots, loadConfig } = require("../lib/config.js");
const hookio = require("../lib/hookio.js");
const { gitCommits } = require("../lib/shell.js");
const state = require("../lib/state.js");
const { deny } = require("./protect.js");

const CLI = path.join(__dirname, "..", "cli.js");
const HELD = "Krites held the commit:";
const STAGE = "Run git add in a call of its own, then git commit. A file that does not belong in the commit is removed or ignored, and the checks run again.";
const PATHS = `${HELD} it names paths, and Krites judges only what is staged. Stage them with git add, then run git commit without paths.`;
const UNKNOWN_DIR = `${HELD} it cannot tell which directory the commit runs in. Name the directory without variables.`;
const UNLISTED = `${HELD} git could not list what changed in this root, so nothing can be judged. Tell the user.`;
const MAX_LISTED = 20;
// An unborn HEAD is recorded as "", and nothing but an object name may reach git as an argument.
const HEAD = /^(?:[0-9a-f]{40,64})?$/;
const WINDOWS = process.platform === "win32";

const listed = (paths) => (paths.length <= MAX_LISTED ? paths.join(", ") : `${paths.slice(0, MAX_LISTED).join(", ")}, and ${paths.length - MAX_LISTED} more`);

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -Infinity;
  }
}

function checksAt(dir) {
  const [found] = findRoots({ cwd: dir, processCwd: null });
  if (!found) return null;
  const loaded = found.error ? { ok: false, error: found.error } : loadConfig(found.root);
  return loaded.ok && loaded.config.checks.commands.length === 0 ? null : { root: found.root, loaded };
}

// Git Bash names D:\x as /d/x; a word holding a variable or a substitution names no directory Krites can know.
function resolveDir(from, word, ps) {
  if (/[$`]/.test(word)) return null;
  if (word === "~" || /^~[\\/]/.test(word)) return path.join(os.homedir(), word.slice(1));
  const drive = WINDOWS && !ps && /^\/([A-Za-z])(?=\/|$)/.exec(word);
  return path.resolve(from, drive ? `${drive[1]}:${word.slice(2) || "/"}` : word);
}

// /krites:verify and the stop reach the cwd's root, so a commit judged elsewhere names where to verify it from.
function rerun(root, { cwd, ps }) {
  const [here] = findRoots({ cwd, processCwd: null });
  const rel = path.relative(cwd, root).replace(/\\/g, "/");
  const how =
    here && path.relative(here.root, root) === ""
      ? `end your turn, or run node "${CLI}" verify`
      : path.isAbsolute(rel)
        ? `run node "${CLI}" verify from inside ${path.basename(root)}`
        : `run cd "${rel}"${ps ? ";" : " &&"} node "${CLI}" verify`;
  return `Let the checks run on everything this commit carries (${how} with the tool's timeout at 600000), then commit it all at once.`;
}

function judge(root, loaded, commit, where) {
  if (!loaded.ok) return `${HELD} ${loaded.error}`;
  if (commit.paths.length > 0) return PATHS;
  const run = state.readLastRun(root);
  if (run && run.verdict === "refuted") return `${HELD} the last check run refuted. ${rerun(root, where)}`;
  const passed = run && run.verdict === "passed" && run.config_hash === loaded.hash && typeof run.content === "string" && HEAD.test(run.head);
  const noPass = `${HELD} no passing check run. ${rerun(root, where)}`;
  if (!passed) return noPass;

  const changed = state.contentPaths(root, run.head);
  if (changed === null) return run.head !== "" && state.git(root, ["rev-parse", "--verify", "--quiet", `${run.head}^{commit}`]) === null ? noPass : UNLISTED;
  const content = state.contentHash(root, run.head, changed);
  if (content === null) return UNLISTED;
  if (content !== run.content) {
    // Only the hash is recorded, so the list is what was written after the run; the hold itself compares the hash.
    const since = Date.parse(run.created_at);
    const written = changed.filter((rel) => mtimeOf(path.join(root, rel)) >= since);
    return `${HELD} changed since the last passing check run${written.length > 0 ? `: ${listed(written)}` : ""}. ${rerun(root, where)}`;
  }

  // ls-files, never git diff, which rewrites the index; it also skips a submodule's own dirty tree, which git add cannot stage.
  const out = state.git(root, ["ls-files", "-z", "--others", "--exclude-standard", ...(commit.all ? [] : ["--modified"])]);
  if (out === null) return UNLISTED;
  const left = [...new Set(out.split("\0"))].filter((rel) => rel !== "" && !rel.startsWith(state.WORKTREES)).sort();
  return left.length === 0 ? null : `${HELD} the commit would leave out: ${listed(left)}. ${STAGE}`;
}

function decide(payload) {
  const ps = Boolean(payload) && payload.tool_name === "PowerShell";
  const commits = gitCommits(payload && payload.tool_input && payload.tool_input.command, ps ? "powershell" : "bash");
  if (commits.length === 0) return null;
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
  for (const commit of commits) {
    const dir = commit.dirs.reduce((from, word) => (from === null ? null : resolveDir(from, word, ps)), cwd);
    if (dir === null) {
      if (checksAt(cwd) !== null) return UNKNOWN_DIR;
      continue;
    }
    const at = checksAt(dir);
    const reason = at && judge(at.root, at.loaded, commit, { cwd, ps });
    if (reason) return reason;
  }
  return null;
}

// The hook sits on every shell call, so a crash or a bad payload lets the call through rather than stall the agent.
if (require.main === module) hookio.run({ handle: (payload) => deny(decide(payload)), fail: () => "" });

module.exports = { decide };
