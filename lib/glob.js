const ESCAPE = /[.*+?^${}()|[\]\\]/;

const normalize = (value) => String(value).replace(/\\/g, "/").normalize("NFC").toLowerCase();

const split = (value) => normalize(value).split("/").filter((part) => part !== "" && part !== ".");

function segment(part) {
  let out = "";
  for (const ch of part) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ESCAPE.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

function toRegExp(glob) {
  const parts = split(glob);
  const body = parts.map((part, i) => {
    const last = i === parts.length - 1;
    if (part === "**") return last ? "(?:[^/]+/)*[^/]+" : "(?:[^/]+/)*";
    return last ? segment(part) : `${segment(part)}/`;
  });
  return new RegExp(`^${body.join("")}$`);
}

const cache = new Map();

function matches(glob, relPath) {
  let re = cache.get(glob);
  if (!re) cache.set(glob, (re = toRegExp(glob)));
  return re.test(split(relPath).join("/"));
}

module.exports = { matches };
