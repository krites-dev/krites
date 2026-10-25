const assert = require("node:assert");
const { test } = require("node:test");

const { gitCommits } = require("../lib/shell.js");

const commit = (over) => ({ dirs: [], all: false, paths: [], ...over });

const CLAUDE = 'git commit -m "$(cat <<\'EOF\'\nfix: quote " and run git push\n\nthen git commit again\nEOF\n)"';

const BASH = [
  ["git commit -m x", [commit()]],
  ["git commit -am x", [commit({ all: true })]],
  ["git commit -ma", [commit()]],
  ["git commit --all -m x", [commit({ all: true })]],
  ["git commit -m x a.js", [commit({ paths: ["a.js"] })]],
  ["git commit -m x -- a.js", [commit({ paths: ["a.js"] })]],
  ["git commit --message=x -- -a", [commit({ paths: ["-a"] })]],
  ["git commit a.js -m x", [commit({ paths: ["a.js"] })]],
  ["git commit --pathspec-from-file list.txt -m x", [commit({ paths: ["list.txt"] })]],
  ["git commit --pathspec-from-file=list.txt", [commit({ paths: ["list.txt"] })]],
  ['git commit -F msg.txt --author "A <a@b>" --date now -C HEAD', [commit()]],
  ["cd sub && git commit -m x", [commit({ dirs: ["sub"] })]],
  ["git -C sub -c x=y commit", [commit({ dirs: ["sub"] })]],
  ["cd a; cd -; cd; pushd 'b c' && git --no-pager -P -C d commit", [commit({ dirs: ["~", "b c", "d"] })]],
  ["(cd plugin && npm test) && git add -A && git commit -m x", [commit()]],
  ['git commit -m "$(cd other; echo x)"', [commit()]],
  ["echo `cd other` && git commit", [commit()]],
  ["cd /tmp/x && ls; cd - && git commit -m x", [commit()]],
  ["pushd a && popd && git commit", [commit()]],
  ["pushd a && cd b && popd && git commit -m x", [commit()]],
  ["cd a && pushd b && cd c && popd && git commit", [commit({ dirs: ["a"] })]],
  ["(pushd a) && popd && cd b && git commit", [commit({ dirs: ["b"] })]],
  ["pushd x && (pushd a) && popd && git commit", [commit()]],
  ["pushd x && (cd a && pushd b) && popd && git commit", [commit()]],
  ["popd; cd -; git commit", [commit()]],
  ["cd && git commit", [commit({ dirs: ["~"] })]],
  ["git commit --help", []],
  ["git commit -h", []],
  ["git commit --dry-run -m x", []],
  ["git commit --short", []],
  ["git commit --porcelain -m x", []],
  ["git commit --long -a", []],
  ["git commit -z -m x", []],
  ["git commit --null -a", []],
  ["git commit -m x --dry-run && git commit -m y", [commit()]],
  ["git commit -m x -- --dry-run", [commit({ paths: ["--dry-run"] })]],
  ["git commit -m $'it\\'s fixed'", [commit()]],
  ["git commit -m $'a\\nb' c.js", [commit({ paths: ["c.js"] })]],
  ["cd $HOME/x && git commit", [commit({ dirs: ["$HOME/x"] })]],
  ["(cd sub && git commit -m x)", [commit({ dirs: ["sub"] })]],
  ["FOO=1 env git commit -m x", [commit()]],
  ["env -i -u BAR FOO=1 command time -p git commit -m x", [commit()]],
  ["/usr/bin/git commit -m x", [commit()]],
  ["git.exe commit -m x", [commit()]],
  [CLAUDE, [commit()]],
  ["cat > a.md <<'EOF'\ngit commit -m x\nEOF", []],
  ["cat <<-EOF\n\tgit commit\n\tEOF\ngit commit -m y", [commit()]],
  ['echo "git commit"', []],
  ["git log --grep commit", []],
  ["git commit-tree abc", []],
  ["# git commit", []],
  ["echo hi # git commit", []],
  ["git commit -m x 2>&1 | tail -3", [commit()]],
  ["git commit -m x > out.txt", [commit()]],
  ["git commit -m x &> log.txt && git push", [commit()]],
  ["git commit -m x <<< y 2>/dev/null", [commit()]],
  ["git add . && git commit -m x && git push", [commit()]],
  ["git commit -m 'a; git commit' ; git commit -am y", [commit(), commit({ all: true })]],
  ['git commit -m "$(echo x)" b.js', [commit({ paths: ["b.js"] })]],
  ["git commit -m x \\\n  b.js", [commit({ paths: ["b.js"] })]],
  ["echo `git commit -m x`", [commit()]],
  ["git status; git commit", [commit()]],
];

const POWERSHELL = [
  ["Set-Location D:\\r\\sub; git commit -m x", [commit({ dirs: ["D:\\r\\sub"] })]],
  ["sl sub; Push-Location -Path 'D:\\a b'; git commit", [commit({ dirs: ["sub", "D:\\a b"] })]],
  ["$m = @'\ngit commit -m x\n'@\nWrite-Output $m", []],
  ['$m = @"\ngit commit -m "x"\n"@', []],
  ["git commit -m @'\nsay \"git commit\" and 'git push'\n'@", [commit()]],
  ['& "C:\\Program Files\\Git\\cmd\\git.exe" commit -am x 2>&1', [commit({ all: true })]],
  ["GIT.EXE commit -m x 2>$null", [commit()]],
  ["git commit -m x > $null", [commit()]],
  ["git commit -m x *>&1 | Select-Object -Last 3", [commit()]],
  ["<# git commit #> git status", []],
  ["# git commit", []],
  ["git commit -m 'it''s' a.js", [commit({ paths: ["a.js"] })]],
  ['git commit -m "a`"b" -- x.js', [commit({ paths: ["x.js"] })]],
  ["if ($ok) { git commit -m x }", [commit()]],
  ['git commit -m "$(Get-Date)"', [commit()]],
  ["git add -A && git commit -m x", [commit()]],
  ["Push-Location x; Pop-Location; git commit", [commit()]],
  ["@(Set-Location x); (cd y); git commit", [commit({ dirs: ["x", "y"] })]],
  ["if ($ok) { Set-Location sub }; git commit", [commit({ dirs: ["sub"] })]],
  ["$m=@'\nit's done\n'@\ngit commit -m $m", [commit()]],
  ['$m=@"\nsay "done"\n"@\ngit commit -m $m', [commit()]],
  ["git commit -h", []],
];

test("shell: bash command lines", () => {
  for (const [line, expected] of BASH) {
    assert.deepStrictEqual(gitCommits(line, "bash"), expected, JSON.stringify(line));
  }
});

test("shell: PowerShell command lines", () => {
  for (const [line, expected] of POWERSHELL) {
    assert.deepStrictEqual(gitCommits(line, "powershell"), expected, JSON.stringify(line));
  }
});

test("shell: unclosed quotes, substitutions and heredocs end with the input", () => {
  for (const dialect of ["bash", "powershell"]) {
    for (const line of ['git commit -m "x', "git commit -m 'x", "git commit -m $(x", "cat <<EOF\ngit", "@'\nx", "<# x", "x `", "x \\"]) {
      assert.ok(Array.isArray(gitCommits(line, dialect)), JSON.stringify(line));
    }
  }
  assert.deepStrictEqual(gitCommits(undefined, "bash"), []);
});

test("shell: a $( nested past the cap is text glued to the next word, and deep nesting does not throw", () => {
  const nested = (depth) => `${"$(".repeat(depth)}cd sub; git commit -m x${")".repeat(depth)}`;
  assert.deepStrictEqual(gitCommits(nested(10), "bash"), [commit({ dirs: ["sub"] })]);
  assert.deepStrictEqual(gitCommits(nested(60), "bash"), [commit()]);
  assert.deepStrictEqual(gitCommits(`${nested(60)}; git commit -a`, "bash"), [commit(), commit({ all: true })]);
  assert.deepStrictEqual(gitCommits(nested(100000), "powershell"), [commit()]);
});

const PIECES = ["git", "commit", "cd", "-C", "-am", "--", '"', "'", "\\", "`", "$(", ")", "(", ";", "&", "&&", "|", ">", "<", "2>&1", "#", "@'", "'@", "<<EOF", "EOF", "\n", "\n", " ", "x", "-m"];

test("shell: random lines never throw and always return well-formed commits", () => {
  let seed = 20261021;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let n = 0; n < 2000; n++) {
    let line = "";
    const count = 1 + Math.floor(next() * 30);
    for (let k = 0; k < count; k++) line += PIECES[Math.floor(next() * PIECES.length)] + (next() < 0.6 ? " " : "");
    for (const dialect of ["bash", "powershell"]) {
      const found = gitCommits(line, dialect);
      assert.ok(Array.isArray(found), JSON.stringify(line));
      for (const one of found) {
        assert.deepStrictEqual(Object.keys(one).sort(), ["all", "dirs", "paths"], JSON.stringify(line));
        assert.strictEqual(typeof one.all, "boolean");
        for (const list of [one.dirs, one.paths]) {
          assert.ok(Array.isArray(list) && list.every((item) => typeof item === "string"), JSON.stringify(line));
        }
      }
    }
  }
});
