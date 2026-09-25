const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MANAGED = { darwin: "/Library/Application Support/ClaudeCode", win32: "C:\\Program Files\\ClaudeCode" };
const PLUGIN = "krites@";
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

// undefined when the file is absent, null when it is there but holds no settings object.
function read(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return ABSENT.has(err.code) ? undefined : null;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ""));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Lowest precedence first. Managed files are shown relative to their directory, since output keeps no absolute path.
function sources(root, managedDir) {
  const config = process.env.CLAUDE_CONFIG_DIR;
  const project = process.env.CLAUDE_PROJECT_DIR || root;
  const user = config
    ? [path.join(config, "settings.json"), "$CLAUDE_CONFIG_DIR/settings.json"]
    : [path.join(os.homedir(), ".claude", "settings.json"), "~/.claude/settings.json"];
  let dropIns;
  try {
    dropIns = fs.readdirSync(path.join(managedDir, "managed-settings.d")).filter((name) => name.endsWith(".json")).sort();
  } catch {
    dropIns = [];
  }
  return [
    [...user, false],
    [path.join(project, ".claude", "settings.json"), ".claude/settings.json", false],
    [path.join(project, ".claude", "settings.local.json"), ".claude/settings.local.json", false],
    [path.join(managedDir, "managed-settings.json"), "managed-settings.json", true],
    ...dropIns.map((name) => [path.join(managedDir, "managed-settings.d", name), `managed-settings.d/${name}`, true]),
  ];
}

const defaultManaged = () => process.env.KRITES_MANAGED_SETTINGS_DIR || MANAGED[process.platform] || "/etc/claude-code";

/**
 * Returns { off, unreadable }: off is null or the file and key that turn Krites' hooks off (definite) or may
 * (allowManagedHooksOnly); unreadable lists the settings files that exist but hold no settings object.
 */
function survey(root, { managedDir = defaultManaged() } = {}) {
  const won = new Map();
  const unreadable = [];
  for (const [rank, [file, shown, managed]] of sources(root, managedDir).entries()) {
    const settings = read(file);
    if (settings === undefined) continue;
    if (settings === null) {
      unreadable.push(shown);
      continue;
    }
    // A value that is not a boolean counts as unset: it neither sets the key nor hides a lower file's.
    const set = (key, value) => typeof value === "boolean" && won.set(key, { value, file: shown, rank });
    set("disableAllHooks", settings.disableAllHooks);
    if (managed) set("allowManagedHooksOnly", settings.allowManagedHooksOnly);
    const plugins = settings.enabledPlugins;
    if (plugins === null || typeof plugins !== "object") continue;
    for (const [id, on] of Object.entries(plugins)) if (id.startsWith(PLUGIN)) set(`enabledPlugins[${JSON.stringify(id)}]`, on);
  }
  const offs = ([key, { value }]) => (key === "disableAllHooks" ? value === true : key.startsWith("enabledPlugins") && value === false);
  const top = [...won].filter(offs).reduce((best, hit) => (best === null || hit[1].rank > best[1].rank ? hit : best), null);
  if (top !== null) return { off: { file: top[1].file, key: top[0], definite: true }, unreadable };
  const only = won.get("allowManagedHooksOnly");
  const off = only && only.value === true ? { file: only.file, key: "allowManagedHooksOnly", definite: false } : null;
  return { off, unreadable };
}

const hooksOff = (root, options) => survey(root, options).off;
const describe = (off) => `Krites hooks ${off.definite ? "are off" : "may be disabled"} for this repo: ${off.file} sets ${off.key}.`;
const unknown = (file) => `Krites cannot read ${file}, so its hooks setting is unknown.`;

module.exports = { describe, hooksOff, survey, unknown };
