const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { scrub } = require("./scrub.js");

const DIR = ".krites";
const BASELINE = "session-head";
const BLOCK_COUNT = "block-count";
const CONFIG_HASH = "config-hash";
const LAST_RUN = "last-run.json";
const GIT_TIMEOUT_MS = 10000;
const MAX_COUNT = 9999;
const MAX_HASH_BYTES = 5 << 20;
const MAX_HASH_TOTAL = 64 << 20;
const OBJECT_NAME = /^[0-9a-f]{40,64}$/;
const RETRY_CODES = ["EPERM", "EBUSY", "EACCES"];
const RETRY_TRIES = 5;
const RETRY_MS = 40;
const WORKTREES = ".claude/worktrees/";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 24 });
  return result.status === 0 ? result.stdout : null;
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// A scanner or an antivirus can still hold the file the gate is replacing, which Windows reports as a sharing
// violation; the write is waited out rather than charged to the root as a crash.
function retrying(fn) {
  for (let tries = 1; ; tries += 1) {
    try {
      return fn();
    } catch (err) {
      if (tries >= RETRY_TRIES || !RETRY_CODES.includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS);
    }
  }
}

// The plugin owns .krites, so an entry of the wrong kind there is its own to replace: removed as itself, never followed, never recursively.
function repair(file, right) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return;
  }
  if (right(stat)) return;
  if (stat.isDirectory()) fs.rmdirSync(file);
  else fs.unlinkSync(file);
}

function ensureDir(root) {
  const dir = path.join(root, DIR);
  repair(dir, (stat) => stat.isDirectory());
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) retrying(() => fs.writeFileSync(ignore, "*\n"));
  return dir;
}

function read(root, name) {
  try {
    return fs.readFileSync(path.join(root, DIR, name), "utf8").trim();
  } catch {
    return null;
  }
}

// Only a plain object name is ever handed to git, so a file holding a flag or a path cannot become an argument.
const readBaseline = (root) => {
  const value = read(root, BASELINE);
  return value !== null && OBJECT_NAME.test(value) ? value : null;
};

const readLastRun = (root) => {
  try {
    return JSON.parse(read(root, LAST_RUN));
  } catch {
    return null;
  }
};

function writeBaseline(root, head) {
  const file = path.join(ensureDir(root), BASELINE);
  repair(file, (stat) => stat.isFile());
  retrying(() => fs.writeFileSync(file, `${head}\n`));
}

// Anything but a small whole number reads as a fresh budget, so a damaged counter never keeps the gate from blocking.
const readBlockCount = (root) => {
  const value = read(root, BLOCK_COUNT);
  return value !== null && /^[0-9]{1,4}$/.test(value) ? parseInt(value, 10) : 0;
};

function writeBlockCount(root, count) {
  const file = path.join(ensureDir(root), BLOCK_COUNT);
  repair(file, (stat) => stat.isFile());
  retrying(() => fs.writeFileSync(file, `${Math.min(count, MAX_COUNT)}\n`));
}

const readConfigHash = (root) => {
  const value = read(root, CONFIG_HASH);
  return value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
};

function writeConfigHash(root, hash) {
  const file = path.join(ensureDir(root), CONFIG_HASH);
  repair(file, (stat) => stat.isFile());
  retrying(() => fs.writeFileSync(file, `${hash}\n`));
}

// A BOM and the line endings change with the checkout, not with the content, so neither one counts as an edit.
const hashText = (text) => sha256((text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n"));

function configHash(root) {
  try {
    return hashText(fs.readFileSync(path.join(root, "krites.toml"), "utf8"));
  } catch {
    return null;
  }
}

// ponytail: past 5 MB in one file or 64 MB in one pass, size and mtime stand in for the content, so a same-size
// in-place edit is invisible there; raise the caps, or hash in a worker, if a repo needs the fingerprint to be exact.
function hasher() {
  let left = MAX_HASH_TOTAL;
  return (file) => {
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_HASH_BYTES || stat.size > left) return `${stat.size}:${stat.mtimeMs}`;
      left -= stat.size;
      return sha256(fs.readFileSync(file));
    } catch {
      return "missing";
    }
  };
}

// Git prints paths from the toplevel while globs and reads are root-relative.
const prefixOf = (root) => {
  const prefix = git(root, ["rev-parse", "--show-prefix"]);
  return prefix === null ? null : prefix.trim();
};

const inRoot = (prefix, rel) => (rel.startsWith(prefix) ? rel.slice(prefix.length) : null);

const lines = (root, args) => {
  const out = git(root, args);
  return out === null ? null : out.split("\0").filter(Boolean);
};

function under(prefix, list) {
  if (list === null) return null;
  return list.map((rel) => inRoot(prefix, rel)).filter((rel) => rel !== null && rel !== "");
}

function fingerprint(root) {
  const prefix = prefixOf(root);
  const fileHash = hasher();
  const parts = [git(root, ["rev-parse", "HEAD"]) || "no-head"];
  const fields = (git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]) || "").split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 3) continue;
    const status = field.slice(0, 2);
    const paths = [field.slice(3)];
    // A rename or copy carries its source in the next field, and the old path counts as changed too.
    if (status[0] === "R" || status[0] === "C") paths.push(fields[i += 1] || "");
    for (const rel of paths) {
      const own = prefix === null ? rel : inRoot(prefix, rel);
      if (own === null || own === "") continue;
      parts.push(`${status}\0${own}\0${fileHash(path.join(root, own))}`);
    }
  }
  return sha256(parts.join("\n"));
}

function changedPaths(root, baseline) {
  const prefix = prefixOf(root);
  if (prefix === null) return null;
  const untracked = under(prefix, lines(root, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]));
  if (untracked === null) return null;

  let tracked;
  if (git(root, ["rev-parse", "--verify", "HEAD"]) === null) {
    tracked = under(prefix, lines(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"]));
  } else {
    const since = baseline ? under(prefix, lines(root, ["diff", "--name-only", "--no-renames", "-z", baseline])) : null;
    tracked = since === null ? under(prefix, lines(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD"])) : since;
  }
  if (tracked === null) return null;
  return [...new Set([...tracked, ...untracked])].filter((rel) => !rel.startsWith(WORKTREES));
}

function diffStat(root, baseline) {
  const prefix = prefixOf(root) || "";
  const against = baseline && git(root, ["rev-parse", "--verify", `${baseline}^{commit}`]) !== null ? baseline : "HEAD";
  const fields = (git(root, ["diff", "--numstat", "--no-renames", "-z", against]) || "").split("\0");
  // A set: two names that differ only in bytes that are not UTF-8 decode to one string, and a receipt refuses a file listed twice.
  const files = new Set();
  let insertions = 0;
  let deletions = 0;
  for (const field of fields) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(field);
    const own = match ? inRoot(prefix, match[3]) : null;
    if (own === null || own === "") continue;
    insertions += Number(match[1]) || 0;
    deletions += Number(match[2]) || 0;
    files.add(own);
  }
  for (const rel of under(prefix, lines(root, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"])) || []) files.add(rel);
  return { files_changed: files.size, insertions, deletions, files: [...files] };
}

function writeLastRun(root, run) {
  const dir = ensureDir(root);
  const clean = {
    ...run,
    reason: run.reason === null || run.reason === undefined ? null : scrub(run.reason, root),
    commands: run.commands.map((argv) => argv.map((arg) => scrub(arg, root))),
    slow: (run.slow || []).map((argv) => argv.map((arg) => scrub(arg, root))),
    env: (run.env || []).map((line) => scrub(line, root)),
    checks: run.checks.map((check) => ({ ...check, command: scrub(check.command, root), tail: scrub(check.tail, root) })),
  };
  const temp = path.join(dir, `.${LAST_RUN}.tmp`);
  retrying(() => fs.writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`));
  retrying(() => fs.renameSync(temp, path.join(dir, LAST_RUN)));
}

module.exports = {
  changedPaths,
  configHash,
  diffStat,
  ensureDir,
  fingerprint,
  git,
  hashText,
  readBaseline,
  readBlockCount,
  readConfigHash,
  readLastRun,
  retrying,
  sha256,
  writeBaseline,
  writeBlockCount,
  writeConfigHash,
  writeLastRun,
};
