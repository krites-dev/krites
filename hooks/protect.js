const fs = require("node:fs");
const path = require("node:path");

const { findRoots, loadConfig, protectedGlobs } = require("../lib/config.js");
const { matches } = require("../lib/glob.js");
const hookio = require("../lib/hookio.js");

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

function reasonFor(file, roots, configs) {
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
  if (!best) return outside;
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
    for (const key of PATH_KEYS) {
      if (input[key] === undefined || input[key] === null || input[key] === "") continue;
      const reason = reasonFor(input[key], roots, configs);
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
