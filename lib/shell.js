const VALUED = "mFCct";
const LONG = new Set([
  "--message",
  "--file",
  "--author",
  "--date",
  "--reuse-message",
  "--reedit-message",
  "--fixup",
  "--squash",
  "--template",
  "--cleanup",
  "--trailer",
  "--pathspec-from-file",
]);
const CD = new Set(["cd", "set-location", "sl", "chdir"]);
const PUSH = new Set(["pushd", "push-location"]);
const POP = new Set(["popd", "pop-location"]);
const NOT_A_COMMIT = new Set(["--help", "-h", "--dry-run", "--short", "--porcelain", "--long", "-z", "--null"]);
const KEYWORDS = new Set(["!", "{", "if", "then", "else", "elif", "do", "while", "until"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const BASH_REDIRECT = /(?:\d+|&)?(?:<<<|<<-?|>>|>&|<&|<>|>\||>|<)/y;
const PS_REDIRECT = /(?:\d+|\*)?(?:>>|>&\d+|>|<)/y;
const FD = /\d+-?|-/y;
const HERE_STRING = /@(['"])[ \t]*\r?\n/y;
const NEWLINE = /\r?\n/y;
const MAX_NEST = 50;
const OPEN = "(";
const CLOSE = ")";

const sticky = (re, s, i) => {
  re.lastIndex = i;
  return re.exec(s);
};

// Splits a command line into simple commands, each a list of words with quotes removed.
// Heredoc and here-string bodies, comments and redirections with their targets drop out.
function lex(s, ps, level) {
  const segments = [];
  const pending = [];
  const esc = ps ? "`" : "\\";
  const metas = ps ? " \t\r\n;&|()<>{}" : " \t\r\n;&|()<>";
  let nest = level;
  let i = 0;

  const skipHeredocs = () => {
    for (const { delim, dash } of pending) {
      while (i < s.length) {
        const nl = s.indexOf("\n", i);
        const end = nl < 0 ? s.length : nl;
        const line = s.slice(i, end).replace(/\r$/, "");
        i = end + 1;
        if ((dash ? line.replace(/^\t+/, "") : line) === delim) break;
      }
    }
    pending.length = 0;
  };

  const substitute = () => {
    const start = i;
    i += 2;
    if (nest < MAX_NEST) {
      nest++;
      segments.push(OPEN);
      commands(true);
      segments.push(CLOSE);
      nest--;
    }
    return s.slice(start, i);
  };

  const backtick = () => {
    const start = i++;
    let inner = "";
    while (i < s.length && s[i] !== "`") {
      if (s[i] === "\\" && "`\\$".includes(s[i + 1] ?? "\0")) i++;
      inner += s[i++] ?? "";
    }
    i++;
    if (nest < MAX_NEST) segments.push(OPEN, ...lex(inner, ps, nest + 1), CLOSE);
    return s.slice(start, i);
  };

  const single = () => {
    let out = "";
    i++;
    for (;;) {
      const close = s.indexOf("'", i);
      if (close < 0) {
        out += s.slice(i);
        i = s.length;
        return out;
      }
      out += s.slice(i, close);
      i = close + 1;
      if (!ps || s[i] !== "'") return out;
      out += "'";
      i++;
    }
  };

  const ansi = () => {
    let out = "";
    i += 2;
    while (i < s.length && s[i] !== "'") {
      if (s[i] === "\\") i++;
      out += s[i++] ?? "";
    }
    i++;
    return out;
  };

  const double = () => {
    let out = "";
    i++;
    while (i < s.length) {
      const c = s[i];
      const next = s[i + 1] ?? "";
      if (c === '"' && ps && next === '"') {
        out += '"';
        i += 2;
      } else if (c === '"') {
        i++;
        return out;
      } else if (c === "$" && next === "(") {
        out += substitute();
      } else if (!ps && c === "`") {
        out += backtick();
      } else if (c === esc && (ps || '$`"\\\n'.includes(next))) {
        out += next === "\n" ? "" : next;
        i += 2;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  };

  function commands(stop) {
    let words = [];
    let cur = "";
    let inWord = false;
    let want = null;
    let depth = 0;

    const finish = () => {
      if (!inWord) return;
      if (want === "target") want = null;
      else if (want) {
        pending.push({ delim: cur, dash: want === "dash" });
        want = null;
      } else words.push(cur);
      inWord = false;
      cur = "";
    };
    const end = () => {
      finish();
      want = null;
      if (words.length > 0) segments.push(words);
      words = [];
    };

    while (i < s.length) {
      const c = s[i];
      const next = s[i + 1] ?? "";
      const meta = metas.includes(c);
      if (meta && inWord) {
        finish();
        continue;
      }
      const here = ps && (!inWord || s[i - 1] === "=") && sticky(HERE_STRING, s, i);
      if (here) {
        const open = i + here[0].length - 1;
        const close = s.indexOf(`\n${here[1]}@`, open);
        cur += s.slice(open + 1, close < 0 ? s.length : close);
        i = close < 0 ? s.length : close + 3;
        inWord = true;
        continue;
      }
      if (!inWord) {
        if (c === "#") {
          const nl = s.indexOf("\n", i);
          i = nl < 0 ? s.length : nl;
          continue;
        }
        if (ps && c === "<" && next === "#") {
          const close = s.indexOf("#>", i + 2);
          i = close < 0 ? s.length : close + 2;
          continue;
        }
        const redirect = sticky(ps ? PS_REDIRECT : BASH_REDIRECT, s, i);
        if (redirect) {
          const op = redirect[0];
          i += op.length;
          if (op.includes("<<") && !op.includes("<<<")) want = op.endsWith("-") ? "dash" : "heredoc";
          else if (op.endsWith("&")) {
            const fd = sticky(FD, s, i);
            if (fd) i += fd[0].length;
            else want = "target";
          } else if (!/\d$/.test(op)) want = "target";
          continue;
        }
      }
      if (meta) {
        i++;
        if (c === "\n") {
          end();
          skipHeredocs();
        } else if (c === " " || c === "\t" || c === "\r") {
          continue;
        } else if (c === "&" && ps && words.length === 0 && next !== "&") {
          continue;
        } else if (c === "(") {
          end();
          segments.push(OPEN);
          depth++;
        } else if (c === ")" && depth > 0) {
          end();
          segments.push(CLOSE);
          depth--;
        } else if (c === ")" && stop) {
          end();
          return;
        } else {
          end();
        }
        continue;
      }
      if (c === esc) {
        const nl = sticky(NEWLINE, s, i + 1);
        if (nl) {
          i += 1 + nl[0].length;
          continue;
        }
      }
      inWord = true;
      if (c === "'") cur += single();
      else if (c === '"') cur += double();
      else if ((c === "$" || (ps && c === "@")) && next === "(") cur += substitute();
      else if (ps && c === "$" && next === "{") {
        const close = s.indexOf("}", i);
        const stopAt = close < 0 ? s.length : close + 1;
        cur += s.slice(i, stopAt);
        i = stopAt;
      } else if (!ps && c === "`") cur += backtick();
      else if (!ps && c === "$" && next === "'") cur += ansi();
      else if (c === esc) {
        cur += next;
        i += 2;
      } else {
        cur += c;
        i++;
      }
    }
    end();
  }

  commands(false);
  return segments;
}

function parseCommit(words, k) {
  let all = false;
  let rest = false;
  const paths = [];
  for (let j = k; j < words.length; j++) {
    const w = words[j];
    if (rest) paths.push(w);
    else if (NOT_A_COMMIT.has(w)) return null;
    else if (w === "--") rest = true;
    else if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      if (w === "--all") all = true;
      else if (LONG.has(name)) {
        const value = eq < 0 ? words[++j] : w.slice(eq + 1);
        if (name === "--pathspec-from-file" && value !== undefined) paths.push(value);
      }
    } else if (w.length > 1 && w.startsWith("-")) {
      for (let p = 1; p < w.length; p++) {
        if (w[p] === "a") all = true;
        else if (VALUED.includes(w[p])) {
          if (p === w.length - 1) j++;
          break;
        } else if (w[p] === "u" || w[p] === "S") break;
      }
    } else paths.push(w);
  }
  return { all, paths };
}

/**
 * Returns [{ dirs, all, paths }], one per `git commit` in a "bash" or "powershell" command line, in order; dirs
 * are the cd targets before it and then its -C values, as written, for the caller to resolve.
 */
function gitCommits(command, dialect) {
  const ps = dialect === "powershell";
  const fold = (w) => (ps ? w.toLowerCase() : w);
  const cds = [];
  const groups = [];
  const pushed = [];
  const found = [];
  for (const words of lex(typeof command === "string" ? command : "", ps, 0)) {
    if (words === OPEN) groups.push([cds.length, pushed.length]);
    if (words === CLOSE && groups.length > 0 && !ps) [cds.length, pushed.length] = groups.pop();
    if (typeof words === "string") continue;
    const own = [];
    let k = 0;
    for (;;) {
      const w = fold(words[k] ?? "");
      if (ASSIGN.test(w) || KEYWORDS.has(w)) k++;
      else if (w === "command" || w === "time") {
        k++;
        while (words[k]?.startsWith("-")) k++;
      } else if (w === "env") {
        k++;
        while (words[k] !== undefined && (ASSIGN.test(words[k]) || words[k].startsWith("-"))) {
          const o = words[k++];
          if (/^-[uCSP]$|^--(unset|chdir|split-string)$/.test(o)) {
            if ((o === "-C" || o === "--chdir") && words[k] !== undefined) own.push(words[k]);
            k++;
          } else if (o.startsWith("--chdir=")) own.push(o.slice(8));
        }
      } else break;
    }
    if (words[k] === undefined) continue;
    const name = words[k];
    const lower = name.toLowerCase();
    // A `cd -` may have dropped below a pushd frame, so a pop never grows the list.
    if (POP.has(lower) && pushed.length > 0) cds.length = Math.min(cds.length, pushed.pop());
    if (CD.has(lower) || PUSH.has(lower)) {
      const dir = words.slice(k + 1).find((w) => w === "-" || !w.startsWith("-"));
      if (dir === "-") cds.pop();
      else if (dir !== undefined) {
        if (PUSH.has(lower)) pushed.push(cds.length);
        cds.push(dir);
      } else if (CD.has(lower)) cds.push("~");
    }
    if (POP.has(lower) || CD.has(lower) || PUSH.has(lower)) continue;
    const base = fold(name).split(/[\\/]/).pop();
    if (base !== "git" && base !== "git.exe") continue;
    k++;
    for (;;) {
      if (words[k] === "-C" || words[k] === "-c") {
        if (words[k] === "-C" && words[k + 1] !== undefined) own.push(words[k + 1]);
        k += 2;
      } else if (words[k] === "--no-pager" || words[k] === "-P") k++;
      else break;
    }
    if (words[k] !== "commit") continue;
    const parsed = parseCommit(words, k + 1);
    if (parsed) found.push({ dirs: [...cds, ...own], ...parsed });
  }
  return found;
}

module.exports = { gitCommits };
