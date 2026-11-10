const fs = require("node:fs");
const path = require("node:path");

const { configDir } = require("./sign.js");

const NOTE = "Krites is off in every session until /krites:on: no edit is blocked, no commit is held and no stop is checked.";
const TURNED_OFF =
  "Krites is off in every session until you run /krites:on: no edit is blocked, no commit is held and no stop is checked. Every session start and every stop says so, and /krites:receipt signs nothing meanwhile.";
const TURNED_ON = "Krites is on: edits, commits and stops are checked again. A protected path changed while it was off is refuted at the next stop.";
const NO_RECEIPT = "Krites is off, so /krites:receipt signs nothing. Run /krites:on first.";

// Beside the signing key, where the edit tools never write (protect.js ownConfig). A shell can, as it can anywhere.
const marker = () => path.join(configDir(), "off");

// Anything at the marker's path counts, a folder too. A config directory that cannot be read leaves Krites on.
function isOff() {
  try {
    fs.lstatSync(marker());
    return true;
  } catch {
    return false;
  }
}

function set(off) {
  if (!off) return fs.rmSync(marker(), { recursive: true, force: true });
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  if (!isOff()) fs.writeFileSync(marker(), `${new Date().toISOString()}\n`);
}

const note = () => (isOff() ? [NOTE] : []);

module.exports = { NO_RECEIPT, NOTE, TURNED_OFF, TURNED_ON, isOff, note, set };
