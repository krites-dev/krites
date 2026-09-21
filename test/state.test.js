const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { loadConfig } = require("../lib/config.js");
const {
  changedPaths,
  configHash,
  diffStat,
  fingerprint,
  readBaseline,
  readBlockCount,
  readConfigHash,
  retrying,
  writeBaseline,
  writeBlockCount,
  writeConfigHash,
} = require("../lib/state.js");
const { git, makeDir, makeRepo } = require("./helpers.js");

const SHA = "0123456789abcdef0123456789abcdef01234567";

function sub(files) {
  const repo = makeRepo({ files: { "root.txt": "r\n", ...Object.fromEntries(Object.entries(files).map(([rel, body]) => [`sub/${rel}`, body])) } });
  return { repo, root: path.join(repo, "sub") };
}

test("state: a baseline is used only when it is a plain hex object name", () => {
  const dir = makeDir({});
  for (const body of ["--cached", "--output=x", "garbage", "", "\n", `${SHA} extra`, SHA.toUpperCase(), "abc"]) {
    fs.mkdirSync(path.join(dir, ".krites"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".krites", "session-head"), body);
    assert.strictEqual(readBaseline(dir), null, JSON.stringify(body));
  }
  writeBaseline(dir, SHA);
  assert.strictEqual(readBaseline(dir), SHA);
  fs.writeFileSync(path.join(dir, ".krites", "session-head"), `${"a".repeat(64)}\n`);
  assert.strictEqual(readBaseline(dir), "a".repeat(64));
});

test("state: the block count reads as 0 unless the file holds a small whole number", () => {
  const dir = makeDir({});
  const file = path.join(dir, ".krites", "block-count");
  assert.strictEqual(readBlockCount(dir), 0, "no file at all");

  fs.mkdirSync(path.join(dir, ".krites"), { recursive: true });
  for (const body of ["garbage", "-1", "12345", "", "\n", "2 3", "3.5", "0x3", " 3 4"]) {
    fs.writeFileSync(file, body);
    assert.strictEqual(readBlockCount(dir), 0, JSON.stringify(body));
  }

  for (const count of [0, 3, 9999]) {
    writeBlockCount(dir, count);
    assert.strictEqual(readBlockCount(dir), count);
  }

  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.strictEqual(readBlockCount(dir), 0, "a directory in place of the file");
});

test("state: the block count stops at 9999 instead of wrapping", () => {
  const dir = makeDir({});
  writeBlockCount(dir, 9999);
  assert.strictEqual(readBlockCount(dir), 9999);
  writeBlockCount(dir, 10000);
  assert.strictEqual(readBlockCount(dir), 9999, "a five-digit count would read as 0");
});

test("state: the plugin repairs its own entries, removing a link as a link", () => {
  const dir = makeDir({});
  fs.writeFileSync(path.join(dir, ".krites"), "not a directory\n");
  writeBlockCount(dir, 1);
  assert.strictEqual(readBlockCount(dir), 1);
  assert.ok(fs.lstatSync(path.join(dir, ".krites")).isDirectory(), ".krites is the directory again");

  const behind = path.join(dir, "behind");
  fs.mkdirSync(behind, { recursive: true });
  fs.writeFileSync(path.join(behind, "keep.txt"), "keep\n");
  const counter = path.join(dir, ".krites", "block-count");
  fs.rmSync(counter);
  fs.symlinkSync(behind, counter, "junction");

  writeBlockCount(dir, 2);
  assert.strictEqual(readBlockCount(dir), 2, "the counter replaced the link");
  assert.ok(fs.lstatSync(counter).isFile());
  assert.strictEqual(fs.readFileSync(path.join(behind, "keep.txt"), "utf8"), "keep\n", "the link was never followed");
});

const thrower = (code, times) => {
  let calls = 0;
  return {
    calls: () => calls,
    fn: () => {
      calls += 1;
      if (calls > times) return "written";
      throw Object.assign(new Error(code), { code });
    },
  };
};

test("state: a state write waits out a sharing violation, and only that", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const twice = thrower(code, 2);
    assert.strictEqual(retrying(twice.fn), "written", code);
    assert.strictEqual(twice.calls(), 3, `${code}: two violations cost two retries`);
  }

  const always = thrower("EPERM", 99);
  const started = Date.now();
  assert.throws(() => retrying(always.fn), { code: "EPERM" }, "the last error is the caller's");
  const elapsed = Date.now() - started;
  assert.strictEqual(always.calls(), 5, "five tries and no more");
  assert.ok(elapsed >= 150 && elapsed < 5000, `the tries are 40 ms apart (${elapsed} ms)`);

  const other = thrower("ENOTEMPTY", 1);
  assert.throws(() => retrying(other.fn), { code: "ENOTEMPTY" });
  assert.strictEqual(other.calls(), 1, "any other code is the caller's at once");
});

test("state: an entry the plugin cannot repair fails with its own error and keeps what it holds", () => {
  const dir = makeDir({});
  const counter = path.join(dir, ".krites", "block-count");
  writeBlockCount(dir, 1);
  fs.rmSync(counter);
  fs.mkdirSync(counter);
  fs.writeFileSync(path.join(counter, "held.txt"), "held\n");

  assert.throws(() => writeBlockCount(dir, 2), { code: "ENOTEMPTY" }, "a directory that is not empty is not the plugin's to clear");
  assert.strictEqual(fs.readFileSync(path.join(counter, "held.txt"), "utf8"), "held\n");
});

test("state: the baseline and the config hash repair their own entries as the counter does", () => {
  const dir = makeDir({});
  const hash = "a".repeat(64);
  fs.mkdirSync(path.join(dir, ".krites"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".krites", "session-head"));
  fs.mkdirSync(path.join(dir, ".krites", "config-hash"));

  writeBaseline(dir, SHA);
  assert.strictEqual(readBaseline(dir), SHA, "the baseline replaced the directory");
  writeConfigHash(dir, hash);
  assert.strictEqual(readConfigHash(dir), hash, "and so did the config hash");
});

test("state: a root below the git toplevel sees its own paths, root-relative", () => {
  const { repo, root } = sub({ "a.txt": "a\n", "tests/krites/t.js": "t\n" });
  fs.writeFileSync(path.join(root, "tests", "krites", "t.js"), "weakened\n");
  fs.writeFileSync(path.join(repo, "root.txt"), "changed\n");
  fs.writeFileSync(path.join(root, "new.txt"), "new\n");

  const changed = changedPaths(root, null);
  assert.deepStrictEqual(changed.sort(), ["new.txt", "tests/krites/t.js"]);
  assert.ok(!changed.some((rel) => rel.startsWith("sub/")), "the prefix is stripped, never doubled");
  assert.deepStrictEqual(diffStat(root, null).files.sort(), ["new.txt", "tests/krites/t.js"]);
});

test("state: the fingerprint of a subdirectory root follows its own files", () => {
  const { root } = sub({ "a.txt": "a\n" });
  fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
  const before = fingerprint(root);
  fs.writeFileSync(path.join(root, "a.txt"), "dirty again\n");
  assert.notStrictEqual(fingerprint(root), before, "a changed file under the root changes the fingerprint");
});

test("state: a file over the hash ceiling is fingerprinted by size and mtime", () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  const big = path.join(repo, "big.bin");
  const stamp = new Date(Date.now() - 60000);
  fs.writeFileSync(big, Buffer.alloc(6 << 20, 1));
  fs.utimesSync(big, stamp, stamp);
  const before = fingerprint(repo);

  const handle = fs.openSync(big, "r+");
  fs.writeSync(handle, Buffer.from([2, 2, 2]), 0, 3, 0);
  fs.closeSync(handle);
  fs.utimesSync(big, stamp, stamp);
  assert.strictEqual(fingerprint(repo), before, "same size and mtime reads as unchanged: the ponytail ceiling");

  fs.appendFileSync(big, "more");
  fs.utimesSync(big, stamp, stamp);
  assert.notStrictEqual(fingerprint(repo), before, "a size change is seen");
});

test("state: a rename keeps the old path in the changed list", () => {
  const repo = makeRepo({ files: { "tests/krites/t.js": "t\n", "a.txt": "a\n" } });
  writeBaseline(repo, git(repo, "rev-parse", "HEAD").stdout.toString().trim());
  git(repo, "mv", "tests/krites/t.js", "src-old.js");
  assert.ok(changedPaths(repo, readBaseline(repo)).includes("tests/krites/t.js"), "staged rename");

  git(repo, "commit", "-q", "-m", "move");
  assert.ok(changedPaths(repo, readBaseline(repo)).includes("tests/krites/t.js"), "committed rename");
  assert.ok(fingerprint(repo).length === 64);
});

test("state: a repo with no commits lists every file, and a directory git cannot read lists nothing", () => {
  const fresh = makeRepo({ files: { "a.txt": "a\n", "sub/b.txt": "b\n" } , commit: false });
  assert.deepStrictEqual(changedPaths(fresh, null).sort(), ["a.txt", "sub/b.txt"]);

  assert.strictEqual(changedPaths(makeDir({ "a.txt": "a\n" }), null), null, "a git failure is never an empty list");
});

test("state: diffStat covers the commits since the baseline and the untracked files", () => {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  const baseline = git(repo, "rev-parse", "HEAD").stdout.toString().trim();
  writeBaseline(repo, baseline);
  fs.writeFileSync(path.join(repo, "a.txt"), "committed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "work");
  fs.writeFileSync(path.join(repo, "extra.txt"), "new\n");

  const stat = diffStat(repo, readBaseline(repo));
  assert.deepStrictEqual(stat.files.sort(), ["a.txt", "extra.txt"]);
  assert.strictEqual(stat.files_changed, 2);
  assert.strictEqual(stat.insertions, 1);
  assert.strictEqual(stat.deletions, 1);
});

test("state: the config hash ignores a BOM and the line endings", () => {
  const lf = makeRepo({ files: { "krites.toml": "version = 1\n\n[checks]\ncommands = []\n" } });
  const crlf = makeRepo({ files: { "krites.toml": `${String.fromCharCode(0xfeff)}version = 1\r\n\r\n[checks]\r\ncommands = []\r\n` } });
  assert.strictEqual(configHash(crlf), configHash(lf));
  assert.strictEqual(configHash(lf), loadConfig(lf).hash, "the hash comes from the bytes loadConfig parsed");
});

test("state: the config hash is the sha256 of krites.toml on disk", () => {
  const repo = makeRepo({ files: { "krites.toml": "version = 1\n" } });
  const expected = crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, "krites.toml"), "utf8")).digest("hex");
  assert.strictEqual(configHash(repo), expected);
  assert.strictEqual(readConfigHash(repo), null);

  writeConfigHash(repo, expected);
  assert.strictEqual(readConfigHash(repo), expected);
  fs.rmSync(path.join(repo, "krites.toml"));
  assert.strictEqual(configHash(repo), null);
});
