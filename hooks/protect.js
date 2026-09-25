const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findRoots, loadConfig, loadUserConfig, protectedGlobs } = require("../lib/config.js");
const { matches } = require("../lib/glob.js");
const hookio = require("../lib/hookio.js");
const { configDir } = require("../lib/sign.js");

const PATH_KEYS = ["file_path", "path", "notebook_path"];
const UNC = /^[\\/]{2}(?:[?.][\\/]UNC[\\/]|(?![?.][\\/]))/i;
const WINDOWS = process.platform === "win32";

function lexists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

// lstat, not exists: a dangling link must reach realpath and fail there, not pass as a missing file.
function realTarget(file) {
  let existing = path.resolve(file);
  const missing = [];
  while (!lexists(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return lexists(existing) ? path.join(fs.realpathSync.native(existing), ...missing) : path.resolve(file);
}

// Claude Code keeps this project's memory beside the session transcript it names in every payload, outside the repo.
// The project folder is resolved and `memory` is not, so a memory folder that is a link resolves elsewhere and stays denied.
function memoryDirOf(payload) {
  const transcript = payload.transcript_path;
  if (typeof transcript !== "string" || transcript.includes("\0") || !path.isAbsolute(transcript) || !transcript.endsWith(".jsonl")) {
    return null;
  }
  if (UNC.test(transcript)) return null;
  try {
    return path.join(realTarget(path.dirname(transcript)), "memory");
  } catch {
    return null;
  }
}

function inside(dir, target) {
  const rel = path.relative(dir, target).replace(/\\/g, "/");
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel);
}

const within = (dir, target) => path.relative(dir, target) === "" || inside(dir, target);

function resolved(dir) {
  try {
    return realTarget(dir);
  } catch {
    return dir;
  }
}

// Only the user's own config.toml opens a path outside every repo, and never the folders that hold the signing key,
// that config, or Claude Code's own settings. The target is already resolved, so a link cannot lead past these.
function outsideReason(target, name, outside) {
  const { root } = path.parse(target);
  const rest = target.slice(root.length);
  if (WINDOWS && rest.includes(":")) return `Blocked: ${name} names an alternate data stream.`;
  const parts = rest.split(/[\\/]+/).filter(Boolean).map((part) => (WINDOWS ? part.replace(/[. ]+$/, "") : part));
  if (parts.includes("")) return `Blocked: ${name} has a path component made only of dots or spaces.`;
  const loaded = loadUserConfig(configDir());
  if (!loaded.ok) return `Blocked: ${name} resolves outside the repository, and ${loaded.error}.`;
  const home = resolved(os.homedir());
  const clean = path.join(root, ...parts);
  const expand = (entry) => (/^~[\\/]/.test(entry) ? path.join(home, entry.slice(2)) : entry);
  const fold = WINDOWS || process.platform === "darwin";
  if (!loaded.allowOutside.some((entry) => matches(expand(entry), clean, { fold }))) return outside;
  // Folded on every OS: a home on a case-insensitive volume under Linux still reaches ~/.claude as ~/.CLAUDE.
  const key = (file) => file.normalize("NFC").toLowerCase();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR;
  // A relative value is closed against every cwd Claude Code may have taken it from.
  const bases = claudeDir && !path.isAbsolute(claudeDir) ? [process.cwd(), process.env.CLAUDE_PROJECT_DIR].filter(Boolean) : [""];
  const claudeDirs = claudeDir ? bases.map((base) => path.resolve(base, claudeDir)) : [];
  const tidy = (dir) => {
    const top = path.parse(dir).root;
    return path.join(top, ...dir.slice(top.length).split(/[\\/]+/).filter(Boolean).map((part) => (WINDOWS ? part.replace(/[. ]+$/, "") : part)));
  };
  // A share is never touched: a slow one would outlast the hook's timeout, which lets the write through.
  const withReal = (dir) => (UNC.test(dir) ? [dir] : [dir, resolved(dir)]);
  const own = [configDir(), path.join(os.homedir(), ".claude"), ...claudeDirs].flatMap(withReal).map(tidy);
  // Claude Code's global file, and its suffixed variants such as .claude-custom-oauth.json.
  const homes = withReal(os.homedir()).map(tidy).map(key);
  const globalFile = (file) => homes.includes(key(path.dirname(file))) && /^\.claude[^\\/]*\.json$/i.test(path.basename(file));
  const linkedJson = resolved(path.join(os.homedir(), ".claude.json"));
  if (own.some((dir) => within(key(dir), key(clean))) || globalFile(clean) || key(tidy(linkedJson)) === key(clean)) {
    return `Blocked: ${name} is in Claude Code's or Krites's own configuration, which allow_outside never opens.`;
  }
  return null;
}

function reasonFor(file, roots, configs, memoryOf) {
  if (typeof file !== "string" || file.includes("\0")) return "Blocked: the edit path is not a plain string.";
  // Either separator: on POSIX a backslash path is one long file name, and the reason must not echo it whole.
  const name = file.split(/[\\/]/).filter(Boolean).pop() || "the path";
  if (!path.isAbsolute(file)) return `Blocked: ${name} is not an absolute path, so where it lands depends on the cwd.`;
  const outside = `Blocked: ${name} resolves outside the repository. Edits stay inside the repo.`;
  // A UNC target is decided without touching it: a slow share must not stall the hook past its timeout.
  if (UNC.test(file) && !roots.some((entry) => UNC.test(entry.root))) return outside;

  const target = realTarget(file);
  let best = null;
  for (const entry of roots) {
    const rel = path.relative(entry.root, target).replace(/\\/g, "/");
    if (rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) continue;
    if (!best || entry.root.length > best.entry.root.length) best = { entry, rel };
  }
  if (!best) {
    const memory = memoryOf();
    const allowed = memory && inside(memory, target) && !(WINDOWS && path.relative(memory, target).includes(":"));
    return allowed ? null : outsideReason(target, name, outside);
  }
  if (WINDOWS && best.rel.includes(":")) return `Blocked: ${name} names an alternate data stream.`;

  // Win32 drops trailing dots and spaces from each component, so "tests./krites" lands in "tests/krites".
  const parts = best.rel.split("/").map((part) => part.replace(/[. ]+$/, ""));
  if (parts.includes("")) return `Blocked: ${name} has a path component made only of dots or spaces.`;
  const rel = parts.join("/");
  if (protectedGlobs(configs.get(best.entry.root)).some((glob) => matches(glob, rel))) {
    return `Blocked: ${rel} is protected. Protected paths are human-edited only.`;
  }
  return null;
}

function decide(payload, roots) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "Blocked: the hook payload is not an object.";
  if (!roots || roots.length === 0) return null;
  const configs = new Map();
  for (const entry of roots) {
    const loaded = entry.error ? { ok: false, error: entry.error } : loadConfig(entry.root);
    if (!loaded.ok) return `Blocked: ${loaded.error}`;
    configs.set(entry.root, loaded.config);
  }

  const input = payload.tool_input;
  if (input === undefined) return null;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "Blocked: the tool input is not an object.";
  try {
    let memory;
    const memoryOf = () => (memory === undefined ? (memory = memoryDirOf(payload)) : memory);
    for (const key of PATH_KEYS) {
      if (input[key] === undefined || input[key] === null || input[key] === "") continue;
      const reason = reasonFor(input[key], roots, configs, memoryOf);
      if (reason) return reason;
    }
    return null;
  } catch (err) {
    return `Blocked: the edit path could not be resolved (${err.code || err.name}).`;
  }
}

const deny = (reason) =>
  reason ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) : "";

if (require.main === module) {
  hookio.run({
    handle: (payload) => deny(decide(payload, findRoots({ cwd: payload && payload.cwd, projectDir: process.env.CLAUDE_PROJECT_DIR }))),
    fail: (what) => deny(`Blocked: the protect hook ${what}.`),
  });
}

module.exports = { decide };
