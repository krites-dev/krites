const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { findRoots } = require("../lib/config.js");
const { decide } = require("../hooks/protect.js");
const { ABSOLUTE, git, gitInit, head, makeDir, makeRepo, runHook, tmp } = require("./helpers.js");

const PROTECT = path.join(__dirname, "..", "hooks", "protect.js");
const WINDOWS = process.platform === "win32";
const CONFIG = 'version = 1\n\n[protect]\nglobs = ["tests/krites/**", "docs/SPEC.md", "*.lock"]\n';

const edit = (input, cwd) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd, tool_input: input });
const input = (file) => ({ tool_input: { file_path: file } });

function assertDeny(result, pattern) {
  assert.strictEqual(result.code, 0, "exit code is 0, never 2");
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  assert.strictEqual(out.hookEventName, "PreToolUse");
  assert.strictEqual(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, pattern);
  assert.doesNotMatch(result.stdout + result.stderr, ABSOLUTE, "no absolute path in hook output");
  assert.strictEqual(result.stderr, "", "nothing on stderr, so no stack trace naming the script");
}

const SILENT = { code: 0, stdout: "", stderr: "" };

test("protect: a glob from krites.toml is denied as JSON with exit 0", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "tests", "krites", "a.rs") }, repo)), /tests\/krites\/a\.rs is protected/);
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "docs", "SPEC.md") }, repo)), /docs\/SPEC\.md is protected/);
  assertDeny(await runHook(PROTECT, edit({ path: path.join(repo, "pnpm.lock") }, repo)), /protected/);
  assertDeny(await runHook(PROTECT, edit({ notebook_path: path.join(repo, "tests", "krites", "a.ipynb") }, repo)), /protected/);
  assert.deepStrictEqual(await runHook(PROTECT, edit({ file_path: path.join(repo, "src", "lib.rs") }, repo)), SILENT);
});

test("protect: the built-ins are protected even with an empty [protect]", async () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n\n[protect]\n" } });
  for (const rel of [["krites.toml"], ["sub", "krites.toml"], [".krites", "session-head"], [".krites", "a", "b.json"], [".git", "config"]]) {
    assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, ...rel) }, repo)), /is protected/);
  }
});

test("protect: every path key is checked, not only the first", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const keys = { file_path: path.join(repo, "src", "a.rs"), notebook_path: path.join(repo, "tests", "krites", "x.ipynb") };
  assertDeny(await runHook(PROTECT, edit(keys, repo)), /tests\/krites\/x\.ipynb is protected/);
});

test("protect: matching ignores case and Win32 trailing dots and spaces", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  for (const parts of [["TESTS", "KRITES", "new.rs"], ["tests", "krites..", "new.rs"], ["tests", "krites ", "new.rs"], ["KRITES.TOML"]]) {
    assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, ...parts) }, repo)), /is protected/);
  }
});

test("protect: relative and home-relative paths are denied", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  assertDeny(await runHook(PROTECT, edit({ file_path: "src/x.rs" }, repo)), /not an absolute path/);
  assertDeny(await runHook(PROTECT, edit({ file_path: "~/.bashrc" }, repo)), /not an absolute path/);
});

test("protect: a payload with no path is allowed, a tool input that is not an object is denied", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  assert.deepStrictEqual(await runHook(PROTECT, edit({}, repo)), SILENT);
  for (const bad of ["a string", null, [{ file_path: "x" }]]) assertDeny(await runHook(PROTECT, edit(bad, repo)), /not an object/);
  assertDeny(await runHook(PROTECT, edit({ file_path: 42 }, repo)), /not a plain string/);
});

test("protect: malformed stdin denies", async () => {
  assertDeny(await runHook(PROTECT, "{not json"), /could not read/);
});

test("protect: stdin that never arrives denies at the deadline", { timeout: 15000 }, async () => {
  assertDeny(await runHook(PROTECT, null, { closeStdin: false }), /timed out/);
});

test("protect: the root can come from CLAUDE_PROJECT_DIR, and a cwd in a subfolder still finds it", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG, "src/deep/a.rs": "a\n" } });
  const target = { file_path: path.join(repo, "tests", "krites", "a.rs") };
  assertDeny(await runHook(PROTECT, edit(target, path.join(repo, "src", "deep"))), /is protected/);
  assertDeny(await runHook(PROTECT, edit(target), { env: { CLAUDE_PROJECT_DIR: repo.replace(/\\/g, "/") } }), /is protected/);
});

test("protect: a stray krites.toml above the git toplevel is ignored", async () => {
  const outer = makeDir({ "krites.toml": CONFIG });
  const repo = path.join(outer, "repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  assert.deepStrictEqual(await runHook(PROTECT, edit({ file_path: path.join(repo, "tests", "krites", "a.rs") }, repo)), SILENT);
});

test("protect: a krites.toml tracked at HEAD but missing from the tree denies every edit", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  fs.rmSync(path.join(repo, "krites.toml"));
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "src", "a.rs") }, repo)), /tracked but missing.*\/krites:init/s);
  assertDeny(await runHook(PROTECT, edit({}, repo)), /tracked but missing/);
});

test("protect: a krites.toml deleted from a repo that was gated before denies every edit", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  fs.mkdirSync(path.join(repo, ".krites"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".krites", "session-head"), `${"a".repeat(40)}\n`);
  fs.rmSync(path.join(repo, "krites.toml"));
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "src", "a.rs") }, repo)), /missing from a repo that Krites gated before/);
});

test("protect: a payload that is not an object denies", async () => {
  for (const payload of ['"a string"', "[1,2]", "42", "null"]) {
    assertDeny(await runHook(PROTECT, payload), /not an object/);
  }
});

test("protect: a config that does not parse denies with the line number and /krites:init", async () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n\n[checks]\nnope = 1\n" } });
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(repo, "src", "a.rs") }, repo)), /krites\.toml line 4: .*Run \/krites:init\./);
});

test("protect: paths outside the repo are denied", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const outside = path.join(tmp, "outside-target");
  fs.mkdirSync(path.join(repo, "tests", "krites"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  assert.strictEqual(decide(input(path.join(repo, "src", "lib.rs")), roots), null);
  assert.strictEqual(decide(input(path.join(repo, "new", "deep", "file.rs")), roots), null);
  assert.match(decide(input(path.join(repo, "..", "outside-target", "x.txt")), roots), /outside the repository/);
  assert.match(decide(input(repo), roots), /outside the repository/);

  const elsewhere = WINDOWS ? `${repo[0].toUpperCase() === "Q" ? "R" : "Q"}:\\elsewhere\\x.txt` : "/krites-nowhere/x.txt";
  for (const target of [elsewhere, "\\\\fileserver\\share\\x.txt", "//fileserver/share/x.txt"]) {
    const reason = decide(input(target), roots);
    // On POSIX the backslash form is a relative file name, which is denied for that reason instead.
    assert.match(reason, /x\.txt (resolves outside the repository|is not an absolute path)/);
    assert.doesNotMatch(reason, ABSOLUTE);
  }

  fs.symlinkSync(outside, path.join(repo, "link"), "junction");
  assert.match(decide(input(path.join(repo, "link", "escaped.txt")), roots), /outside the repository/);

  fs.symlinkSync(path.join(repo, "tests", "krites"), path.join(repo, "alias"), "junction");
  assert.match(decide(input(path.join(repo, "alias", "x.rs")), roots), /tests\/krites\/x\.rs is protected/);

  fs.symlinkSync(path.join(tmp, "not-created-yet"), path.join(repo, "dangling"), "junction");
  assert.match(decide(input(path.join(repo, "dangling", "x.txt")), roots), /could not be resolved|outside the repository/);

  const linked = path.join(tmp, "repo-link");
  fs.symlinkSync(repo, linked, "junction");
  assert.strictEqual(decide(input(path.join(linked, "src", "lib.rs")), roots), null);
});

test("protect: this project's Claude Code memory folder stays writable, and nothing else outside the repo does", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const projects = path.join(fs.mkdtempSync(path.join(tmp, "claude-home-")), ".claude", "projects");
  const project = path.join(projects, "D--work-repo");
  const other = path.join(projects, "D--other-repo");
  fs.mkdirSync(path.join(project, "memory"), { recursive: true });
  fs.mkdirSync(path.join(other, "memory"), { recursive: true });
  const transcript = path.join(project, "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d.jsonl");
  fs.writeFileSync(transcript, "");
  const write = (file, transcriptPath = transcript) => ({ transcript_path: transcriptPath, tool_input: { file_path: file } });

  assert.strictEqual(decide(write(path.join(project, "memory", "note.md")), roots), null);
  assert.strictEqual(decide(write(path.join(project, "memory", "MEMORY.md")), roots), null);
  assert.strictEqual(decide(write(path.join(project, "memory", "sub", "deep.md")), roots), null);

  for (const denied of [
    path.join(project, "other.md"),
    transcript,
    path.join(project, "memory"),
    `${path.join(project, "memory")}${path.sep}..${path.sep}escaped.md`,
    path.join(other, "memory", "note.md"),
    path.join(projects, "..", "settings.json"),
  ]) {
    assert.match(decide(write(denied), roots), /outside the repository/, denied);
  }
  const note = { file_path: path.join(project, "memory", "note.md") };
  assert.match(decide({ tool_input: note }, roots), /outside the repository/, "no transcript_path");
  for (const bad of [null, 42, "relative/session.jsonl", path.join(project, "notes.txt")]) {
    assert.match(decide({ transcript_path: bad, tool_input: note }, roots), /outside the repository/, String(bad));
  }

  const away = path.join(tmp, `memory-escape-${process.pid}`);
  fs.mkdirSync(away, { recursive: true });
  fs.symlinkSync(away, path.join(project, "memory", "escape"), "junction");
  assert.match(decide(write(path.join(project, "memory", "escape", "x.md")), roots), /outside the repository/);
});

test("protect: a memory folder that is itself a link, or sits inside a repo, gains nothing", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const project = path.join(fs.mkdtempSync(path.join(tmp, "claude-home-")), ".claude", "projects", "D--work-repo");
  const away = path.join(tmp, `memory-target-${process.pid}-${Date.now()}`);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(away, { recursive: true });
  fs.symlinkSync(away, path.join(project, "memory"), "junction");
  const transcript = path.join(project, "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d.jsonl");
  assert.match(decide({ transcript_path: transcript, tool_input: { file_path: path.join(project, "memory", "x.md") } }, roots), /outside the repository/);

  const inRepo = path.join(repo, "tests", "krites");
  fs.mkdirSync(path.join(inRepo, "memory"), { recursive: true });
  const inRepoTranscript = path.join(inRepo, "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d.jsonl");
  assert.match(decide({ transcript_path: inRepoTranscript, tool_input: { file_path: path.join(inRepo, "memory", "x.md") } }, roots), /is protected/);
});

test("protect: a memory folder that cannot be resolved never blocks edits inside the repo", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const project = path.join(fs.mkdtempSync(path.join(tmp, "claude-home-")), ".claude", "projects", "D--work-repo");
  fs.mkdirSync(project, { recursive: true });
  fs.symlinkSync(path.join(tmp, `gone-${process.pid}-${Date.now()}`), path.join(project, "memory"), "junction");
  const payload = (file) => ({ transcript_path: path.join(project, "s.jsonl"), tool_input: { file_path: file } });
  assert.strictEqual(decide(payload(path.join(repo, "src", "lib.rs")), roots), null);
  assert.match(decide(payload(path.join(project, "memory", "x.md")), roots), /outside the repository|could not be resolved/);
});

test("protect: the deepest root decides which globs apply", () => {
  const repo = makeRepo({
    files: { "krites.toml": 'version = 1\n\n[protect]\nglobs = ["**/secret.txt"]\n', "inner/krites.toml": 'version = 1\n\n[protect]\nglobs = ["own.txt"]\n' },
  });
  const inner = path.join(repo, "inner");
  for (const roots of [findRoots({ cwd: inner, projectDir: repo, processCwd: tmp }), findRoots({ cwd: repo, projectDir: inner, processCwd: tmp })]) {
    assert.strictEqual(roots.length, 2);
    assert.match(decide(input(path.join(inner, "own.txt")), roots), /own\.txt is protected/);
    assert.strictEqual(decide(input(path.join(inner, "secret.txt")), roots), null, "the inner root decides, and it does not protect secret.txt");
    assert.match(decide(input(path.join(repo, "secret.txt")), roots), /secret\.txt is protected/);
  }
});

test("protect: a colon in the relative path denies on Windows", async () => {
  if (!WINDOWS) return;
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  assertDeny(await runHook(PROTECT, edit({ file_path: `${path.join(repo, "a.txt")}:stream` }, repo)), /a\.txt:stream/);
});

const slash = (file) => file.replace(/\\/g, "/");
const allowing = (...globs) => `[protect]\nallow_outside = [${globs.map((glob) => JSON.stringify(glob)).join(", ")}]\n`;

// decide() reads the user config and the home directory from the environment on every call.
function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const withUserConfig = (text, fn) => withEnv({ KRITES_CONFIG_DIR: makeDir(text === null ? {} : { "config.toml": text }) }, fn);

test("protect: allow_outside in the user config opens its globs outside the repo and nothing else", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const work = makeDir({ "keep.md": "" });
  const other = makeDir();

  withUserConfig(allowing(`${slash(work)}/**`), () => {
    assert.strictEqual(decide(input(path.join(work, "keep.md")), roots), null);
    assert.strictEqual(decide(input(path.join(work, "new", "deep", "plan.md")), roots), null);
    assert.strictEqual(decide(input(path.join(repo, "src", "lib.rs")), roots), null);
    assert.match(decide(input(path.join(other, "x.md")), roots), /outside the repository/);
    assert.match(decide(input(work), roots), /outside the repository/, "the glob opens what is under the folder, not the folder");
    assert.match(decide(input(path.join(repo, "tests", "krites", "x.rs")), roots), /is protected/, "the repo's own globs still decide inside it");
  });
  withUserConfig(null, () => assert.match(decide(input(path.join(work, "keep.md")), roots), /outside the repository/));
});

test("protect: a link from an allowed folder to a target outside every glob is denied", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const work = makeDir();
  const away = makeDir();
  fs.symlinkSync(away, path.join(work, "away"), "junction");

  withUserConfig(allowing(`${slash(work)}/**`), () => {
    assert.match(decide(input(path.join(work, "away", "x.md")), roots), /outside the repository/);
  });

  const base = makeDir({ "keys/config.toml": allowing(`${slash(work)}/**`) });
  const keys = path.join(base, "keys");
  fs.writeFileSync(path.join(keys, "config.toml"), allowing(`${slash(base)}/**`, `${slash(work)}/**`));
  fs.symlinkSync(keys, path.join(work, "keys"), "junction");
  withEnv({ KRITES_CONFIG_DIR: keys }, () => {
    assert.strictEqual(decide(input(path.join(base, "notes.md")), roots), null);
    for (const denied of [path.join(keys, "config.toml"), path.join(work, "keys", "config.toml"), path.join(work, "keys", "signing-key.pem")]) {
      assert.match(decide(input(denied), roots), /own configuration, which allow_outside never opens/, denied);
    }
  });
});

test("protect: allow_outside follows the file system's case and trailing-dot rules", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const home = makeDir({ "work/keep.md": "", ".config/krites/config.toml": allowing("~/**") });
  const folds = WINDOWS || process.platform === "darwin";
  withEnv({ HOME: home, USERPROFILE: home, KRITES_CONFIG_DIR: path.join(home, ".config", "krites") }, () => {
    const key = path.join(home, ".config", "KRITES", "signing-key.pem");
    const settings = path.join(home, ".CLAUDE", "settings.json");
    for (const denied of [key, settings]) assert.match(decide(input(denied), roots), /own configuration/, `${denied}: closed in any case, on any file system`);
  });
  withUserConfig(allowing(`${slash(home)}/work/**`), () => {
    const upper = decide(input(path.join(home, "WORK", "x.md")), roots);
    const dotted = decide(input(path.join(home, "work.", "x.md")), roots);
    if (folds) assert.strictEqual(upper, null);
    else assert.match(upper, /outside the repository/);
    if (WINDOWS) assert.strictEqual(dotted, null, "Win32 drops the trailing dot, so work. is work");
    else assert.match(dotted, /outside the repository/, "work. is its own folder");
  });
});

test("protect: a user config that cannot be read denies every outside write", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const keys = makeDir({ "config.toml/inside.txt": "" });
  withEnv({ KRITES_CONFIG_DIR: keys }, () => {
    assert.match(decide(input(path.join(makeDir(), "x.md")), roots), /config\.toml in the Krites config directory could not be read \(E[A-Z]+\)/);
  });
});

test("protect: allow_outside = [\"~/**\"] still denies the signing key, the user config and ~/.claude", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const home = makeDir({ ".claude/settings.json": "{}\n", ".config/krites/config.toml": allowing("~/**") });
  const project = path.join(home, ".claude", "projects", "D--work-repo");
  fs.mkdirSync(path.join(project, "memory"), { recursive: true });
  const transcript = path.join(project, "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d.jsonl");
  fs.writeFileSync(transcript, "");
  const env = { HOME: home, USERPROFILE: home, KRITES_CONFIG_DIR: path.join(home, ".config", "krites") };

  withEnv(env, () => {
    assert.strictEqual(os.homedir(), home, "the home directory comes from the environment");
    assert.strictEqual(decide(input(path.join(home, "notes", "x.md")), roots), null);
    for (const denied of [
      path.join(home, ".config", "krites", "signing-key.pem"),
      path.join(home, ".config", "krites", "config.toml"),
      path.join(home, ".claude", "settings.json"),
      path.join(home, ".claude", "CLAUDE.md"),
      path.join(home, ".claude"),
      ...(WINDOWS ? [path.join(home, ".claude.", "settings.json"), path.join(home, ".claude ", "settings.json")] : []),
    ]) {
      assert.match(decide(input(denied), roots), /Claude Code's or Krites's own configuration/, denied);
    }
    assert.strictEqual(
      decide({ transcript_path: transcript, tool_input: { file_path: path.join(project, "memory", "note.md") } }, roots),
      null,
      "the project memory folder keeps its own exception",
    );
  });
});

test("protect: the README's scratchpad line opens a session scratchpad and nothing beside or above it", () => {
  const block = '[protect]\nallow_outside = ["~/AppData/Local/Temp/claude/*/*/scratchpad/**"]\n';
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(readme.includes(`\`\`\`toml\n${block}\`\`\``), "the README shows this exact block");
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const home = makeDir({ ".claude/settings.json": "{}\n", ".config/krites/config.toml": block });
  const claude = path.join(home, "AppData", "Local", "Temp", "claude");
  const session = path.join(claude, "D--work-repo", "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d");

  withEnv({ HOME: home, USERPROFILE: home, KRITES_CONFIG_DIR: path.join(home, ".config", "krites") }, () => {
    assert.strictEqual(decide(input(path.join(session, "scratchpad", "probe.js")), roots), null);
    assert.strictEqual(decide(input(path.join(session, "scratchpad", "spin", "build.js")), roots), null);
    for (const denied of [
      path.join(session, "scratchpad"),
      path.join(session, "notes", "a.js"),
      path.join(claude, "D--work-repo", "a.js"),
      path.join(claude, "a.js"),
      path.join(home, "AppData", "Local", "Temp", "a.js"),
      path.join(home, ".claude", "settings.json"),
    ]) {
      assert.match(decide(input(denied), roots), /outside the repository/, denied);
    }
  });
});

test("protect: allow_outside = [\"~/**\"] still denies ~/.claude.json itself, and only that file", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const home = makeDir({ ".claude.json": "{}\n", ".config/krites/config.toml": allowing("~/**") });
  const env = { HOME: home, USERPROFILE: home, KRITES_CONFIG_DIR: path.join(home, ".config", "krites"), CLAUDE_CONFIG_DIR: undefined };

  withEnv(env, () => {
    for (const denied of [
      path.join(home, ".claude.json"),
      path.join(home, ".CLAUDE.JSON"),
      path.join(home, ".claude-custom-oauth.json"),
      ...(WINDOWS ? [path.join(home, ".claude.json.")] : []),
    ]) {
      assert.match(decide(input(denied), roots), /Claude Code's or Krites's own configuration/, denied);
    }
    assert.strictEqual(decide(input(path.join(home, ".claude.json.bak")), roots), null, "an exact match, not a prefix");
  });

  if (WINDOWS) return;
  const linked = makeDir({ "dotfiles/claude.json": "{}\n", ".config/krites/config.toml": allowing("~/**") });
  fs.symlinkSync(path.join(linked, "dotfiles", "claude.json"), path.join(linked, ".claude.json"));
  withEnv({ ...env, HOME: linked, USERPROFILE: linked, KRITES_CONFIG_DIR: path.join(linked, ".config", "krites") }, () => {
    assert.match(decide(input(path.join(linked, "dotfiles", "claude.json")), roots), /own configuration/, "the real path of a linked ~/.claude.json");
  });
});

test("protect: $CLAUDE_CONFIG_DIR is closed while it is set, inside home or out", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const home = makeDir({ "claude-alt/settings.json": "{}\n", ".config/krites/config.toml": allowing("~/**") });
  const alt = path.join(home, "claude-alt");
  const away = makeDir({ "settings.json": "{}\n" });
  const env = { HOME: home, USERPROFILE: home, KRITES_CONFIG_DIR: path.join(home, ".config", "krites") };

  withEnv({ ...env, CLAUDE_CONFIG_DIR: alt }, () => {
    assert.match(decide(input(path.join(alt, "settings.json")), roots), /Claude Code's or Krites's own configuration/);
    assert.match(decide(input(alt), roots), /own configuration/);
  });
  fs.writeFileSync(path.join(home, ".config", "krites", "config.toml"), allowing("~/**", `${slash(away)}/**`));
  withEnv({ ...env, CLAUDE_CONFIG_DIR: away }, () => {
    assert.match(decide(input(path.join(away, "settings.json")), roots), /own configuration/, "an allow_outside glob covering it opens nothing");
  });
  for (const unset of [undefined, ""]) {
    withEnv({ ...env, CLAUDE_CONFIG_DIR: unset }, () => {
      assert.strictEqual(decide(input(path.join(alt, "settings.json")), roots), null, `CLAUDE_CONFIG_DIR=${JSON.stringify(unset)}`);
    });
  }
  withEnv({ ...env, CLAUDE_CONFIG_DIR: "claude-alt", CLAUDE_PROJECT_DIR: home }, () => {
    assert.match(decide(input(path.join(alt, "settings.json")), roots), /own configuration/, "a relative value, from the project dir");
  });
  const cwd = process.cwd();
  process.chdir(home);
  try {
    withEnv({ ...env, CLAUDE_CONFIG_DIR: "claude-alt", CLAUDE_PROJECT_DIR: undefined }, () => {
      assert.match(decide(input(path.join(alt, "settings.json")), roots), /own configuration/, "a relative value, from the cwd");
    });
  } finally {
    process.chdir(cwd);
  }
});

test("protect: an empty $CLAUDE_CONFIG_DIR is unset, so ~/.claude stays closed and the cwd stays open", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const home = makeDir({ ".claude/x": "x\n", "work/y.txt": "y\n", ".config/krites/config.toml": allowing("~/**") });
  const env = { HOME: home, USERPROFILE: home, KRITES_CONFIG_DIR: path.join(home, ".config", "krites"), CLAUDE_CONFIG_DIR: "" };
  const cwd = process.cwd();
  process.chdir(path.join(home, "work"));
  try {
    withEnv({ ...env, CLAUDE_PROJECT_DIR: path.join(home, "work") }, () => {
      assert.match(decide(input(path.join(home, ".claude", "x")), roots), /own configuration/);
      assert.strictEqual(decide(input(path.join(home, "work", "y.txt")), roots), null, "the cwd is not a Claude config dir");
    });
  } finally {
    process.chdir(cwd);
  }
});

test("protect: a $CLAUDE_CONFIG_DIR written with trailing dots or spaces is closed as the folder Windows opens", { skip: !WINDOWS }, () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const home = makeDir({ "claude-alt/settings.json": "{}\n", ".config/krites/config.toml": allowing("~/**") });
  const env = { HOME: home, USERPROFILE: home, KRITES_CONFIG_DIR: path.join(home, ".config", "krites") };
  fs.mkdirSync(path.join(home, "claude-dot."));
  for (const [value, target] of [
    [path.join(home, "claude-alt."), path.join(home, "claude-alt", "settings.json")],
    [path.join(home, "claude-alt "), path.join(home, "claude-alt", "settings.json")],
    [path.join(home, "claude-dot."), path.join(home, "claude-dot.", "settings.json")],
  ]) {
    withEnv({ ...env, CLAUDE_CONFIG_DIR: value }, () => {
      assert.match(decide(input(target), roots), /own configuration/, JSON.stringify(value));
    });
  }
});

test("protect: a user config that does not load denies every outside write with its line and key, and no edit inside the repo", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const work = makeDir();
  withUserConfig(allowing(`${slash(work)}/**`, "relative/**"), () => {
    const reason = decide(input(path.join(work, "x.md")), roots);
    assert.match(reason, /config\.toml in the Krites config directory, line 2: protect\.allow_outside entries are absolute paths or start with ~\//);
    assert.doesNotMatch(reason, ABSOLUTE);
    assert.strictEqual(decide(input(path.join(repo, "src", "lib.rs")), roots), null);
  });
});

test("protect: on Windows allow_outside matches a target on another drive by its drive letter", () => {
  if (!WINDOWS) return;
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const drive = repo[0].toUpperCase() === "Q" ? "R" : "Q";
  withUserConfig(allowing(`${drive.toLowerCase()}:/Elsewhere/**`), () => {
    assert.strictEqual(decide(input(`${drive}:\\elsewhere\\x.txt`), roots), null);
    assert.match(decide(input(`${drive}:\\other\\x.txt`), roots), /outside the repository/);
    assert.match(decide(input(`${drive}:\\elsewhere\\x.txt:s`), roots), /alternate data stream/);
    assert.strictEqual(decide(input(`${drive}:\\elsewhere.\\x.txt`), roots), null, "Win32 drops the trailing dot, so the write lands in the allowed folder");
  });
});

const FIXTURES_ONLY = 'version = 1\n\n[protect]\nglobs = ["fixtures/**"]\n';

function nestedIn(outer, rel, files) {
  const nested = path.join(outer, ...rel.split("/"));
  fs.mkdirSync(nested, { recursive: true });
  gitInit(nested);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(nested, name)), { recursive: true });
    fs.writeFileSync(path.join(nested, name), content);
  }
  return nested;
}

test("protect: a nested repo's own globs apply to its files from a session at the outer repo", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY });
  assertDeny(await runHook(PROTECT, edit({ file_path: path.join(nested, "fixtures", "a.txt") }, repo)), /: fixtures\/a\.txt is protected/);
  assert.deepStrictEqual(await runHook(PROTECT, edit({ file_path: path.join(nested, "src", "a.rs") }, repo)), SILENT);
});

test("protect: a git worktree inside the session's repo is held to its own krites.toml", () => {
  const repo = makeRepo({ files: { "krites.toml": FIXTURES_ONLY } });
  const tree = path.join(repo, "target", "wt", "x");
  assert.strictEqual(git(repo, "worktree", "add", "-q", "-b", "x", tree).status, 0);
  assert.ok(fs.statSync(path.join(tree, ".git")).isFile());
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.match(decide(input(path.join(tree, "fixtures", "a.txt")), roots), /: fixtures\/a\.txt is protected/);
});

test("protect: the outer repo's globs still apply inside a nested root", () => {
  const repo = makeRepo({ files: { "krites.toml": 'version = 1\n\n[protect]\nglobs = [".claude/**"]\n' } });
  const nested = nestedIn(repo, ".claude/worktrees/x", { "krites.toml": 'version = 1\n\n[protect]\nglobs = ["tests/**"]\n' });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.match(decide(input(path.join(nested, "src", "a.rs")), roots), /\.claude\/worktrees\/x\/src\/a\.rs is protected/);
  assert.match(decide(input(path.join(nested, "tests", "a")), roots), /: \.claude\/worktrees\/x\/tests\/a is protected/, "the outer root is asked first");
});

test("protect: a plain repo between a nested root and the target does not end the walk", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY });
  const plain = nestedIn(nested, "fixtures/sub", { "a.txt": "a\n" });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.match(decide(input(path.join(plain, "a.txt")), roots), /: fixtures\/sub\/a\.txt is protected/);
});

test("protect: every nested level is held to its own globs, the innermost named first", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const outer = nestedIn(repo, "target/wt/x", { "krites.toml": 'version = 1\n\n[protect]\nglobs = ["vendor/**"]\n' });
  const inner = nestedIn(outer, "vendor/y", { "krites.toml": 'version = 1\n\n[protect]\nglobs = ["docs/**"]\n' });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.match(decide(input(path.join(inner, "docs", "a.md")), roots), /: docs\/a\.md is protected/);
  assert.match(decide(input(path.join(inner, "src", "a.rs")), roots), /: vendor\/y\/src\/a\.rs is protected/);
});

test("protect: the walk starts no process, so a planted .git cannot hold the hook past its timeout", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY });
  for (const dir of [path.join(repo, "target"), path.join(repo, "target", "wt")]) fs.writeFileSync(path.join(dir, ".git"), "gitdir: //192.0.2.1/share/x\n");
  const child = require("node:child_process");
  const { spawnSync } = child;
  const file = require.resolve("../lib/config.js");
  const cached = require.cache[file];
  const calls = [];
  child.spawnSync = (...args) => (calls.push(args), spawnSync(...args));
  try {
    delete require.cache[file];
    const found = require(file).enclosingRoots(path.join(nested, "fixtures", "a.txt"), repo);
    assert.deepStrictEqual(found.map((entry) => entry.root), [fs.realpathSync.native(nested), fs.realpathSync.native(repo)]);
  } finally {
    child.spawnSync = spawnSync;
    require.cache[file] = cached;
  }
  assert.deepStrictEqual(calls, []);
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.match(decide(input(path.join(nested, "fixtures", "a.txt")), roots), /: fixtures\/a\.txt is protected/);
});

test("protect: a nested repo whose committed krites.toml is missing from its tree is not a root of its own", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY });
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "config");
  fs.unlinkSync(path.join(nested, "krites.toml"));
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.strictEqual(decide(input(path.join(nested, "fixtures", "a.txt")), roots), null);
});

test("protect: a session rooted in a worktree under .claude is not held to the outer .claude/** glob", () => {
  const repo = makeRepo({ files: { "krites.toml": 'version = 1\n\n[protect]\nglobs = [".claude/**"]\n' } });
  const nested = nestedIn(repo, ".claude/worktrees/x", { "krites.toml": 'version = 1\n\n[protect]\nglobs = ["tests/**"]\n' });
  const roots = findRoots({ cwd: nested, projectDir: repo, processCwd: tmp });
  assert.strictEqual(decide(input(path.join(nested, "src", "a.rs")), roots), null);
  assert.match(decide(input(path.join(nested, "tests", "a")), roots), /: tests\/a is protected/);
});

test("protect: a nested plain git repo leaves the outer repo's globs on the outer path", () => {
  const repo = makeRepo({ files: { "krites.toml": 'version = 1\n\n[protect]\nglobs = ["fixtures/**", "target/wt/x/keep/**"]\n' } });
  const nested = nestedIn(repo, "target/wt/x", {});
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.strictEqual(decide(input(path.join(nested, "fixtures", "a.txt")), roots), null);
  assert.match(decide(input(path.join(nested, "keep", "a.txt")), roots), /target\/wt\/x\/keep\/a\.txt is protected/);
});

test("protect: a nested root whose config does not load blocks edits below it", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  const broken = nestedIn(repo, "target/wt/broken", { "krites.toml": "version = 1\n\n[checks]\nnope = 1\n" });
  const own = (rel) => `^Blocked: ${rel} is a Krites root of its own whose config cannot be used: `;
  const fix = (rel) => ` Fix it from a session started in ${rel}\\.$`;
  assert.match(decide(input(path.join(broken, "src", "a.rs")), roots), new RegExp(`${own("target/wt/broken")}krites\\.toml line 4: .*${fix("target/wt/broken")}`));
  const gated = nestedIn(repo, "target/wt/gated", { ".krites/session-head": `${"a".repeat(40)}\n` });
  assert.match(decide(input(path.join(gated, "src", "a.rs")), roots), new RegExp(`${own("target/wt/gated")}.*gated before[^]*README on how to stop gating a repo\\.$`));
  assert.strictEqual(decide(input(path.join(repo, "src", "a.rs")), roots), null);
});

test("protect: a nested root's relative path folds trailing dots and spaces", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.match(decide(input(path.join(nested, "fixtures.", "a.txt")), roots), /: fixtures\/a\.txt is protected/);
  assert.match(decide(input(path.join(nested, "fixtures ", "a.txt")), roots), /: fixtures\/a\.txt is protected/);
});

test("protect: an unprotected file in a nested root is allowed", () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY });
  const roots = findRoots({ cwd: repo, processCwd: tmp });
  assert.strictEqual(decide(input(path.join(nested, "src", "a.rs")), roots), null);
  assert.strictEqual(decide(input(path.join(nested, "new", "deep", "b.md")), roots), null);
});

const touchedLines = (repo) => {
  try {
    return fs.readFileSync(path.join(repo, ".krites", "touched"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const committed = (dir) => (git(dir, "add", "-A"), git(dir, "commit", "-qm", "init"), dir);
const editAs = (sessionId, file, cwd) => ({ ...edit({ file_path: file }, cwd), session_id: sessionId });

test("protect: an allowed edit in a nested root records it once per session, with its HEAD, and writes nothing in it", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = committed(nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY }));
  assertDeny(await runHook(PROTECT, editAs("s1", path.join(nested, "fixtures", "a.txt"), repo)), /fixtures\/a\.txt is protected/);
  assert.deepStrictEqual(touchedLines(repo), [], "a denied edit records nothing");
  assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(nested, "src", "a.rs"), repo)), SILENT);
  const line = `s1\t${fs.realpathSync.native(nested)}\t${head(nested)}`;
  assert.deepStrictEqual(touchedLines(repo), [line]);
  git(nested, "commit", "-q", "--allow-empty", "-m", "later");
  assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(nested, "src", "b.rs"), repo)), SILENT);
  assert.deepStrictEqual(touchedLines(repo), [line], "the head at the first touch stays");
  assert.ok(!fs.existsSync(path.join(nested, ".krites")), "nothing is written in the nested root");
});

test("protect: an edit in the session root itself, or with no usable session id, records nothing", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = committed(nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY }));
  assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(repo, "src", "a.rs"), repo)), SILENT);
  for (const id of [undefined, 7, "", "a b", "../x", "s\t1", "x".repeat(65)]) {
    assert.deepStrictEqual(await runHook(PROTECT, editAs(id, path.join(nested, "src", "a.rs"), repo)), SILENT);
  }
  assert.deepStrictEqual(touchedLines(repo), []);
});

test("protect: a record that cannot be written leaves the decision alone", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = committed(nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY }));
  fs.mkdirSync(path.join(repo, ".krites", "touched", "held"), { recursive: true });
  assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(nested, "src", "a.rs"), repo)), SILENT);
  assertDeny(await runHook(PROTECT, editAs("s1", path.join(nested, "fixtures", "a.txt"), repo)), /fixtures\/a\.txt is protected/);
});

test("protect: past 4096 lines the hook still only appends, and leaves the trim to the gate", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = committed(nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY }));
  assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(nested, "src", "a.rs"), repo)), SILENT);
  const others = Array.from({ length: 4200 }, (_, i) => `o${i}\t${path.join(repo, "target", "wt", `y${i}`)}\t`);
  fs.appendFileSync(path.join(repo, ".krites", "touched"), `${others.join("\n")}\n`);
  const second = committed(nestedIn(repo, "target/wt/z", { "krites.toml": FIXTURES_ONLY }));
  assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(second, "src", "a.rs"), repo)), SILENT);
  const lines = touchedLines(repo);
  assert.strictEqual(lines.length, 4202);
  assert.deepStrictEqual(lines.slice(1, 4201), others);
  assert.strictEqual(lines[4201], `s1\t${fs.realpathSync.native(second)}\t${head(second)}`);
  assert.deepStrictEqual(fs.readdirSync(path.join(repo, ".krites")).sort(), [".gitignore", "touched"], "no temp file");
});

// A file symlink needs a privilege Windows rarely grants, so a junction to a folder stands in for it there.
function plantLink(at, outside) {
  try {
    fs.writeFileSync(path.join(outside, "victim.txt"), "kept\n");
    fs.symlinkSync(path.join(outside, "victim.txt"), at, "file");
  } catch {
    fs.symlinkSync(outside, at, "junction");
  }
}

test("protect: a link planted at the touched file or at .krites gets nothing written through it and is left in place", async () => {
  for (const at of [".krites/touched", ".krites"]) {
    const repo = makeRepo({ files: { "krites.toml": CONFIG } });
    const nested = committed(nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY }));
    const outside = makeDir();
    if (at !== ".krites") fs.mkdirSync(path.join(repo, ".krites"));
    plantLink(path.join(repo, ...at.split("/")), outside);
    assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(nested, "src", "a.rs"), repo)), SILENT);
    assert.ok(fs.lstatSync(path.join(repo, ...at.split("/"))).isSymbolicLink(), `${at} is not replaced`);
    const left = fs.readdirSync(outside);
    assert.ok(left.length === 0 || (left.length === 1 && fs.readFileSync(path.join(outside, "victim.txt"), "utf8") === "kept\n"), `nothing lands through ${at}`);
  }
});

test("protect: a .krites that is a file is left alone and the edit is still allowed", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG, ".krites": "not a folder\n" } });
  const nested = committed(nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY }));
  assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(nested, "src", "a.rs"), repo)), SILENT);
  assert.strictEqual(fs.readFileSync(path.join(repo, ".krites"), "utf8"), "not a folder\n");
});

test("protect: records from hook processes running at once all survive", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  fs.mkdirSync(path.join(repo, ".krites"));
  const nested = Array.from({ length: 8 }, (_, i) => committed(nestedIn(repo, `target/wt/x${i}`, { "krites.toml": FIXTURES_ONLY })));
  const results = await Promise.all(nested.map((dir) => runHook(PROTECT, editAs("s1", path.join(dir, "src", "a.rs"), repo))));
  for (const result of results) assert.deepStrictEqual(result, SILENT);
  assert.deepStrictEqual(touchedLines(repo).sort(), nested.map((dir) => `s1\t${fs.realpathSync.native(dir)}\t${head(dir)}`).sort());
});

test("protect: a deny on a later path key records nothing for the earlier one, and a repo with no commits records an empty head", async () => {
  const repo = makeRepo({ files: { "krites.toml": CONFIG } });
  const nested = committed(nestedIn(repo, "target/wt/x", { "krites.toml": FIXTURES_ONLY }));
  const both = { ...edit({ file_path: path.join(nested, "src", "a.rs"), notebook_path: path.join(nested, "fixtures", "a.ipynb") }, repo), session_id: "s1" };
  assertDeny(await runHook(PROTECT, both), /fixtures\/a\.ipynb is protected/);
  assert.deepStrictEqual(touchedLines(repo), []);
  const fresh = nestedIn(repo, "target/wt/fresh", { "krites.toml": FIXTURES_ONLY });
  assert.deepStrictEqual(await runHook(PROTECT, editAs("s1", path.join(fresh, "src", "a.rs"), repo)), SILENT);
  assert.deepStrictEqual(touchedLines(repo), [`s1\t${fs.realpathSync.native(fresh)}\t`]);
});
