const crypto = require("node:crypto");
const fs = require("node:fs");

const ALG = "ed25519";
const KEY = /^[0-9a-f]{16,64}$/;
const SIGNATURE_KEYS = "alg,public_key,sig";
const VERDICTS = ["passed", "refuted", "timed_out", "no_checks"];
// An unpinned key says nothing about who signed: anyone can make one, and a small-order key verifies any body.
const UNPINNED = ", signer not pinned (pass --key)";
const USAGE = "usage: node verify-receipt.js [--key <fingerprint or a prefix of at least 16 hex characters>] <receipt.json>";

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

const invalid = (why) => ({ ok: false, line: `invalid: ${why}` });

// Canonical base64 only: an unused bit set in the last character would otherwise give one key two spellings.
function decode(value, size) {
  if (typeof value !== "string") return null;
  const raw = Buffer.from(value, "base64");
  return raw.length === size && raw.toString("base64") === value ? raw : null;
}

function check(bytes, want) {
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    return invalid("the file is not JSON");
  }
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return invalid("the file is not a receipt");
  // The valid line prints the verdict, so anything but these four words could write terminal escapes on it.
  if (!VERDICTS.includes(receipt.verdict)) return invalid("the verdict is not one Krites writes");
  let body;
  try {
    body = { ...receipt };
    delete body.signature;
    if (!Buffer.from(canonical(receipt), "utf8").equals(bytes)) return invalid("the bytes are not the canonical form of the receipt");
  } catch {
    return invalid("the file holds a value a receipt cannot carry");
  }

  const signature = receipt.signature;
  if (signature === null || typeof signature !== "object" || Array.isArray(signature)) return invalid("the receipt carries no signature");
  if (Object.keys(signature).sort().join(",") !== SIGNATURE_KEYS) return invalid("the signature is not exactly alg, public_key and sig");
  if (signature.alg !== ALG) return invalid(`the signature algorithm is not ${ALG}`);
  const key = decode(signature.public_key, 32);
  if (key === null) return invalid("the public key is not 32 bytes of canonical base64");
  const sig = decode(signature.sig, 64);
  if (sig === null) return invalid("the signature is not 64 bytes of canonical base64");

  let matched;
  try {
    const jwk = { key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" };
    matched = crypto.verify(null, Buffer.from(canonical(body), "utf8"), crypto.createPublicKey(jwk), sig);
  } catch {
    matched = false;
  }
  if (!matched) return invalid("the signature does not match the receipt");

  const fingerprint = crypto.createHash("sha256").update(key).digest("hex");
  if (want !== null && !fingerprint.startsWith(want)) return invalid(`the receipt is signed by ${fingerprint}, which is not the key asked for`);
  return { ok: true, line: `valid: signed by ${fingerprint}, verdict ${receipt.verdict}${want === null ? UNPINNED : ""}` };
}

function main(argv) {
  let want = null;
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--key") {
      files.push(argv[i]);
      continue;
    }
    want = String(argv[(i += 1)] === undefined ? "" : argv[i]).toLowerCase();
    if (!KEY.test(want)) return invalid("--key takes a fingerprint, or a prefix of at least 16 hex characters");
  }
  if (files.length !== 1) return invalid(USAGE);
  try {
    return check(fs.readFileSync(files[0]), want);
  } catch {
    return invalid("the receipt could not be read");
  }
}

if (require.main === module) {
  const result = main(process.argv.slice(2));
  console.log(result.line);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { canonical, check };
