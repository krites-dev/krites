const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const COMMANDS = path.join(__dirname, "..", "commands");
const ALLOWED = 'Bash(node "${CLAUDE_PLUGIN_ROOT}/cli.js":*)';
const KEYS = ["allowed-tools", "description", "disable-model-invocation"];
const NO_TOOL = "Use no tool: do not open, read, run or change anything, including any file the output names.";
const WITH_ARGUMENTS = ["init", "telemetry"];
const ONE_BLOCK = "inside one fenced code block, exactly as printed, and nothing else: every line of it inside the block";
const LONGER = "If the output itself holds a line of backticks, make your fence longer than it.";

function read(name) {
  const text = fs.readFileSync(path.join(COMMANDS, `${name}.md`), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${name}.md opens with a frontmatter block`);
  const keys = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    assert.ok(at > 0, `${name}.md frontmatter line is key: value (${line})`);
    keys[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return { keys, bang: match[2].split("\n").filter((line) => line.startsWith("!")), body: match[2] };
}

test("commands: each file carries exactly the frontmatter the spec names", () => {
  for (const name of ["init", "verify", "receipt", "telemetry"]) {
    const { keys } = read(name);
    const expected = [...KEYS, ...(WITH_ARGUMENTS.includes(name) ? ["argument-hint"] : [])].sort();
    assert.deepStrictEqual(Object.keys(keys).sort(), expected, name);
    assert.strictEqual(keys["disable-model-invocation"], "true", `${name}: the model may not invoke the command itself`);
    assert.strictEqual(keys["allowed-tools"], ALLOWED, `${name}: the grant names this plugin's own script, not all of node`);
    assert.ok(keys.description.length > 0, `${name}: a description`);
  }
});

test("commands: init, receipt and telemetry are one pre-executed line that takes the arguments as typed", () => {
  for (const name of ["init", "receipt", "telemetry"]) {
    const { bang, body } = read(name);
    assert.strictEqual(bang.length, 1, `${name}: exactly one ! line`);
    assert.strictEqual(bang[0], `!\`node "\${CLAUDE_PLUGIN_ROOT}/cli.js" ${name} $ARGUMENTS\``, name);
    assert.ok(body.includes(NO_TOOL), `${name}: the output is already there, so the turn opens nothing it names`);
  }
});

test("commands: verify has no pre-executed line and asks for the Bash tool timeout the spike recorded", () => {
  const { bang, body } = read("verify");
  assert.deepStrictEqual(bang, [], "a ! line is cut off at 120 s, so verify cannot use one");
  assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/cli.js" verify'), body);
  assert.match(body, /timeout/);
  assert.ok(body.includes("600000"), "the Bash tool's maximum, which the spike recorded as delivered");
});

test("commands: init and verify ask for the output as one code block, since the reply is rendered as markdown", () => {
  // Seen in a terminal: shown plain, a glob's ** read as bold and vanished, and a "> " line became a quote.
  for (const name of ["init", "verify"]) {
    const { body } = read(name);
    assert.ok(body.includes(ONE_BLOCK), `${name}: ${ONE_BLOCK}`);
    assert.ok(body.includes(LONGER), `${name}: ${LONGER}`);
  }
});
