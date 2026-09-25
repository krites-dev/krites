const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const settings = require("../lib/settings.js");
const { makeDir, runHook, script, tmp } = require("./helpers.js");

const OFF = JSON.stringify({ disableAllHooks: true });

// Every case gets its own user, managed and repo directories, so no real settings file is ever consulted.
function world({ user, home, project, local, managed, dropIns = {} } = {}) {
  const userDir = makeDir(user === undefined ? {} : { "settings.json": user });
  const homeDir = makeDir(home === undefined ? {} : { ".claude/settings.json": home });
  const repo = makeDir({
    ...(project === undefined ? {} : { ".claude/settings.json": project }),
    ...(local === undefined ? {} : { ".claude/settings.local.json": local }),
  });
  const managedDir = makeDir({
    ...(managed === undefined ? {} : { "managed-settings.json": managed }),
    ...Object.fromEntries(Object.entries(dropIns).map(([name, text]) => [`managed-settings.d/${name}`, text])),
  });
  return { userDir, homeDir, repo, managedDir };
}

// Runs survey with CLAUDE_CONFIG_DIR at the temp user directory and CLAUDE_PROJECT_DIR unset, or with the env given.
function survey(w, { viaHome = false, env = {} } = {}) {
  const home = viaHome ? { CLAUDE_CONFIG_DIR: undefined, HOME: w.homeDir, USERPROFILE: w.homeDir } : {};
  const wanted = { CLAUDE_CONFIG_DIR: w.userDir, CLAUDE_PROJECT_DIR: undefined, ...home, ...env };
  const saved = Object.fromEntries(Object.keys(wanted).map((name) => [name, process.env[name]]));
  const put = (vars) => {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    put(wanted);
    return settings.survey(w.repo, { managedDir: w.managedDir });
  } finally {
    put(saved);
  }
}
const off = (w, options) => survey(w, options).off;

test("settings: disableAllHooks in each file names that file", () => {
  const cases = [
    [{ user: OFF }, "$CLAUDE_CONFIG_DIR/settings.json"],
    [{ project: OFF }, ".claude/settings.json"],
    [{ local: OFF }, ".claude/settings.local.json"],
    [{ managed: OFF }, "managed-settings.json"],
    [{ dropIns: { "10-hooks.json": OFF } }, "managed-settings.d/10-hooks.json"],
  ];
  for (const [files, file] of cases) {
    assert.deepStrictEqual(off(world(files)), { file, key: "disableAllHooks", definite: true }, file);
  }
});

test("settings: with CLAUDE_CONFIG_DIR unset the user file is read from the home directory", () => {
  assert.deepStrictEqual(off(world({ home: OFF }), { viaHome: true }), { file: "~/.claude/settings.json", key: "disableAllHooks", definite: true });
  assert.strictEqual(off(world({ user: OFF }), { viaHome: true }), null, "the config dir is not read when the variable is unset");
});

test("settings: the Krites plugin turned off under any marketplace names the plugin id", () => {
  const w = world({ project: JSON.stringify({ enabledPlugins: { "other@x": false, "krites@krites": false } }) });
  assert.deepStrictEqual(off(w), { file: ".claude/settings.json", key: 'enabledPlugins["krites@krites"]', definite: true });
  const elsewhere = world({ local: JSON.stringify({ enabledPlugins: { "krites@mirror": false } }) });
  assert.deepStrictEqual(off(elsewhere), { file: ".claude/settings.local.json", key: 'enabledPlugins["krites@mirror"]', definite: true });
  assert.strictEqual(off(world({ user: JSON.stringify({ enabledPlugins: { "other@x": false } }) })), null);
});

test("settings: the highest file that sets a key wins, whichever way it sets it", () => {
  const on = JSON.stringify({ disableAllHooks: false, enabledPlugins: { "krites@krites": true } });
  const offBoth = JSON.stringify({ disableAllHooks: true, enabledPlugins: { "krites@krites": false } });
  assert.strictEqual(off(world({ user: offBoth, project: on })), null, "a higher true overrides a lower false");
  assert.strictEqual(off(world({ local: offBoth, managed: on })), null, "managed is highest");
  const plugin = world({ user: on, local: JSON.stringify({ enabledPlugins: { "krites@krites": false } }) });
  assert.deepStrictEqual(off(plugin), { file: ".claude/settings.local.json", key: 'enabledPlugins["krites@krites"]', definite: true });
  const dropIn = world({ managed: on, dropIns: { "b.json": OFF, "a.json": JSON.stringify({ disableAllHooks: false }) } });
  assert.deepStrictEqual(off(dropIn), { file: "managed-settings.d/b.json", key: "disableAllHooks", definite: true }, "drop-ins merge after the file, alphabetically");
});

test("settings: allowManagedHooksOnly is reported as may-be-off, and only from a managed file", () => {
  const only = JSON.stringify({ allowManagedHooksOnly: true });
  assert.deepStrictEqual(off(world({ managed: only })), { file: "managed-settings.json", key: "allowManagedHooksOnly", definite: false });
  assert.deepStrictEqual(off(world({ dropIns: { "x.json": only } })), { file: "managed-settings.d/x.json", key: "allowManagedHooksOnly", definite: false });
  assert.strictEqual(off(world({ user: only, project: only, local: only })), null);
  assert.deepStrictEqual(off(world({ managed: only, project: OFF })), { file: ".claude/settings.json", key: "disableAllHooks", definite: true }, "a definite off is named first");
});

test("settings: the clean case reports nothing, and a file that does not parse is named while the rest are read", () => {
  assert.strictEqual(off(world()), null);
  assert.strictEqual(off(world({ user: "{}", project: '{"enabledPlugins":{"krites@krites":true}}', managed: "{}" })), null);
  assert.deepStrictEqual(survey(world({ project: '{"disableAllHooks": true,' })), { off: null, unreadable: [".claude/settings.json"] }, "broken JSON is reported");
  const odd = survey(world({ user: "[true]", local: "null", managed: '"x"' }));
  assert.deepStrictEqual(odd, { off: null, unreadable: ["$CLAUDE_CONFIG_DIR/settings.json", ".claude/settings.local.json", "managed-settings.json"] });
  assert.deepStrictEqual(survey(world({ user: OFF, local: "{not json", managed: "" })), {
    off: { file: "$CLAUDE_CONFIG_DIR/settings.json", key: "disableAllHooks", definite: true },
    unreadable: [".claude/settings.local.json", "managed-settings.json"],
  });
  assert.deepStrictEqual(survey(world()), { off: null, unreadable: [] });
  assert.strictEqual(settings.unknown(".claude/settings.json"), "Krites cannot read .claude/settings.json, so its hooks setting is unknown.");
});

test("settings: reading writes nothing to any settings file", () => {
  const w = world({ user: OFF, home: OFF, project: OFF, local: OFF, managed: OFF, dropIns: { "a.json": OFF } });
  const files = [
    path.join(w.userDir, "settings.json"),
    path.join(w.homeDir, ".claude", "settings.json"),
    path.join(w.repo, ".claude", "settings.json"),
    path.join(w.repo, ".claude", "settings.local.json"),
    path.join(w.managedDir, "managed-settings.json"),
    path.join(w.managedDir, "managed-settings.d", "a.json"),
  ];
  const snapshot = () => files.map((file) => [fs.statSync(file).mtimeMs, fs.readFileSync(file, "utf8")]);
  const dirs = () => [w.userDir, w.homeDir, w.repo, w.managedDir].map((dir) => fs.readdirSync(dir, { recursive: true }).sort());
  const before = [snapshot(), dirs()];
  off(w);
  off(w, { viaHome: true });
  assert.deepStrictEqual([snapshot(), dirs()], before);
});

test("settings: the definite hit named is the one from the highest file, whichever key it is", () => {
  const w = world({ user: JSON.stringify({ enabledPlugins: { "krites@a": false } }), managed: OFF });
  assert.deepStrictEqual(off(w), { file: "managed-settings.json", key: "disableAllHooks", definite: true });
  const local = world({ project: OFF, local: JSON.stringify({ enabledPlugins: { "krites@a": false } }) });
  assert.deepStrictEqual(off(local), { file: ".claude/settings.local.json", key: 'enabledPlugins["krites@a"]', definite: true });
});

test("settings: a value that is not a boolean neither sets a key nor overrides a lower one", () => {
  assert.deepStrictEqual(off(world({ user: OFF, project: JSON.stringify({ disableAllHooks: "no" }) })), {
    file: "$CLAUDE_CONFIG_DIR/settings.json",
    key: "disableAllHooks",
    definite: true,
  });
  const plugin = world({ project: JSON.stringify({ enabledPlugins: { "krites@x": false } }), local: JSON.stringify({ enabledPlugins: { "krites@x": null } }) });
  assert.deepStrictEqual(off(plugin), { file: ".claude/settings.json", key: 'enabledPlugins["krites@x"]', definite: true });
  const only = world({ managed: JSON.stringify({ allowManagedHooksOnly: true }), dropIns: { "a.json": JSON.stringify({ allowManagedHooksOnly: 0 }) } });
  assert.deepStrictEqual(off(only), { file: "managed-settings.json", key: "allowManagedHooksOnly", definite: false });
  assert.strictEqual(off(world({ managed: JSON.stringify({ allowManagedHooksOnly: false }) })), null, "allowManagedHooksOnly false is not an off");
  for (const value of ["true", 1, {}, null]) {
    assert.strictEqual(off(world({ user: JSON.stringify({ disableAllHooks: value, enabledPlugins: { "krites@k": value === null ? 0 : value } }) })), null, JSON.stringify(value));
  }
});

test("settings: the suite points CLAUDE_CONFIG_DIR at an empty temp directory, in this process and its children", async () => {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  assert.ok(dir && dir.startsWith(tmp), String(dir));
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  const child = await runHook(script("process.stdout.write(process.env.CLAUDE_CONFIG_DIR || '')")[1], null);
  assert.strictEqual(child.stdout, dir);
});

test("settings: a leading byte order mark is read past", () => {
  assert.deepStrictEqual(survey(world({ local: `${String.fromCharCode(0xfeff)}${OFF}` })), {
    off: { file: ".claude/settings.local.json", key: "disableAllHooks", definite: true },
    unreadable: [],
  });
});

test("settings: project and local files come from CLAUDE_PROJECT_DIR when it is set, else from the root", () => {
  const w = world({ project: JSON.stringify({ enabledPlugins: { "krites@krites": false } }) });
  const project = makeDir({ ".claude/settings.local.json": OFF });
  assert.deepStrictEqual(off(w, { env: { CLAUDE_PROJECT_DIR: project } }), { file: ".claude/settings.local.json", key: "disableAllHooks", definite: true });
  const fromRoot = { file: ".claude/settings.json", key: 'enabledPlugins["krites@krites"]', definite: true };
  assert.deepStrictEqual(off(w), fromRoot);
  assert.deepStrictEqual(off(w, { env: { CLAUDE_PROJECT_DIR: "" } }), fromRoot, "an empty CLAUDE_PROJECT_DIR is unset");
});

test("settings: an empty CLAUDE_CONFIG_DIR is unset, so the home directory's file is read", () => {
  const w = world({ home: OFF });
  assert.deepStrictEqual(off(w, { env: { CLAUDE_CONFIG_DIR: "", HOME: w.homeDir, USERPROFILE: w.homeDir } }), { file: "~/.claude/settings.json", key: "disableAllHooks", definite: true });
});

test("settings: KRITES_MANAGED_SETTINGS_DIR moves the managed directory, and the suite points it at an empty one", () => {
  const dir = process.env.KRITES_MANAGED_SETTINGS_DIR;
  assert.ok(dir && dir.startsWith(tmp), String(dir));
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  const managed = makeDir({ "managed-settings.json": OFF });
  const saved = process.env.KRITES_MANAGED_SETTINGS_DIR;
  try {
    process.env.KRITES_MANAGED_SETTINGS_DIR = managed;
    assert.deepStrictEqual(settings.hooksOff(makeDir()), { file: "managed-settings.json", key: "disableAllHooks", definite: true });
  } finally {
    process.env.KRITES_MANAGED_SETTINGS_DIR = saved;
  }
});

test("settings: a folder where a settings file should be is named as unreadable, and the rest are still read", () => {
  const w = world({ user: OFF, managed: JSON.stringify({ allowManagedHooksOnly: true }) });
  fs.mkdirSync(path.join(w.repo, ".claude", "settings.json"), { recursive: true });
  fs.mkdirSync(path.join(w.managedDir, "managed-settings.d", "x.json"), { recursive: true });
  assert.deepStrictEqual(survey(w), {
    off: { file: "$CLAUDE_CONFIG_DIR/settings.json", key: "disableAllHooks", definite: true },
    unreadable: [".claude/settings.json", "managed-settings.d/x.json"],
  });
});
