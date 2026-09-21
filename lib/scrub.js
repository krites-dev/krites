const fs = require("node:fs");
const os = require("node:os");

const WINDOWS = process.platform === "win32";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "[\\\\/]+";
const NAME = "[^\\\\/\\r\\n\"'<>|*?:]";
const TOKEN = /\b(sk-[\w-]{16,}|sk_live_\w{16,}|npm_\w{20,}|glpat-[\w-]{16,}|hf_\w{20,}|gh[pousr]_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[\w.~+/-]{16,}|ey[\w-]{20,}\.[\w-]{20,}\.[\w-]+)/g;
const WORD = "[^\\\\/\\s\"'<>|*?:,;)\\]]+";
// A user name may hold spaces, so the spaced form is taken only when a separator follows it.
const USER_DIR = new RegExp(
  `(?<![\\w~])(?:[A-Za-z]:)?(?:(?:\\.\\.[\\\\/]+)+|[\\\\/]+)(?:[A-Za-z][\\\\/]+)?(?:Users|home)[\\\\/]+(?:${WORD}(?: ${WORD})*(?=[\\\\/])|${WORD})`,
  "gi",
);
const MSYS_PATH = /(?<![\w.~<>/-])\/[A-Za-z]\/(?:[^/\r\n"'<>|*?:]*\/)*/g;
const TOP_LEVEL = WINDOWS
  ? ["home", "Users", "usr", "opt", "var", "tmp", "etc", "mnt", "private", "root"]
  : fs.readdirSync("/").filter((name) => /^[\w.-]+$/.test(name));

function scrub(text, root) {
  const real = (dir) => {
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return dir;
    }
  };
  const msys = (dir) => (/^[A-Za-z]:/.test(dir) ? `/${dir[0].toLowerCase()}${dir.slice(2)}` : dir);
  const known = [[root, "."], [real(root), "."], [os.tmpdir(), "<tmp>"], [real(os.tmpdir()), "<tmp>"], [os.homedir(), "~"]]
    .flatMap(([dir, to]) => [[dir, to], [msys(dir), to]])
    .filter(([dir]) => dir.split(/[\\/]+/).filter(Boolean).length >= 2)
    .sort((a, b) => b[0].length - a[0].length);

  let out = String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\\/]{2}\?[\\/]UNC[\\/]/gi, "\\\\")
    .replace(/[\\/]{2}\?[\\/]/g, "")
    .replace(/file:\/\/\/(?=[A-Za-z]:)/gi, "")
    .replace(/file:\/\//gi, "")
    .replace(TOKEN, "<redacted>");
  for (const [dir, to] of known) {
    const lead = /^[\\/]/.test(dir) ? SEP : "";
    const body = dir.split(/[\\/]+/).filter(Boolean).map(escapeRe).join(SEP);
    out = out.replace(new RegExp(`${lead}${body}(?=$|[\\\\/\\s"':,;)\\]])`, "gi"), to);
  }
  // A home directory in any form, including the MSYS and relative spellings the known list cannot cover.
  out = out.replace(USER_DIR, "~");
  if (WINDOWS) out = out.replace(MSYS_PATH, "<path>/");
  // Whatever absolute path is left keeps its file name only. Components may hold spaces, so the match runs to the last separator.
  return out
    .replace(new RegExp(`(?<![A-Za-z])[A-Za-z]:[\\\\/](?:${NAME}*[\\\\/])*`, "g"), "<path>/")
    .replace(new RegExp(`(?<![:\\w\\\\/])[\\\\/]{2}[^\\\\/\\s"'?.][^\\\\/\\s"']*[\\\\/](?:${NAME}*[\\\\/])*`, "g"), "<path>/")
    .replace(new RegExp(`(?:(?<![\\w.~<>/-])|(?<=-[A-Za-z]))/(?:${TOP_LEVEL.map(escapeRe).join("|")})/(?:[^/\\r\\n"'<>|*?:]*/)*`, "g"), "<path>/");
}

module.exports = { scrub };
