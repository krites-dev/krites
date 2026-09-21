const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ALG = "ed25519";
const KEY_FILE = "signing-key.pem";

function configDir() {
  const override = process.env.KRITES_CONFIG_DIR;
  if (override) return override;
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "krites");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "krites");
}

function canonical(value) {
  const ordered = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("a receipt holds finite numbers only");
      return item;
    }
    if (Array.isArray(item)) return item.map(ordered);
    const proto = typeof item === "object" ? Object.getPrototypeOf(item) : false;
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("a receipt holds objects, arrays, strings, finite numbers, booleans and null only");
    }
    const out = {};
    for (const key of Object.keys(item).sort()) out[key] = ordered(item[key]);
    return out;
  };
  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}

const fail = (what) => {
  throw new Error(`${KEY_FILE} in the Krites config directory ${what}`);
};

function readPem(file, required) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (!required && err.code === "ENOENT") return null;
    return fail(`could not be read (${err.code || err.name})`);
  }
}

function loadOrCreateKey() {
  const dir = configDir();
  const file = path.join(dir, KEY_FILE);
  let pem = readPem(file, false);
  if (pem === null) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      pem = crypto.generateKeyPairSync(ALG).privateKey.export({ type: "pkcs8", format: "pem" });
      fs.writeFileSync(file, pem, { flag: "wx", mode: 0o600 });
    } catch (err) {
      // A second process won the wx race, and the key it wrote is the one this install keeps.
      if (err.code !== "EEXIST") fail(`could not be created (${err.code || err.name})`);
      pem = readPem(file, true);
    }
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch {
    fail("does not parse; move it aside to start a new key");
  }
  const raw = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  return { privateKey, public_key: raw.toString("base64") };
}

const fingerprintOf = (publicKey) => crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");

function sign(object) {
  const key = loadOrCreateKey();
  const sig = crypto.sign(null, Buffer.from(canonical(object), "utf8"), key.privateKey);
  return { alg: ALG, public_key: key.public_key, sig: sig.toString("base64") };
}

function verify(object, signature) {
  try {
    if (signature.alg !== ALG) return false;
    const x = Buffer.from(signature.public_key, "base64").toString("base64url");
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    return crypto.verify(null, Buffer.from(canonical(object), "utf8"), key, Buffer.from(signature.sig, "base64"));
  } catch {
    return false;
  }
}

module.exports = { canonical, configDir, fingerprintOf, loadOrCreateKey, sign, verify };
