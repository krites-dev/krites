const ESCAPE = /[.*+?^${}()|[\]\\]/;

const normalize = (value, fold) => {
  const text = String(value).replace(/\\/g, "/").normalize("NFC");
  return fold ? text.toLowerCase() : text;
};

const split = (value, fold) => normalize(value, fold).split("/").filter((part) => part !== "" && part !== ".");

function segment(part) {
  let out = "";
  for (const ch of part) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ESCAPE.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

function toRegExp(glob, fold) {
  const parts = split(glob, fold);
  const body = parts.map((part, i) => {
    const last = i === parts.length - 1;
    if (part === "**") return last ? "(?:[^/]+/)*[^/]+" : "(?:[^/]+/)*";
    return last ? segment(part) : `${segment(part)}/`;
  });
  return new RegExp(`^${body.join("")}$`);
}

const cache = new Map();

function matches(glob, relPath, { fold = true } = {}) {
  const key = `${fold ? "i" : "c"}${glob}`;
  let re = cache.get(key);
  if (!re) cache.set(key, (re = toRegExp(glob, fold)));
  return re.test(split(relPath, fold).join("/"));
}

module.exports = { matches };
