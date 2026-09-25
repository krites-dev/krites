const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { hashText } = require("./state.js");

// null: the table takes any bare key.
const TABLES = { checks: ["commands", "slow", "timeout_seconds", "max_blocks"], "checks.env": null, protect: ["globs"], receipts: ["dir"] };
const TOP_KEYS = ["version"];
const USER_TABLES = { protect: ["allow_outside"] };
const USER_CONFIG = "config.toml in the Krites config directory";
// Absolute on either OS, so one user config can travel between machines; a form foreign to this OS never matches.
const OUTSIDE_GLOB = /^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/])/;
const BUILT_IN_GLOBS = ["**/krites.toml", "**/.krites/**", "**/.git", "**/.git/**"];
const REJECTED = /["'`|&;<>$%^!*?()\r\n]/;
const CONTROL = /\p{Cc}/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// On Windows a check can be a .cmd shim, and cmd.exe expands the value inside it.
const ENV_REJECTED = /["&|<>^%!]/;
const RESERVED_DIRS = [".git", ".krites", ".claude"];
const TRACKED_BUT_MISSING = "krites.toml is tracked but missing from the tree. Run /krites:init.";
const GATED_BEFORE = "krites.toml is missing from a repo that Krites gated before. Tell the user to restore it, or to read the Krites README on how to stop gating a repo.";
const GIT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_SECONDS = 820;
const DEFAULT_MAX_BLOCKS = 3;
// fixtures/claude-hooks/stop-repeat: Claude Code ran a blocking Stop hook nine times and ended the chain itself, so a higher budget never exhausts.
const MAX_MAX_BLOCKS = 8;

function headers(tables) {
  const names = Object.keys(tables).map((name) => `[${name}]`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function parseToml(text, { tables = TABLES, topKeys = TOP_KEYS } = {}) {
  const raw = String(text);
  const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const value = {};
  const lines = {};
  const seen = new Set();
  let i = 0;
  let line = 1;
  let table = null;

  const fail = (message, at = line) => ({ ok: false, line: at, message });
  const inline = () => {
    while (src[i] === " " || src[i] === "\t") i += 1;
  };
  const comment = () => {
    if (src[i] !== "#") return false;
    while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i += 1;
    return true;
  };
  const newline = () => {
    if (src[i] === "\r" && src[i + 1] === "\n") i += 1;
    else if (src[i] !== "\n") return false;
    i += 1;
    line += 1;
    return true;
  };
  const blank = () => {
    for (;;) {
      if (src[i] === " " || src[i] === "\t") i += 1;
      else if (!comment() && !newline()) return;
    }
  };
  const bareKey = () => {
    const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (!match) return null;
    i += match[0].length;
    return match[0];
  };

  const readString = () => {
    const at = line;
    i += 1;
    let out = "";
    for (;;) {
      const ch = src[i];
      if (ch === undefined || ch === "\n" || ch === "\r") return fail("a string is one line between double quotes", at);
      if (ch === '"') {
        i += 1;
        return { ok: true, value: out };
      }
      if (ch === "\\") {
        if (src[i + 1] !== '"' && src[i + 1] !== "\\") return fail('the only escapes are \\" and \\\\', at);
        out += src[i + 1];
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
  };

  const readInteger = () => {
    const at = line;
    const match = /^(?:0|[1-9][0-9]*)/.exec(src.slice(i));
    if (!match) return fail("a whole number has no sign and no leading zero", at);
    i += match[0].length;
    if (/[\w.]/.test(src[i] || "")) return fail("only whole numbers are supported", at);
    return { ok: true, value: Number(match[0]) };
  };

  const readArray = (depth) => {
    const at = line;
    if (depth >= 2) return fail("an array may hold strings or arrays of strings, nothing deeper", at);
    i += 1;
    const items = [];
    const itemLines = [];
    for (;;) {
      blank();
      if (i >= src.length) return fail("the array is never closed", at);
      if (src[i] === "]") {
        i += 1;
        return { ok: true, value: items, itemLines };
      }
      const itemAt = line;
      const item = readValue(depth + 1);
      if (!item.ok) return item;
      items.push(item.value);
      itemLines.push(itemAt);
      blank();
      if (i >= src.length) return fail("the array is never closed", at);
      if (src[i] === ",") {
        i += 1;
        continue;
      }
      if (src[i] === "]") {
        i += 1;
        return { ok: true, value: items, itemLines };
      }
      return fail("array items are separated by commas");
    }
  };

  function readValue(depth) {
    if (src[i] === '"') return readString();
    if (src[i] === "[") return readArray(depth);
    if (/[-\d]/.test(src[i] || "")) return readInteger();
    return fail("only whole numbers, double-quoted strings and arrays of strings are supported");
  }

  for (;;) {
    blank();
    if (i >= src.length) break;
    const at = line;
    if (src[i] === "[") {
      i += 1;
      let name = bareKey();
      if (name !== null && src[i] === ".") {
        i += 1;
        const sub = bareKey();
        name = sub === null ? null : `${name}.${sub}`;
      }
      if (name === null || src[i] !== "]") return fail(`a table header is ${headers(tables)}`, at);
      i += 1;
      if (!Object.prototype.hasOwnProperty.call(tables, name)) return fail(`unknown table [${name}]`, at);
      if (seen.has(name)) return fail(`[${name}] appears twice`, at);
      seen.add(name);
      table = name;
    } else {
      const key = bareKey();
      if (key === null) return fail("a line is blank, a comment, a table header or key = value", at);
      if (src[i] === ".") return fail("dotted keys are not supported", at);
      inline();
      if (src[i] !== "=") return fail("a line is blank, a comment, a table header or key = value", at);
      i += 1;
      inline();
      const full = table === null ? key : `${table}.${key}`;
      const known = table === null ? topKeys : tables[table];
      if (known !== null && !known.includes(key)) return fail(`unknown key ${full}`, at);
      if (seen.has(full)) return fail(`${full} appears twice`, at);
      seen.add(full);
      const parsed = readValue(0);
      if (!parsed.ok) return parsed;
      if (table === null) value[key] = parsed.value;
      else (value[table] = value[table] || (known === null ? Object.create(null) : {}))[key] = parsed.value;
      lines[full] = at;
      if (parsed.itemLines) lines[`${full}[]`] = parsed.itemLines;
    }
    inline();
    comment();
    if (i < src.length && !newline()) return fail("unexpected text at the end of the line");
  }
  return { ok: true, value, lines };
}

function toArgv(item) {
  const reject = (text) => {
    const found = REJECTED.exec(text);
    if (found) return `a check command may not hold the character ${JSON.stringify(found[0])}`;
    // A tab is a word separator here, like a space; every other control character is rejected.
    if (CONTROL.test(text.replace(/\t/g, " "))) return "a check command may not hold a control character";
    if (text.endsWith("\\")) return "a check command may not end with a backslash";
    return null;
  };
  let argv;
  if (typeof item === "string") {
    const bad = reject(item);
    if (bad) return { error: bad };
    if (item.trim().startsWith("-")) return { error: "a check command starting with - has no program; use the array form" };
    argv = item.split(/[ \t]+/).filter(Boolean);
  } else if (Array.isArray(item)) {
    for (const arg of item) {
      if (typeof arg !== "string") return { error: "a check command in array form holds strings only" };
      const bad = reject(arg);
      if (bad) return { error: bad };
    }
    argv = item.slice();
  } else {
    return { error: "a check command is a string or an array of strings" };
  }
  if (argv.length === 0) return { error: "a check command needs a program to run" };
  if (argv.some((arg) => arg === "")) return { error: "a check command has no empty arguments" };
  return { argv };
}

function validate(parsed) {
  const { value, lines } = parsed;
  const at = (key) => lines[key] || 1;
  const bad = (key, what) => ({ ok: false, line: at(key), what });
  const badAt = (line, what) => ({ ok: false, line, what });
  const checks = value.checks || {};
  const protect = value.protect || {};
  const receipts = value.receipts || {};

  if (value.version !== 1) return bad("version", "version must be 1");

  let timeout = checks.timeout_seconds;
  if (timeout === undefined) timeout = 600;
  else if (typeof timeout !== "number" || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
    return bad("checks.timeout_seconds", `timeout_seconds must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}`);
  }

  let maxBlocks = checks.max_blocks;
  if (maxBlocks === undefined) maxBlocks = DEFAULT_MAX_BLOCKS;
  else if (typeof maxBlocks !== "number" || maxBlocks < 1 || maxBlocks > MAX_MAX_BLOCKS) {
    return bad("checks.max_blocks", `max_blocks must be a whole number of blocked stop attempts from 1 to ${MAX_MAX_BLOCKS}`);
  }

  const globs = protect.globs === undefined ? [] : protect.globs;
  if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string" || glob === "")) {
    return bad("protect.globs", "protect.globs is a list of non-empty strings");
  }

  const dir = receipts.dir === undefined ? "receipts" : receipts.dir;
  const raw = typeof dir === "string" ? dir.split(/[\\/]/) : [];
  const parts = raw.filter((part) => part !== "" && part !== ".");
  const first = (parts[0] || "").toLowerCase();
  if (
    typeof dir !== "string" ||
    path.isAbsolute(dir) ||
    /^[A-Za-z]:/.test(dir) ||
    raw[0] === "" ||
    parts.length === 0 ||
    parts.includes("..") ||
    RESERVED_DIRS.includes(first)
  ) {
    return bad("receipts.dir", "receipts.dir is a relative path inside the repo, outside .git, .krites and .claude, with no .. segment");
  }

  const argvList = (name) => {
    const items = checks[name] === undefined ? [] : checks[name];
    if (!Array.isArray(items)) return { error: bad(`checks.${name}`, `checks.${name} is a list of commands`) };
    const itemLines = lines[`checks.${name}[]`] || [];
    const list = [];
    for (const [index, item] of items.entries()) {
      const { argv, error } = toArgv(item);
      if (error) return { error: badAt(itemLines[index] || at(`checks.${name}`), error) };
      list.push(argv);
    }
    return { list };
  };
  const { list: commands, error: commandsError } = argvList("commands");
  if (commandsError) return commandsError;
  const { list: slow, error: slowError } = argvList("slow");
  if (slowError) return slowError;

  const env = Object.create(null);
  const names = new Set();
  for (const [name, text] of Object.entries(value["checks.env"] || {})) {
    const key = `checks.env.${name}`;
    if (!ENV_NAME.test(name)) return bad(key, "[checks.env] names are letters, digits and _, not starting with a digit");
    if (typeof text !== "string") return bad(key, "[checks.env] values are strings");
    if (CONTROL.test(text)) return bad(key, "[checks.env] values may not hold a control character");
    const found = ENV_REJECTED.exec(text);
    if (found) return bad(key, `[checks.env] values may not hold the character ${JSON.stringify(found[0])}`);
    if (names.has(name.toUpperCase())) return bad(key, `[checks.env] names ${name} twice, ignoring case`);
    names.add(name.toUpperCase());
    env[name] = text;
  }

  return {
    ok: true,
    config: { version: 1, checks: { commands, slow, env, timeout_seconds: timeout, max_blocks: maxBlocks }, protect: { globs }, receipts: { dir } },
  };
}

function loadConfig(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, "krites.toml"), "utf8");
  } catch (err) {
    return { ok: false, error: `krites.toml could not be read (${err.code || err.name}). Run /krites:init.` };
  }
  try {
    const parsed = parseToml(text);
    const result = parsed.ok ? validate(parsed) : parsed;
    // The hash comes from the bytes just parsed, so the recorded commands and the recorded hash always describe one file.
    if (result.ok) return { ...result, hash: hashText(text) };
    return { ok: false, error: `krites.toml line ${result.line}: ${result.what || result.message}. Run /krites:init.` };
  } catch (err) {
    return { ok: false, error: `krites.toml could not be read (${err.code || err.name}). Run /krites:init.` };
  }
}

function loadUserConfig(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, allowOutside: [] };
    return { ok: false, error: `${USER_CONFIG} could not be read (${err.code || err.name})` };
  }
  const parsed = parseToml(text, { tables: USER_TABLES, topKeys: [] });
  if (!parsed.ok) return { ok: false, error: `${USER_CONFIG}, line ${parsed.line}: ${parsed.message}` };
  const bad = (line, what) => ({ ok: false, error: `${USER_CONFIG}, line ${line}: ${what}` });
  const entries = (parsed.value.protect || {}).allow_outside;
  if (entries === undefined) return { ok: true, allowOutside: [] };
  const at = parsed.lines["protect.allow_outside"];
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || entry === "")) {
    return bad(at, "protect.allow_outside is a list of non-empty strings");
  }
  const itemLines = parsed.lines["protect.allow_outside[]"];
  const relative = entries.findIndex((entry) => !OUTSIDE_GLOB.test(entry));
  if (relative !== -1) return bad(itemLines[relative], "protect.allow_outside entries are absolute paths or start with ~/");
  return { ok: true, allowOutside: entries };
}

const protectedGlobs = (config) => [...config.protect.globs, ...BUILT_IN_GLOBS];

function lexists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function real(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (lexists(path.join(dir, "krites.toml"))) return { root: real(dir), error: null };
    // A repo that was gated before stays gated: deleting the config must not silently switch the plugin off.
    if (lexists(path.join(dir, ".krites", "session-head"))) return { root: real(dir), error: GATED_BEFORE };
    if (lexists(path.join(dir, ".git"))) {
      const tracked = spawnSync("git", ["cat-file", "-e", "HEAD:krites.toml"], { cwd: dir, stdio: "ignore", timeout: GIT_TIMEOUT_MS, windowsHide: true });
      return tracked.status === 0 ? { root: real(dir), error: TRACKED_BUT_MISSING } : null;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function here() {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

function findRoots({ cwd, projectDir, processCwd = here() } = {}) {
  const roots = [];
  for (const start of [cwd, projectDir, processCwd]) {
    if (typeof start !== "string" || start === "") continue;
    const found = findRoot(start);
    if (found && !roots.some((seen) => seen.root === found.root)) roots.push(found);
  }
  return roots;
}

module.exports = { DEFAULT_MAX_BLOCKS, findRoots, loadConfig, loadUserConfig, parseToml, protectedGlobs };
