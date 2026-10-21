const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { QUESTION } = require("../lib/ping.js");
const { configHash, readBaseline, readConfigHash, writeBaseline } = require("../lib/state.js");
const { assertBlock, configure, git, head, makeRepo, runCli, runHook, script, seed, tmp, toml } = require("./helpers.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const SILENT = { code: 0, stdout: "", stderr: "" };
const REFUTED = (rel) =>
  `Krites refuted the stop: protected path changed: ${rel}. Protected paths are human-edited only: if you changed it, undo your change; if a person did, they commit it and review it with /krites:approve.`;
const NO_BASELINE = "There is no session baseline here, so there is nothing to approve: the gate compares against HEAD. Nothing was written.\n";
const NOTHING = "No commit since the baseline changed a protected path, so there is nothing to approve. Nothing was written.\n";
const FIRST = "Nothing is waiting for approval. Run /krites:approve first.\n";
const NOT_COMMITTED = "not committed, so not approvable:";
const STILL = "The next stop still runs the checks, and only a pass moves the baseline.\n";
const SAFE = "git --no-replace-objects --literal-pathspecs diff --no-ext-diff --no-textconv --text";
const WINDOWS = process.platform === "win32";

const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });
const short = (repo, id) => git(repo, "rev-parse", "--short", id).stdout.toString().trim();
const listed = (rels) => rels.map((rel) => `* ${rel}`);
const header = (repo, baseline, ...rels) => [`Protected paths changed in commits since the baseline ${short(repo, baseline)}:`, ...listed(rels)].join("\n");
const footer = (repo) => `Nothing is approved yet. Run /krites:approve-write to approve these changes up to ${short(repo, head(repo))}.\n`;
const logOf = (repo, baseline, rels) => git(repo, "log", "--format=%h %s", `${baseline}..HEAD`, "--", ...rels).stdout.toString();
const done = (repo, baseline, rels, toml = false) =>
  `${[`Approved these protected changes up to ${short(repo, head(repo))}:`, ...listed(rels)].join("\n")}\n${logOf(repo, baseline, rels)}${toml ? "The gate now accepts this krites.toml.\n" : ""}${STILL}`;
const lastRun = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".krites", "last-run.json"), "utf8"));

function guarded(check = script("console.log('fine')")) {
  const repo = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n", "secrets/other.md": "other\n" } });
  configure(repo, { commands: [check], globs: ["secrets/**"] });
  return seed(repo);
}

const krites = (repo, name) => path.join(repo, ".krites", name);
const readOf = (repo, name) => (fs.existsSync(krites(repo, name)) ? fs.readFileSync(krites(repo, name), "utf8").trim() : null);
const pending = (repo) => readOf(repo, "approve-pending");
const approved = (repo) => readOf(repo, "approved-head");
const edit = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const commit = (repo, message, ...rels) => {
  git(repo, "add", "--", ...rels);
  git(repo, "commit", "-q", "-m", message);
};
const cli = async (repo, ...args) => {
  const result = await runCli(args, { cwd: repo });
  assert.strictEqual(result.code, 0, args.join(" "));
  assert.strictEqual(result.stderr, "", args.join(" "));
  return result.stdout;
};
const gate = (repo) => runHook(GATE, stop(repo), { cwd: repo });

function sanctioned() {
  const repo = guarded();
  const baseline = readBaseline(repo);
  edit(repo, "secrets/rule.md", "sanctioned\n");
  commit(repo, "sanctioned rule", "secrets/rule.md");
  return { repo, baseline };
}

test("approve: a person's committed protected change is shown, approve-write excuses it without moving the baseline, and a pass drops the approval", async () => {
  const { repo, baseline } = sanctioned();
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/rule.md"));

  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`${header(repo, baseline, "secrets/rule.md")}\n${short(repo, head(repo))} sanctioned rule\n`), out);
  for (const line of ["--- a/secrets/rule.md", "+++ b/secrets/rule.md", "-rule", "+sanctioned"]) assert.ok(out.split("\n").includes(line), `${line}\n${out}`);
  assert.ok(out.endsWith(footer(repo)), out);
  assert.ok(!out.includes(NOT_COMMITTED), out);
  assert.strictEqual(pending(repo), `${baseline} ${head(repo)}`);
  assert.strictEqual(approved(repo), null, "showing approves nothing");
  assertBlock(await gate(repo), /protected path changed: secrets\/rule\.md/);

  assert.strictEqual(await cli(repo, "approve", "--write"), done(repo, baseline, ["secrets/rule.md"]));
  assert.strictEqual(readBaseline(repo), baseline, "approving never moves the baseline");
  assert.strictEqual(approved(repo), `${baseline} ${head(repo)}`);
  assert.strictEqual(pending(repo), null, "the pending review is spent");

  assert.deepStrictEqual(await gate(repo), SILENT);
  assert.strictEqual(lastRun(repo).verdict, "passed", "the clean tree off the baseline still ran the checks");
  assert.strictEqual(readBaseline(repo), head(repo), "the pass moved the baseline");
  assert.strictEqual(approved(repo), null, "the pass dropped the approval");
  assert.strictEqual(await cli(repo, "approve", "--write"), FIRST);
});

test("approve: after approve-write the agent's unchecked commits still go through the checks, even on a clean tree", async () => {
  const repo = guarded(script("process.exit(require('node:fs').existsSync('src/broken.js') ? 1 : 0)"));
  const baseline = readBaseline(repo);
  edit(repo, "src/broken.js", "broken\n");
  commit(repo, "agent work", "src/broken.js");
  edit(repo, "secrets/rule.md", "sanctioned\n");
  commit(repo, "sanctioned rule", "secrets/rule.md");
  await cli(repo, "approve");
  assert.strictEqual(await cli(repo, "approve", "--write"), done(repo, baseline, ["secrets/rule.md"]));

  assertBlock(await gate(repo), /^Krites refuted the stop: node /);
  assert.strictEqual(lastRun(repo).verdict, "refuted");
  assert.strictEqual(readBaseline(repo), baseline);
  assert.strictEqual(approved(repo), `${baseline} ${head(repo)}`, "a refuted run keeps the approval");
});

test("approve: a protected change made after the approved commit still refutes, committed or not", async () => {
  const { repo, baseline } = sanctioned();
  await cli(repo, "approve");
  await cli(repo, "approve", "--write");
  edit(repo, "secrets/other.md", "dirty\n");
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/other.md"));

  commit(repo, "after the approval", "secrets/other.md");
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/other.md"));
  assert.strictEqual(readBaseline(repo), baseline);
});

test("approve: an approved-head whose baseline no longer matches is ignored", async () => {
  const { repo, baseline } = sanctioned();
  const first = git(repo, "rev-list", "--max-parents=0", "HEAD").stdout.toString().trim();
  fs.writeFileSync(krites(repo, "approved-head"), `${first} ${head(repo)}\n`);
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/rule.md"));

  fs.writeFileSync(krites(repo, "approved-head"), `${baseline} ${head(repo)}\n`);
  assert.deepStrictEqual(await gate(repo), SILENT, "the same approval against the current baseline excuses it");
});

test("approve: a HEAD or a baseline that moved after approve showed it is refused by name and nothing is approved", async () => {
  const { repo, baseline } = sanctioned();
  await cli(repo, "approve");
  const shown = head(repo);
  edit(repo, "secrets/other.md", "slipped in after\n");
  commit(repo, "never shown", "secrets/other.md");
  assert.strictEqual(
    await cli(repo, "approve", "--write"),
    `HEAD moved from ${short(repo, shown)} to ${short(repo, head(repo))} after /krites:approve, so nothing was approved. Run /krites:approve again.\n`,
  );
  assert.deepStrictEqual([readBaseline(repo), approved(repo), pending(repo)], [baseline, null, null]);
  assertBlock(await gate(repo), /protected path changed: secrets\//);

  await cli(repo, "approve");
  writeBaseline(repo, shown);
  assert.strictEqual(
    await cli(repo, "approve", "--write"),
    `The baseline moved from ${short(repo, baseline)} to ${short(repo, shown)} after /krites:approve, so nothing was approved. Run /krites:approve again.\n`,
  );
  assert.deepStrictEqual([approved(repo), pending(repo)], [null, null]);
});

test("approve: an uncommitted protected change is listed as not approvable and still refutes after approve-write", async () => {
  const repo = guarded();
  const baseline = readBaseline(repo);
  edit(repo, "secrets/other.md", "dirty\n");
  assert.strictEqual(await cli(repo, "approve"), `${NOTHING}${NOT_COMMITTED}\n* secrets/other.md\n`);
  assert.strictEqual(pending(repo), null);

  edit(repo, "secrets/rule.md", "sanctioned\n");
  commit(repo, "sanctioned rule", "secrets/rule.md");
  edit(repo, "secrets/new.md", "untracked\n");
  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`${header(repo, baseline, "secrets/rule.md")}\n`), out);
  assert.ok(out.endsWith(`${NOT_COMMITTED}\n* secrets/new.md\n* secrets/other.md\n${footer(repo)}`), out);

  assert.strictEqual(await cli(repo, "approve", "--write"), done(repo, baseline, ["secrets/rule.md"]));
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/other.md"));
});

test("approve: -diff in an uncommitted .gitattributes still shows the text, control and format characters print escaped, and a long diff is cut naming a command with no path in it", async () => {
  const repo = guarded();
  const baseline = readBaseline(repo);
  edit(repo, ".gitattributes", "secrets/** -diff\n");
  edit(repo, "secrets/rule.md", "bell\x07 and esc\x1b[31m red\nrlo\u202e and zwsp\u200b and ls\u2028 and ps\u2029\n");
  edit(repo, "secrets/zz$(x)`long.md", Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join(""));
  commit(repo, "sanctioned", "secrets/rule.md", "secrets/zz$(x)`long.md");

  const out = await cli(repo, "approve");
  const lines = out.split("\n");
  assert.ok(lines.includes("+bell\\x07 and esc\\x1b[31m red"), out);
  assert.ok(lines.includes("+rlo\\u{202e} and zwsp\\u{200b} and ls\\u{2028} and ps\\u{2029}"), out);
  assert.doesNotMatch(out.replace(/[\t\n]/g, ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u, "no raw control, format or separator character but tab and newline");

  const top = header(repo, baseline, "secrets/rule.md", "secrets/zz$(x)`long.md").split("\n").length;
  const flags = ["--no-ext-diff", "--no-textconv", "--text", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--stat", "--patch"];
  const paths = ["secrets/rule.md", "secrets/zz$(x)`long.md"];
  const total = [logOf(repo, baseline, paths), git(repo, "diff", ...flags, baseline, "HEAD", "--", ...paths).stdout.toString()]
    .map((text) => text.replace(/\n$/, "").split("\n").length)
    .reduce((a, b) => a + b);
  const cut = `(${total - 200} more lines not shown: ${SAFE} ${short(repo, baseline)} ${short(repo, head(repo))})`;
  assert.doesNotMatch(lines.find((line) => line.includes("more lines not shown")) || "", /\$\(|`/, "no user-controlled text in the cut line");
  assert.strictEqual(lines.indexOf(cut), top + 200, out);
  assert.ok(out.endsWith(`${cut}\n${footer(repo)}`), out);
});

test("approve: an external diff, a textconv driver and a replace ref in the repo's own config do not change what is shown", async () => {
  const { repo, baseline } = sanctioned();
  git(repo, "config", "diff.external", "echo FAKE-EXTERNAL");
  git(repo, "config", "diff.fake.textconv", "echo FAKE-TEXTCONV");
  fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "secrets/** diff=fake\n");
  const real = git(repo, "rev-parse", "HEAD:secrets/rule.md").stdout.toString().trim();
  const source = path.join(tmp, `forged-${process.hrtime.bigint()}.txt`);
  fs.writeFileSync(source, "forged\n");
  git(repo, "replace", real, git(repo, "hash-object", "-w", source).stdout.toString().trim());
  assert.match(git(repo, "show", "HEAD:secrets/rule.md").stdout.toString(), /forged/, "the replace ref is live");

  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`${header(repo, baseline, "secrets/rule.md")}\n`), out);
  assert.ok(out.split("\n").includes("+sanctioned"), out);
  assert.doesNotMatch(out, /forged|FAKE-/, out);
});

test("approve: a committed krites.toml gets its config hash on approve-write, a dirty one that differs from HEAD's does not", async () => {
  const repo = guarded();
  const baseline = readBaseline(repo);
  fs.appendFileSync(path.join(repo, "krites.toml"), "# reviewed\n");
  commit(repo, "config", "krites.toml");
  assertBlock(await gate(repo), /protected path changed: krites\.toml/);
  assert.match(await cli(repo, "approve"), /^Protected paths changed in commits since the baseline [0-9a-f]+:\n\* krites\.toml\n/);
  assert.strictEqual(await cli(repo, "approve", "--write"), done(repo, baseline, ["krites.toml"], true));
  assert.strictEqual(readConfigHash(repo), configHash(repo));
  assert.deepStrictEqual(await gate(repo), SILENT);

  const dirty = guarded();
  const dirtyBase = readBaseline(dirty);
  fs.appendFileSync(path.join(dirty, "krites.toml"), "# reviewed\n");
  commit(dirty, "config", "krites.toml");
  fs.appendFileSync(path.join(dirty, "krites.toml"), "# and more\n");
  const out = await cli(dirty, "approve");
  assert.ok(out.endsWith(`${NOT_COMMITTED}\n* krites.toml\n${footer(dirty)}`), out);
  assert.strictEqual(await cli(dirty, "approve", "--write"), done(dirty, dirtyBase, ["krites.toml"]));
  assert.notStrictEqual(readConfigHash(dirty), configHash(dirty));
  assertBlock(await gate(dirty), /protected path changed: krites\.toml/);
});

test("approve: with no baseline or nothing committed nothing is written and a stale pending file goes", async () => {
  const bare = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } });
  configure(bare, { commands: [], globs: ["secrets/**"] });
  fs.mkdirSync(path.join(bare, ".krites"), { recursive: true });
  fs.writeFileSync(krites(bare, "approve-pending"), `${head(bare)} ${head(bare)}\n`);
  assert.strictEqual(await cli(bare, "approve"), NO_BASELINE);
  assert.strictEqual(pending(bare), null);
  assert.strictEqual(readBaseline(bare), null);

  const repo = guarded();
  fs.writeFileSync(krites(repo, "approve-pending"), `${head(repo)} ${head(repo)}\n`);
  assert.strictEqual(await cli(repo, "approve"), NOTHING);
  assert.strictEqual(pending(repo), null);
  assert.strictEqual(await cli(repo, "approve", "--write"), FIRST);
});

test("approve: approve-write with no baseline writes nothing and says why", async () => {
  const bare = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } });
  configure(bare, { commands: [], globs: ["secrets/**"] });
  fs.mkdirSync(path.join(bare, ".krites"), { recursive: true });
  fs.writeFileSync(krites(bare, "approve-pending"), `${head(bare)} ${head(bare)}\n`);
  assert.strictEqual(await cli(bare, "approve", "--write"), NO_BASELINE);
  assert.deepStrictEqual([readBaseline(bare), approved(bare), readConfigHash(bare)], [null, null, null]);
});

test("approve: the consent question closes both approve commands, and an unknown argument gets only the usage line", async () => {
  const repo = guarded();
  const env = { KRITES_PING_ENDPOINT: "http://127.0.0.1:9/never-reached", KRITES_CONFIG_DIR: path.join(tmp, `approve-consent-${Date.now()}`) };
  assert.strictEqual((await runCli(["approve"], { cwd: repo, env })).stdout, `${NOTHING}${QUESTION}\n`);
  assert.strictEqual((await runCli(["approve", "--write"], { cwd: repo, env })).stdout, `${FIRST}${QUESTION}\n`);
  edit(repo, "secrets/rule.md", "sanctioned\n");
  commit(repo, "sanctioned rule", "secrets/rule.md");
  for (const args of [["approve", "--force"], ["approve", "--write", "extra"], ["approve", "write"]]) {
    const result = await runCli(args, { cwd: repo, env });
    assert.match(result.stdout, /^usage: .*\/krites:approve, \/krites:approve-write,/, args.join(" "));
    assert.strictEqual(result.stdout.split("\n").filter(Boolean).length, 1, `${args.join(" ")}: the usage line and nothing else`);
  }
  assert.strictEqual(pending(repo), null);
});

test("approve: a protected path a commit changed is shown even when the tree holds the baseline's content, so what is excused was shown", async () => {
  const repo = guarded();
  const baseline = readBaseline(repo);
  edit(repo, "secrets/other.md", "agent\n");
  commit(repo, "agent", "secrets/other.md");
  edit(repo, "secrets/rule.md", "sanctioned\n");
  commit(repo, "sanctioned rule", "secrets/rule.md");
  edit(repo, "secrets/other.md", "other\n");

  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`${header(repo, baseline, "secrets/other.md", "secrets/rule.md")}\n`), out);
  assert.ok(out.split("\n").includes("+agent"), out);
  assert.ok(out.endsWith(`${NOT_COMMITTED}\n* secrets/other.md\n${footer(repo)}`), out);
  assert.strictEqual(await cli(repo, "approve", "--write"), done(repo, baseline, ["secrets/other.md", "secrets/rule.md"]));
  git(repo, "checkout", "--", "secrets/other.md");
  assert.deepStrictEqual(await gate(repo), SILENT);
});

test("approve: a dirty krites.toml that narrows the globs cannot hide a committed protected path", async () => {
  const { repo, baseline } = sanctioned();
  fs.writeFileSync(path.join(repo, "krites.toml"), toml({ commands: [] }));
  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`${header(repo, baseline, "secrets/rule.md")}\n`), out);
  assert.ok(out.endsWith(`${NOT_COMMITTED}\n* krites.toml\n${footer(repo)}`), out);
});

test("approve: with an approval a path back at the baseline's content passes, and a third content refutes", async () => {
  const { repo } = sanctioned();
  await cli(repo, "approve");
  await cli(repo, "approve", "--write");
  edit(repo, "secrets/rule.md", "third\n");
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/rule.md"));

  git(repo, "checkout", "--", "secrets/rule.md");
  git(repo, "revert", "--no-edit", "HEAD");
  assert.deepStrictEqual(await gate(repo), SILENT, "a revert of the approved commit does not wedge the session");
  assert.strictEqual(lastRun(repo).verdict, "passed");
});

test("approve: a HEAD that does not descend from the baseline is named so, and an empty commit list says so", async () => {
  const repo = guarded();
  edit(repo, "secrets/rule.md", "later\n");
  commit(repo, "later", "secrets/rule.md");
  const baseline = readBaseline(seed(repo));
  git(repo, "reset", "-q", "--hard", "HEAD~1");
  const [from, to] = [short(repo, baseline), short(repo, head(repo))];
  const none = `(no commit in ${from}..${to} changed these paths)`;

  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`Protected paths that differ between the baseline ${from} and HEAD ${to}:\n* secrets/rule.md\n${none}\n`), out);
  assert.ok(out.split("\n").includes("+rule"), out);
  assert.strictEqual(await cli(repo, "approve", "--write"), `Approved these protected changes up to ${to}:\n* secrets/rule.md\n${none}\n${STILL}`);
  assert.deepStrictEqual(await gate(repo), SILENT);
});

test("approve: an approved-head whose HEAD is not a commit is ignored", async () => {
  const { repo, baseline } = sanctioned();
  const tree = git(repo, "rev-parse", "HEAD^{tree}").stdout.toString().trim();
  fs.writeFileSync(krites(repo, "approved-head"), `${baseline} ${tree}\n`);
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/rule.md"));
});

test("approve: a protected file whose name holds glob characters shows and approves only itself", async () => {
  // Windows allows [ in a file name but not *.
  const odd = WINDOWS ? "x[ab].md" : "x[ab]*.md";
  const repo = makeRepo({ files: { "a.txt": "a\n", [odd]: "odd\n", "xa.md": "plain\n" } });
  configure(repo, { commands: [script("console.log('fine')")], globs: ["x[*"] });
  const baseline = readBaseline(seed(repo));
  edit(repo, odd, "sanctioned\n");
  edit(repo, "xa.md", "changed too\n");
  commit(repo, "both", odd, "xa.md");

  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`${header(repo, baseline, odd)}\n`), out);
  assert.ok(out.split("\n").includes("+sanctioned"), out);
  assert.doesNotMatch(out, /changed too|b\/xa\.md/, out);
  assert.strictEqual(await cli(repo, "approve", "--write"), done(repo, baseline, [odd]));
});

test("approve: approving twice in a row moves the approval to the newer commit", async () => {
  const { repo, baseline } = sanctioned();
  await cli(repo, "approve");
  await cli(repo, "approve", "--write");
  edit(repo, "secrets/other.md", "second\n");
  commit(repo, "second", "secrets/other.md");
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/other.md"));

  assert.ok((await cli(repo, "approve")).startsWith(`${header(repo, baseline, "secrets/other.md", "secrets/rule.md")}\n`));
  assert.strictEqual(await cli(repo, "approve", "--write"), done(repo, baseline, ["secrets/other.md", "secrets/rule.md"]));
  assert.strictEqual(approved(repo), `${baseline} ${head(repo)}`);
  assert.deepStrictEqual(await gate(repo), SILENT);
});

test("approve: init-write on a krites.toml that protects more drops the approval, so a path never shown is not excused", async () => {
  const repo = guarded();
  const baseline = readBaseline(repo);
  edit(repo, "scripts/deploy.sh", "deploy\n");
  commit(repo, "agent", "scripts/deploy.sh");
  edit(repo, "secrets/rule.md", "sanctioned\n");
  commit(repo, "sanctioned rule", "secrets/rule.md");
  assert.ok((await cli(repo, "approve")).startsWith(`${header(repo, baseline, "secrets/rule.md")}\n`));
  await cli(repo, "approve", "--write");

  fs.writeFileSync(path.join(repo, "krites.toml"), toml({ commands: [script("console.log('fine')")], globs: ["secrets/**", "scripts/**"] }));
  await cli(repo, "init", "--write");
  assert.strictEqual(approved(repo), null);
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("scripts/deploy.sh"));
});

test("approve: init-write that writes a new krites.toml drops the approval too", async () => {
  const { repo } = sanctioned();
  await cli(repo, "approve");
  await cli(repo, "approve", "--write");
  assert.notStrictEqual(approved(repo), null);

  fs.rmSync(path.join(repo, "krites.toml"));
  edit(repo, "package.json", JSON.stringify({ scripts: { test: "node -e 0" } }));
  await cli(repo, "init", "--write");
  assert.ok(fs.existsSync(path.join(repo, "krites.toml")));
  assert.strictEqual(approved(repo), null);
});

test("approve: an approved deletion of a protected path passes, and recreating it with other content refutes", async () => {
  const repo = guarded();
  git(repo, "rm", "-q", "secrets/rule.md");
  git(repo, "commit", "-q", "-m", "drop the rule");
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/rule.md"));
  await cli(repo, "approve");
  await cli(repo, "approve", "--write");

  edit(repo, "secrets/rule.md", "back, and different\n");
  assert.strictEqual(assertBlock(await gate(repo), /protected path changed/), REFUTED("secrets/rule.md"));
  fs.rmSync(path.join(repo, "secrets", "rule.md"));
  assert.deepStrictEqual(await gate(repo), SILENT);
});

// The working krites.toml protects nothing extra in both, so only the commit's own krites.toml can name the path.
function narrowedBy(side) {
  const repo = makeRepo({ files: { "a.txt": "a\n", "secrets/rule.md": "rule\n" } });
  configure(repo, { commands: [script("console.log('fine')")], globs: side === "baseline" ? ["secrets/**"] : [] });
  const baseline = readBaseline(seed(repo));
  fs.writeFileSync(path.join(repo, "krites.toml"), toml({ commands: [script("console.log('fine')")], globs: side === "baseline" ? [] : ["secrets/**"] }));
  edit(repo, "secrets/rule.md", "sanctioned\n");
  commit(repo, "config and rule", "krites.toml", "secrets/rule.md");
  fs.writeFileSync(path.join(repo, "krites.toml"), toml({ commands: [] }));
  return { repo, baseline };
}

test("approve: a path only the baseline's krites.toml protects is shown", async () => {
  const { repo, baseline } = narrowedBy("baseline");
  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`${header(repo, baseline, "krites.toml", "secrets/rule.md")}\n`), out);
});

test("approve: a path only HEAD's krites.toml protects is shown", async () => {
  const { repo, baseline } = narrowedBy("head");
  const out = await cli(repo, "approve");
  assert.ok(out.startsWith(`${header(repo, baseline, "krites.toml", "secrets/rule.md")}\n`), out);
});
