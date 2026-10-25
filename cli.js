const fs = require("node:fs");
const path = require("node:path");

const gate = require("./hooks/gate.js");
const { detect, loadConfig, parseToml, protectedGlobs } = require("./lib/config.js");
const ping = require("./lib/ping.js");
const receipts = require("./lib/receipt.js");
const { scrub } = require("./lib/scrub.js");
const settings = require("./lib/settings.js");
const state = require("./lib/state.js");
const { matches } = require("./lib/glob.js");

// The Bash tool delivers a run of up to 600 s when the model passes the parameter (spikes/claude-plugin/NOTES.md);
// the minute below it is the margin for the checks to be killed and the verdict written.
const CAP_SECONDS = 540;
const CAP_MS = CAP_SECONDS * 1000;
const STARTED = Date.now();
const GLOBS = [
  "tests/krites/**",
  "krites.toml",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks/**",
  ".claude/agents/**",
  ".claude/commands/**",
  ".claude/skills/**",
  ".mcp.json",
  ".claude/output-styles/**",
  ".claude/rules/**",
];
const MARKERS = "Cargo.toml, package.json, pyproject.toml, pytest.ini or go.mod";
const NO_CHECKS = "krites.toml configures no checks, so nothing ran.";
const NO_ROOT = "This repo has no krites.toml, so Krites is checking nothing. Run /krites:init.";
const USAGE = "usage: /krites:init, /krites:init-write, /krites:approve, /krites:approve-write, /krites:verify, /krites:receipt, /krites:telemetry, /krites:telemetry-on, /krites:telemetry-off";

const lines = [];
const say = (text, root) => lines.push(scrub(String(text), root));
// One budget for the whole invocation: two roots at 600 s each would outlast the Bash tool that carries the command.
const deadlineMs = (seconds, elapsedMs = 0, capMs = CAP_MS) => Math.max(0, Math.min(seconds * 1000, capMs - elapsedMs));
// The cap is named only on the line of a check it cut off: the default 600 s would otherwise announce it on every run.
const timeoutLine = (seconds, ms = deadlineMs(seconds)) =>
  ms < seconds * 1000
    ? `timed out after ${Math.floor(ms / 1000)} s (capped under /krites:verify; the stop gate allows ${seconds} s)`
    : `timed out after ${seconds} s`;
const SPENT = new Error("the /krites:verify budget is spent");
const spentLine = (capMs) => `not run: /krites:verify's ${Math.round(capMs / 1000)} s were spent before this root`;

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

const SCRIPT = /\.(?:[mc]?[jt]s|sh|bash|zsh|ps1|psm1|cmd|bat|py|rb|pl|php|lua)$/i;
const PROJECT = /^\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR)(?=[\\/]|$)/;
// glob.js reads * ? and a backslash as pattern, and krites.toml cannot hold a control character or a lone surrogate.
const exact = (rel) => !/[*?\\]/.test(rel) && ![...rel].some((ch) => ch < " ") && rel.isWellFormed();

// Quotes group words and are dropped, as a shell would; a lone quote stays as text.
const tokens = (command) =>
  (command.match(/(?:"[^"]*"|'[^']*'|[^\s"']|["'])+/g) || []).map((token) => token.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));

function within(dir, target) {
  const rel = path.relative(dir, target).split(path.sep).join("/");
  return rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) ? null : rel;
}

// Files in the repo that a hook in its own settings runs, so an agent cannot rewrite what guards it.
function hookScripts(root) {
  const found = new Set();
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    realRoot = root;
  }
  const propose = (rel) => {
    if (rel !== null && !rel.startsWith(".claude/hooks/") && exact(rel) && !GLOBS.some((glob) => matches(glob, rel))) found.add(rel);
  };
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = path.join(root, ".claude", name);
    let settings;
    try {
      settings = isFile(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    } catch {
      continue;
    }
    const events = settings && typeof settings.hooks === "object" && settings.hooks !== null ? Object.values(settings.hooks) : [];
    for (const group of events.flat()) {
      for (const hook of (group && Array.isArray(group.hooks) && group.hooks) || []) {
        if (!hook || hook.type !== "command" || typeof hook.command !== "string") continue;
        tokens(hook.command).forEach((token, index) => {
          if (index > 0 && !SCRIPT.test(token)) return;
          const named = path.resolve(root, token.replace(PROJECT, () => root));
          if (!isFile(named)) return;
          let real;
          try {
            real = within(realRoot, fs.realpathSync.native(named));
          } catch {
            return;
          }
          if (real === null) return;
          propose(within(root, named));
          propose(real);
        });
      }
    }
  }
  return [...found].sort();
}

function proposal(commands, scripts = []) {
  const list = commands.length === 0 ? "[]" : `[\n${commands.map((command) => `  ${JSON.stringify(command)},\n`).join("")}]`;
  return `${[
    "version = 1",
    "",
    "[checks]",
    `commands = ${list}`,
    "timeout_seconds = 600",
    "max_blocks = 3",
    "",
    "[protect]",
    `globs = [${[...GLOBS, ...scripts].map((glob) => JSON.stringify(glob)).join(", ")}]`,
    "",
    "[receipts]",
    'dir = "receipts"',
  ].join("\n")}\n`;
}

function approve(root, write) {
  const loaded = loadConfig(root);
  if (!loaded.ok) return say(loaded.error, root);
  const listed = loaded.config.checks.commands.map((argv) => `  ${argv.join(" ")}`);
  const env = Object.entries(loaded.config.checks.env).map(([name, value]) => `  ${name}=${value}`);
  const slow = loaded.config.checks.slow.map((argv) => `  ${argv.join(" ")}`);
  const none = slow.length === 0 ? "krites.toml is here and configures no checks." : "krites.toml is here and runs no check at a stop.";
  const lines = listed.length === 0 ? [none] : ["krites.toml is here and runs:", ...listed];
  if (slow.length > 0) lines.push("and under /krites:verify only:", ...slow);
  if (env.length > 0) lines.push("with this environment:", ...env);
  say(lines.join("\n"), root);
  if (!write) return say("Nothing was written. Run /krites:init-write to approve this krites.toml for the gate.", root);
  // New globs can protect a path no approval showed, so an accepted config ends any approval first.
  state.dropRange(root, state.APPROVED);
  state.writeConfigHash(root, loaded.hash);
  say("The gate now accepts this krites.toml.", root);
}

function init(args) {
  const write = args.length === 1 && args[0] === "--write";
  if (args.length > 1 || (args.length === 1 && !write)) return false;
  const top = state.git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const root = top === null ? process.cwd() : path.resolve(top.trim());
  say(`Node ${process.version} detected. Krites needs Node 20 or later.`, root);
  if (fs.existsSync(path.join(root, "krites.toml"))) return approve(root, write);

  const commands = detect(root);
  if (commands === null) return say(`No ${MARKERS} is here, so there is nothing to propose. Write krites.toml by hand.`, root);
  const text = proposal(commands, hookScripts(root));
  say(text.trimEnd(), root);
  if (!write) return say("Nothing was written. Run /krites:init-write to create it.", root);
  fs.writeFileSync(path.join(root, "krites.toml"), text, { flag: "wx" });
  state.dropRange(root, state.APPROVED);
  state.writeConfigHash(root, state.hashText(text));
  say("krites.toml is written and the gate accepts it. Run /krites:verify to run the checks now.", root);
}

const SHOWN = 200;
const SAFE_DIFF = "git --no-replace-objects --literal-pathspecs diff --no-ext-diff --no-textconv --text";
const NO_BASELINE = "There is no session baseline here, so there is nothing to approve: the gate compares against HEAD. Nothing was written.";
const NO_CONFIG = (command) =>
  `This repo has no krites.toml, so there is nothing to approve: the stop gate runs "${command}" and judges no protected path. Nothing was written.`;
const NOTHING = "No commit since the baseline changed a protected path, so there is nothing to approve. Nothing was written.";
const UNLISTED = "Krites could not list the changed paths here, so nothing was written.";
const STILL = "The next stop still runs the checks, and only a pass moves the baseline.";
const AGAIN = "so nothing was approved. Run /krites:approve again.";
// Format and separator characters too: a bidi override or a line separator can make a diff read as something it is not.
const visible = (text) =>
  text.replace(/(?!\t)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
    const code = ch.codePointAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
  });
// No diff line starts with "* ", so a path the CLI lists cannot be faked by the content it shows.
const listed = (rels) => rels.map((rel) => `* ${visible(rel)}`);
// A replace ref would show other objects than the ids name, so the calls that build what is shown read the real ones;
// the gate's rule, and with it the not-committed list, uses git's defaults.
const shown = (root, args) => state.git(root, ["--no-replace-objects", "--literal-pathspecs", ...args]);
const short = (root, id) => (shown(root, ["rev-parse", "--short", id]) || id).trim();
const outLines = (out) => (out === null ? null : out === "" ? [] : out.replace(/\n$/, "").split("\n"));

// The [protect] globs of the krites.toml a commit holds, read with the same parser; none when it has no readable one.
function globsAt(root, id) {
  const text = shown(root, ["cat-file", "blob", `${id}:./krites.toml`]);
  try {
    const parsed = text === null ? null : parseToml(text);
    const globs = parsed && parsed.ok && parsed.value.protect ? parsed.value.protect.globs : null;
    return Array.isArray(globs) ? globs.filter((glob) => typeof glob === "string" && glob !== "") : [];
  } catch {
    return [];
  }
}

// Every protected path that differs between the two commits holds all an approval of them can excuse. Protected means
// under the working krites.toml, the baseline's or HEAD's, so a narrowed krites.toml cannot hide one.
function review(root, loaded, { baseline, head }) {
  const names = shown(root, ["diff", "--name-only", "--no-renames", "--relative", "-z", baseline, head]);
  const now = gate.protectedChanges(root, loaded, head);
  if (names === null || now === null) return null;
  const globs = [...protectedGlobs(loaded.config), ...globsAt(root, baseline), ...globsAt(root, head)];
  const rels = names.split("\0").filter((rel) => rel !== "" && globs.some((glob) => matches(glob, rel))).sort();
  // A session that started before the first commit has the empty tree as its baseline: every commit is since then.
  const commit = shown(root, ["rev-parse", "--verify", "--quiet", `${baseline}^{commit}`]) !== null;
  const log = rels.length === 0 ? [] : outLines(shown(root, ["log", "--format=%h %s", commit ? `${baseline}..${head}` : head, "--", ...rels]));
  if (log === null) return null;
  const [from, to] = [short(root, baseline), short(root, head)];
  return {
    rels,
    log: log.length === 0 ? [`(no commit in ${from}..${to} changed these paths)`] : log.map(visible),
    descends: !commit || shown(root, ["merge-base", "--is-ancestor", baseline, head]) !== null,
    dirty: now.paths.filter((rel) => now.changed.includes(rel)).sort(),
  };
}

function show(root, loaded, range) {
  const seen = review(root, loaded, range);
  if (seen === null) return say(UNLISTED, root);
  const notCommitted = seen.dirty.length === 0 ? [] : ["not committed, so not approvable:", ...listed(seen.dirty)];
  if (seen.rels.length === 0) {
    state.dropRange(root, state.PENDING);
    return say([NOTHING, ...notCommitted].join("\n"), root);
  }
  const flags = ["--no-ext-diff", "--no-textconv", "--text", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--stat", "--patch"];
  const diff = outLines(shown(root, ["diff", ...flags, range.baseline, range.head, "--", ...seen.rels]));
  if (diff === null) return say(UNLISTED, root);
  const body = [...seen.log, ...diff.map(visible)];
  const [from, to] = [short(root, range.baseline), short(root, range.head)];
  const title = seen.descends ? `Protected paths changed in commits since the baseline ${from}:` : `Protected paths that differ between the baseline ${from} and HEAD ${to}:`;
  const out = [title, ...listed(seen.rels), ...body.slice(0, SHOWN)];
  // Ids only: a path is text the repo chose, and this line is a command a person may paste.
  if (body.length > SHOWN) out.push(`(${body.length - SHOWN} more lines not shown: ${SAFE_DIFF} ${from} ${to})`);
  out.push(...notCommitted, `Nothing is approved yet. Run /krites:approve-write to approve these changes up to ${to}.`);
  state.writeRange(root, state.PENDING, range);
  say(out.join("\n"), root);
}

function approveWrite(root, loaded, { baseline, head }) {
  if (baseline === null || head === "") return say(NO_BASELINE, root);
  const pending = state.readRange(root, state.PENDING);
  if (pending === null) return say("Nothing is waiting for approval. Run /krites:approve first.", root);
  state.dropRange(root, state.PENDING);
  if (pending.head !== head) return say(`HEAD moved from ${short(root, pending.head)} to ${short(root, head)} after /krites:approve, ${AGAIN}`, root);
  if (pending.baseline !== baseline) {
    return say(`The baseline moved from ${short(root, pending.baseline)} to ${short(root, baseline)} after /krites:approve, ${AGAIN}`, root);
  }
  const seen = review(root, loaded, pending);
  if (seen === null) return say(UNLISTED, root);
  if (seen.rels.length === 0) return say(NOTHING, root);
  const blob = shown(root, ["cat-file", "blob", `${head}:./krites.toml`]);
  const config = seen.rels.includes("krites.toml") && blob !== null && state.hashText(blob) === loaded.hash;
  state.writeRange(root, state.APPROVED, pending);
  if (config) state.writeConfigHash(root, loaded.hash);
  const out = [`Approved these protected changes up to ${short(root, head)}:`, ...listed(seen.rels), ...seen.log];
  say([...out, ...(config ? ["The gate now accepts this krites.toml."] : []), STILL].join("\n"), root);
}

// A commit id binds what was shown exactly, so only a commit is ever approved, never the working tree or the index.
const approveCommits = (write) =>
  eachRoot((root, loaded, { recorded }) => {
    if (loaded.zero) return say(NO_CONFIG(loaded.config.checks.commands[0].join(" ")), root);
    const { head, baseline } = gate.treeState(root, recorded);
    if (write) return approveWrite(root, loaded, { baseline, head });
    if (baseline === null || head === "") {
      state.dropRange(root, state.PENDING);
      return say(NO_BASELINE, root);
    }
    show(root, loaded, { baseline, head });
  });

// Root-relative, or the last segment when the root lies on another drive, so no heading carries a path.
function where(root) {
  const rel = path.relative(process.cwd(), root).replace(/\\/g, "/");
  if (rel === "") return ".";
  return path.isAbsolute(rel) ? path.basename(root) : rel;
}

// The cwd and project roots a stop judges, each with the fallback baseline the gate gives it.
async function eachRoot(perRoot) {
  const roots = gate.gateRoots({ cwd: process.cwd(), projectDir: process.env.CLAUDE_PROJECT_DIR });
  if (roots.length === 0) return say(NO_ROOT, process.cwd());
  for (const entry of roots) {
    if (roots.length > 1) say(`## ${where(entry.root)}`, entry.root);
    const loaded = gate.loadFor(entry);
    if (loaded.ok) await perRoot(entry.root, loaded, entry);
    else say(loaded.error, entry.root);
  }
}

// A check with no exit code was killed: by the deadline on a timed-out run, by a signal otherwise.
const endLine = (check, judged, seconds, last) => {
  if (check.exit_code !== null) return `exit ${check.exit_code}`;
  return judged.run.verdict === "timed_out" && check === last ? timeoutLine(seconds, judged.deadlineMs) : "killed by a signal";
};

const verify = ({ capMs, startedAt }) =>
  eachRoot(async (root, loaded, { recorded }) => {
    await checkRoot(root, loaded, { capMs, startedAt, recorded });
    const { off, unreadable } = settings.survey(root);
    for (const file of unreadable) say(settings.unknown(file), root);
    if (off !== null) say(settings.describe(off), root);
  });

async function checkRoot(root, loaded, { capMs, startedAt, recorded }) {
  const seconds = loaded.config.checks.timeout_seconds;
  // Taken before any work, so a root with no budget left is left as it was instead of being killed mid-check.
  const ms = deadlineMs(seconds, Date.now() - startedAt, capMs);
  if (ms === 0) return say(spentLine(capMs), root);
  const { head, dirty, baseline, ownBaseline } = gate.treeState(root, recorded);
  // Read again when the checks start, so this root's own fingerprints and git calls come out of its deadline;
  // when they have spent it all, no check is started just to be killed and recorded over the last good run.
  const deadline = () => {
    const left = deadlineMs(seconds, Date.now() - startedAt, capMs);
    if (left === 0) throw SPENT;
    return left;
  };
  let judged;
  try {
    const commands = [...loaded.config.checks.commands, ...loaded.config.checks.slow];
    judged = await gate.judge(root, loaded, { head, baseline, ownBaseline, deadline, commands });
  } catch (err) {
    if (err === SPENT) return say(spentLine(capMs), root);
    throw err;
  }
  if (judged.failed) return say(`${judged.failed}.`, root);

  gate.recordRun(root, loaded, judged, { head, dirty, baseline, reason: judged.reason, session_id: null });
  if (judged.touched) return say(judged.reason, root);
  if (judged.run.verdict === "no_checks") return say(NO_CHECKS, root);
  const last = judged.run.checks[judged.run.checks.length - 1];
  for (const check of judged.run.checks) {
    say(check.command, root);
    // The captured tail ends in the newline the check printed, which would read here as a blank line.
    const tail = check.tail.replace(/\n+$/, "");
    if (tail !== "") say(tail, root);
    say(endLine(check, judged, seconds, last), root);
  }
}

const receipt = () =>
  eachRoot((root, loaded) => {
    const dir = loaded.config.receipts.dir;
    const already = receipts.existing(root, dir);
    if (already !== null) return say(`This run's receipt is already at ${already}.`, root);
    for (const file of settings.survey(root).unreadable) say(settings.unknown(file), root);
    const built = receipts.build(root);
    if (!built.ok) return say(built.reason, root);
    const written = receipts.write(root, built.receipt, dir);
    say(written.json, root);
    say(written.md, root);
  });

function telemetry(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "on" && args[0] !== "off")) return false;
  say(ping.telemetry(args[0]), process.cwd());
}

// No command passes user text, but cli.js can be run by hand, so anything unknown is answered with the usage line
// and nothing else, the consent question included.
async function run(name, args, options) {
  if (name === "telemetry") {
    if (telemetry(args) === false) say(USAGE, process.cwd());
    return;
  }
  if (name === "init") {
    if (init(args) === false) return say(USAGE, process.cwd());
  } else if (name === "approve" && (args.length === 0 || (args.length === 1 && args[0] === "--write"))) await approveCommits(args.length === 1);
  else if (args.length === 0 && name === "verify") await verify(options);
  else if (args.length === 0 && name === "receipt") await receipt();
  else return say(USAGE, process.cwd());
  // Consent is asked from a command and never from a hook, so the question closes the ones that have output.
  const asked = ping.question();
  if (asked !== null) say(asked, process.cwd());
}

async function main(argv, { capMs = CAP_MS, startedAt = STARTED } = {}) {
  lines.length = 0;
  try {
    await run(argv[0], argv.slice(1), { capMs, startedAt });
  } catch (err) {
    say(`Krites could not finish: ${err.code || err.name}.`, process.cwd());
  }
  await ping.send();
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// Answering is the last thing that can fail, and a pipe nobody reads must not turn into a non-zero exit either.
// The exit is explicit, as in hookio: a process a check left behind can hold its pipe open long after the answer.
if (require.main === module) {
  process.stdout.on("error", () => process.exit(0));
  main(process.argv.slice(2))
    .catch(() => "")
    .then((text) => process.stdout.write(text, () => process.exit(0)));
}

module.exports = { deadlineMs, detect, hookScripts, main, proposal, timeoutLine };
