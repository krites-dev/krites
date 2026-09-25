const fs = require("node:fs");
const os = require("node:os");

const WINDOWS = process.platform === "win32";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "[\\\\/]+";
const NAME = "[^\\\\/\\r\\n\"'<>|*?:]";
const TOKEN = /\b(sk-[\w-]{16,}|sk_live_\w{16,}|npm_\w{20,}|glpat-[\w-]{16,}|hf_\w{20,}|gh[pousr]_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[\w.~+/-]{16,}|ey[\w-]{20,}\.[\w-]{20,}\.[\w-]+)/g;
// A scheme starts only where a scheme run starts, or a long run of scheme characters makes the match quadratic.
const DSN = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s@/]+@/gi;
const SECRET = "(?:password|passphrase|passwd|pwd|secret(?:[_-]?access)?[_-]?key|secret|api[_-]?key|token|private[_-]?key|credentials?|[_-]pass)";
const NAME_END = "(?![^\\W_\\d])";
const VALUE = `(?!<redacted>)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s"']+)`;
// A name is taken only where a name run starts, so a long run of name characters stays linear.
// `=>` counts only after a quoted name or a Ruby symbol; `::` is a Rust path, not a pair.
const KV = new RegExp(
  `(?<![\\w-])((?=[\\w-]*?${SECRET}${NAME_END})[\\w-]+)((?:["'][ \\t]*(?:=>|[:=](?![=>:]))|[ \\t]*[:=](?![=>:]))[ \\t]*)${VALUE}`,
  "gi",
);
const SYMBOL = new RegExp(`(?<![\\w:])(:(?=[\\w-]*?${SECRET}${NAME_END})[\\w-]+[ \\t]*=>[ \\t]*)${VALUE}`, "gi");
const FLAG = new RegExp(`(?<![\\w-])(--(?!no-)(?:pass(?![\\w-])|(?=[\\w-]*?${SECRET}(?![\\w-]))[\\w-]+))([ \\t]+)(?!-)${VALUE}`, "gi");
const AUTH = /(?<![\w-])(["']?(?:proxy-)?authorization["']?[ \t]*:[ \t]*)(?!(?:[\w-]+[ \t]+)?<redacted>)([\w-]+[ \t]+)?\S[^\r\n]*/gi;
const CURL_USER = /(?<![\w-])((?:-u[ \t]*|--user(?:[ \t]+|=))[^\s:]+:)\S+/g;
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
    .replace(TOKEN, "<redacted>")
    .replace(DSN, "$1<redacted>@")
    .replace(KV, "$1$2<redacted>")
    .replace(FLAG, "$1$2<redacted>")
    .replace(AUTH, "$1$2<redacted>")
    .replace(SYMBOL, "$1<redacted>")
    .replace(CURL_USER, "$1<redacted>");
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
