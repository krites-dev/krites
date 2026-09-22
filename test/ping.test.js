const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const gate = require("../hooks/gate.js");
const ping = require("../lib/ping.js");
const sign = require("../lib/sign.js");
const { assertBlock, configure, makeRepo, runCli, runHook, script, seed, tmp } = require("./helpers.js");

const VERSION = require("../.claude-plugin/plugin.json").version;
const GATE = path.join(__dirname, "..", "hooks", "gate.js");
const HEADERS = ["connection", "content-length", "content-type", "host"];
const FILE = "telemetry.json";
const INSTALL_ID = "11111111-2222-4333-8444-555555555555";
const SILENT = { code: 0, stdout: "", stderr: "" };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const listing = (dir) => {
  try {
    return fs.readdirSync(dir).sort().join(",");
  } catch {
    return null;
  }
};

// The real location is read once, with the override out of the way, and is expected untouched at the end.
const saved = process.env.KRITES_CONFIG_DIR;
delete process.env.KRITES_CONFIG_DIR;
const REAL = sign.configDir();
if (saved !== undefined) process.env.KRITES_CONFIG_DIR = saved;
const REAL_BEFORE = listing(REAL);

let configs = 0;
const freshConfig = () => (process.env.KRITES_CONFIG_DIR = path.join(tmp, `ping-config${++configs}`));
freshConfig();

const stateFile = () => path.join(process.env.KRITES_CONFIG_DIR, FILE);

const stored = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
};

function granted(lastAttemptAt = null) {
  const dir = freshConfig();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ install_id: INSTALL_ID, consent: "granted", last_attempt_at: lastAttemptAt }));
  return dir;
}

const sinks = [];
after(() => {
  for (const sink of sinks) sink.stop();
});

// Every request in this file goes to a server this file started on the loopback interface.
async function listen({ answer = true } = {}) {
  const seen = [];
  const sockets = new Set();
  const instance = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, type: request.headers["content-type"], headers: Object.keys(request.headers).sort(), body });
      if (answer) response.end("{}");
    });
  });
  instance.on("connection", (socket) => sockets.add(socket.on("close", () => sockets.delete(socket))));
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  instance.unref();
  const sink = {
    url: `http://127.0.0.1:${instance.address().port}/ping`,
    seen,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => instance.close(resolve));
    },
  };
  sinks.push(sink);
  return sink;
}

const stop = (cwd) => ({ hook_event_name: "Stop", stop_hook_active: false, session_id: "s1", cwd });

function repoWith(source, extra = {}) {
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script(source)], timeoutSeconds: 60, ...extra });
  seed(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  return repo;
}

test("ping: nothing is sent before consent, and the question comes only while an endpoint is on", async () => {
  freshConfig();
  const sink = await listen();
  const repo = repoWith("console.log('ok')");

  const quiet = await runCli(["verify"], { cwd: repo });
  assert.ok(!quiet.stdout.includes(ping.QUESTION), "an endpoint that is off asks nothing");

  for (const args of [["verify"], ["init"], ["receipt"]]) {
    const result = await runCli(args, { cwd: repo, env: { KRITES_PING_ENDPOINT: sink.url } });
    assert.strictEqual(result.code, 0, args.join(" "));
    assert.strictEqual(result.stderr, "", args.join(" "));
    assert.ok(result.stdout.endsWith(`${ping.QUESTION}\n`), `${args.join(" ")} ends with the question: ${result.stdout}`);
  }

  assert.deepStrictEqual(sink.seen, [], "an unanswered question sends nothing");
  assert.strictEqual(fs.existsSync(stateFile()), false, "and writes no state file");
});

test("ping: off is permanent across commands until on, which sends the first ping", async () => {
  freshConfig();
  const sink = await listen();
  const repo = repoWith("console.log('ok')");
  const env = { KRITES_PING_ENDPOINT: sink.url };

  assert.match((await runCli(["telemetry", "off"], { cwd: repo, env })).stdout, /Telemetry is off/);
  for (const args of [["verify"], ["init"], ["telemetry"], ["receipt"]]) {
    const result = await runCli(args, { cwd: repo, env });
    assert.ok(!result.stdout.includes(ping.QUESTION), `${args.join(" ")} does not ask again`);
  }
  assert.deepStrictEqual(sink.seen, [], "a declined install sends nothing");
  assert.strictEqual(stored().consent, "declined");

  assert.match((await runCli(["telemetry", "on"], { cwd: repo, env })).stdout, /Telemetry is on/);
  assert.strictEqual(sink.seen.length, 1, "on sends the first ping now");
  assert.strictEqual(stored().consent, "granted");

  const after = await runCli(["verify"], { cwd: repo, env });
  assert.ok(!after.stdout.includes(ping.QUESTION), "an answered install is never asked again");
  assert.strictEqual(sink.seen.length, 1, "and is not pinged twice in one week");
});

test("ping: the body is exactly the four fields, posted as json", async () => {
  granted();
  const sink = await listen();
  await ping.send({ endpoint: sink.url });

  assert.strictEqual(sink.seen.length, 1);
  const { method, type, headers, body } = sink.seen[0];
  assert.strictEqual(method, "POST");
  assert.strictEqual(type, "application/json");
  assert.deepStrictEqual(headers, HEADERS, "the request carries no header that could identify the install");
  const payload = JSON.parse(body);
  assert.deepStrictEqual(Object.keys(payload).sort(), ["install_id", "os", "ts", "version"]);
  assert.strictEqual(payload.install_id, INSTALL_ID);
  assert.strictEqual(payload.version, VERSION);
  assert.strictEqual(payload.os, process.platform);
  assert.match(payload.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("ping: an attempt inside seven days sends nothing and one after seven days sends", async () => {
  granted();
  const sink = await listen();
  const first = Date.parse("2026-09-19T12:00:00Z");

  await ping.send({ endpoint: sink.url, now: first });
  assert.strictEqual(sink.seen.length, 1);
  assert.strictEqual(stored().last_attempt_at, "2026-09-19T12:00:00Z");

  await ping.send({ endpoint: sink.url, now: first + WEEK_MS - 1000 });
  assert.strictEqual(sink.seen.length, 1, "nothing goes out inside the week");

  await ping.send({ endpoint: sink.url, now: first + WEEK_MS });
  assert.strictEqual(sink.seen.length, 2, "the week is up");
  assert.strictEqual(stored().last_attempt_at, "2026-09-26T12:00:00Z");
});

test("ping: a refused connection still spends the week's attempt", async () => {
  granted();
  const dead = await listen();
  await dead.stop();

  await ping.send({ endpoint: dead.url, now: Date.parse("2026-09-19T12:00:00Z") });
  assert.strictEqual(stored().last_attempt_at, "2026-09-19T12:00:00Z", "a dead endpoint costs one attempt a week, not one a stop");
  assert.strictEqual(stored().install_id, INSTALL_ID);
});

test("ping: a server that never answers costs the cap and no more", async () => {
  granted();
  const hung = await listen({ answer: false });

  const started = Date.now();
  await ping.send({ endpoint: hung.url });
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 1800 && elapsed < 8000, `the attempt is abandoned at the cap (${elapsed} ms)`);
  assert.strictEqual(hung.seen.length, 1, "the body left before the cap fired");
  assert.notStrictEqual(stored().last_attempt_at, null);
});

test("ping: an allowed stop pings once, and a hung endpoint changes nothing about the answer", { timeout: 60000 }, async () => {
  granted();
  const hung = await listen({ answer: false });
  const repo = repoWith("console.log('fine')");

  const started = Date.now();
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env: { KRITES_PING_ENDPOINT: hung.url } }), SILENT);
  const elapsed = Date.now() - started;
  assert.strictEqual(hung.seen.length, 1, "the allowed stop at the end of the chain pings");
  assert.notStrictEqual(stored().last_attempt_at, null);
  assert.ok(elapsed < 15000, `the hook waits for the cap and no longer (${elapsed} ms)`);
});

test("ping: a run that has used up its budget does not ping", async () => {
  granted();
  const sink = await listen();
  const repo = makeRepo({ files: { "a.txt": "a\n" } });
  configure(repo, { commands: [script("process.exit(0)")], timeoutSeconds: 60 });
  seed(repo);
  const saved = process.env.KRITES_PING_ENDPOINT;
  process.env.KRITES_PING_ENDPOINT = sink.url;

  try {
    assert.strictEqual(await gate.gate(stop(repo), { totalMs: 4000, startedAt: Date.now() - 5000, projectDir: repo }), null);
    assert.deepStrictEqual(sink.seen, [], "a run already past its budget has no 2 s to spare");
    assert.strictEqual(stored().last_attempt_at, null);

    assert.strictEqual(await gate.gate(stop(repo), { projectDir: repo }), null);
    assert.strictEqual(sink.seen.length, 1, "the same stop inside the budget pings");
  } finally {
    if (saved === undefined) delete process.env.KRITES_PING_ENDPOINT;
    else process.env.KRITES_PING_ENDPOINT = saved;
  }
});

test("ping: a test process that loads the helpers has the endpoint off and keeps its state under the temp directory", async () => {
  // gate() and main() also run inside test processes, where childEnvFor guards nothing.
  const outside = path.join(os.tmpdir(), `krites-developer-config-${process.pid}`);
  const show = script(
    `const { tmp } = require(${JSON.stringify(path.join(__dirname, "helpers.js"))});
     console.log("ENV:" + JSON.stringify([process.env.KRITES_PING_ENDPOINT || null, String(process.env.KRITES_CONFIG_DIR).startsWith(tmp)]));`,
  )[1];
  const developer = { KRITES_PING_ENDPOINT: "http://127.0.0.1:9/", KRITES_CONFIG_DIR: outside };
  const out = (await runHook(show, null, { cwd: tmp, env: developer })).stdout;
  const line = out.split("\n").find((text) => text.startsWith("ENV:"));
  assert.deepStrictEqual(JSON.parse(line.slice(4)), ["off", true], line);
});

test("ping: a spawned child sees neither the parent's endpoint nor its config directory", async () => {
  const sink = await listen();
  const child = path.join(tmp, "child-config");
  const outside = path.join(os.tmpdir(), `krites-parent-config-${process.pid}`);
  const saved = { endpoint: process.env.KRITES_PING_ENDPOINT, config: process.env.KRITES_CONFIG_DIR };
  process.env.KRITES_PING_ENDPOINT = sink.url;
  process.env.KRITES_CONFIG_DIR = outside;
  const show = script("console.log(JSON.stringify([process.env.KRITES_PING_ENDPOINT || null, process.env.KRITES_CONFIG_DIR || null]));")[1];

  try {
    const repo = repoWith("console.log('ok')");
    await runHook(GATE, stop(repo), { cwd: repo });
    assert.deepStrictEqual(JSON.parse((await runHook(show, null, { cwd: tmp })).stdout), ["off", child], "a hook gets neither");
    assert.match((await runCli(["telemetry"], { cwd: repo })).stdout, /KRITES_PING_ENDPOINT is set to off/, "and neither does a command");

    const made = await runCli(["receipt"], { cwd: repo });
    assert.strictEqual(made.code, 0, made.stdout);
    assert.ok(fs.existsSync(path.join(child, "signing-key.pem")), "the child signs under the test temp directory");
    assert.strictEqual(fs.existsSync(outside), false, "and never under the directory the parent points at");

    const own = { KRITES_PING_ENDPOINT: sink.url, KRITES_CONFIG_DIR: path.join(tmp, "its-own") };
    assert.deepStrictEqual(JSON.parse((await runHook(show, null, { cwd: tmp, env: own })).stdout), [own.KRITES_PING_ENDPOINT, own.KRITES_CONFIG_DIR]);
    assert.ok((await runCli(["telemetry"], { cwd: repo, env: own })).stdout.includes(ping.QUESTION), "a test that passes its own still wins");
    assert.deepStrictEqual(sink.seen, [], "nothing was sent to the parent's endpoint");
  } finally {
    for (const [name, value] of [["KRITES_PING_ENDPOINT", saved.endpoint], ["KRITES_CONFIG_DIR", saved.config]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("ping: a blocked stop never pings", async () => {
  granted();
  const sink = await listen();
  const repo = repoWith("process.exit(1)");

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo, env: { KRITES_PING_ENDPOINT: sink.url } }), /refuted/);
  assert.deepStrictEqual(sink.seen, [], "a blocked stop is about to run again");
  assert.strictEqual(stored().last_attempt_at, null);
});

test("ping: a timed-out run never pings, not even when the budget lets the stop through", { timeout: 120000 }, async () => {
  granted();
  const sink = await listen();
  // A check that outlives the kill would hold the pipes its parent reads, so it lets them go and ends by itself.
  const hang = script(
    [
      "process.stdout.destroy();",
      "process.stderr.destroy();",
      "setTimeout(() => {}, 30000);",
    ].join("\n"),
  );
  const repo = repoWith("unused", { commands: [hang], timeoutSeconds: 1, maxBlocks: 1 });
  const env = { KRITES_PING_ENDPOINT: sink.url };

  assertBlock(await runHook(GATE, stop(repo), { cwd: repo, env }), /timed out/);
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo, env }), SILENT, "the budget lets the second stop through");

  assert.deepStrictEqual(sink.seen, [], "a run that timed out has no 2 s to spare");
  assert.strictEqual(stored().last_attempt_at, null);
});

test("ping: with the endpoint off nothing is written and nothing is sent", async () => {
  const dir = freshConfig();
  const repo = repoWith("console.log('ok')");

  for (const args of [["telemetry"], ["telemetry", "on"], ["telemetry", "off"], ["verify"], ["receipt"]]) {
    const result = await runCli(args, { cwd: repo });
    assert.strictEqual(result.code, 0, args.join(" "));
    assert.strictEqual(result.stderr, "", args.join(" "));
  }
  assert.deepStrictEqual(await runHook(GATE, stop(repo), { cwd: repo }), SILENT);
  assert.strictEqual(fs.existsSync(path.join(dir, FILE)), false, "an endpoint that is off is off altogether");
});

test("ping: the suite never resolves to the built-in endpoint, in the test process or in a child", async () => {
  assert.strictEqual(ping.ENDPOINT, "https://krites.dev/ping");
  assert.strictEqual(ping.endpointOf(), "", "the test process has the endpoint off");
  const show = script(`console.log(JSON.stringify(require(${JSON.stringify(path.join(__dirname, "..", "lib", "ping.js"))}).endpointOf()));`)[1];
  assert.strictEqual(JSON.parse((await runHook(show, null, { cwd: tmp })).stdout), "", "and so does a child spawned with no override");
  for (const empty of [undefined, ""]) {
    const env = { KRITES_PING_ENDPOINT: empty };
    assert.strictEqual(JSON.parse((await runHook(show, null, { cwd: tmp, env })).stdout), "", `and one whose override is ${JSON.stringify(empty)}`);
  }
});

test("ping: nothing was written under the real user config directory", () => {
  assert.strictEqual(listing(REAL), REAL_BEFORE, "the tests write only under the OS temp directory");
});
