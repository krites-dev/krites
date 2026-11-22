const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { configDir } = require("./sign.js");
const { retrying, sha256 } = require("./state.js");

const FILE = "trusted-configs.json";
const HASH = /^[0-9a-f]{64}$/;

const UNAPPROVED_SESSION =
  "krites.toml is not approved for this repo yet, so its checks will not run until you review it with /krites:init and approve it with /krites:init-write.";
const CHANGED_SESSION =
  "krites.toml changed since you last approved it, so its checks will not run until you review it with /krites:init and approve it with /krites:init-write.";
const UNAPPROVED_STOP =
  "Krites blocked the stop: krites.toml is not approved for this repo yet, so its checks did not run. Review it with /krites:init and approve it with /krites:init-write.";
const CHANGED_STOP =
  "Krites blocked the stop: krites.toml changed since you last approved it, so its checks did not run. Review it with /krites:init and approve it with /krites:init-write.";
const UNAPPROVED_VERIFY =
  "krites.toml is not approved for this repo yet, so nothing ran. Review it with /krites:init and approve it with /krites:init-write.";
const CHANGED_VERIFY =
  "krites.toml changed since you last approved it, so nothing ran. Review it with /krites:init and approve it with /krites:init-write.";

function realRoot(root) {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const repoKey = (root) => sha256(realRoot(root));

const filePath = (dir = configDir()) => path.join(dir, FILE);

// A missing or damaged trust store trusts nothing, so an unapproved repo stays closed.
function readAll(dir = configDir()) {
  const out = Object.create(null);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath(dir), "utf8"));
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    if (HASH.test(key) && typeof value === "string" && HASH.test(value)) out[key] = value;
  }
  return out;
}

const trustedHash = (root, dir = configDir()) => readAll(dir)[repoKey(root)] || null;

const isTrusted = (root, hash, dir = configDir()) =>
  typeof hash === "string" && HASH.test(hash) && trustedHash(root, dir) === hash;

function trustConfig(root, hash, dir = configDir()) {
  if (typeof hash !== "string" || !HASH.test(hash)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const all = readAll(dir);
  all[repoKey(root)] = hash;
  const sorted = Object.create(null);
  for (const key of Object.keys(all).sort()) sorted[key] = all[key];
  const temp = path.join(dir, `.${FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    retrying(() => fs.renameSync(temp, filePath(dir)));
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The first error is the one worth reporting; a temp file left behind is only clutter.
    }
    throw err;
  }
}

module.exports = {
  CHANGED_SESSION,
  CHANGED_STOP,
  CHANGED_VERIFY,
  FILE,
  UNAPPROVED_SESSION,
  UNAPPROVED_STOP,
  UNAPPROVED_VERIFY,
  isTrusted,
  repoKey,
  trustConfig,
  trustedHash,
};
