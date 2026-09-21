const { spawn, spawnSync } = require("node:child_process");

const TAIL_LINES = 60;
const TAIL_BYTES = 1 << 18;
const KILL_TIMEOUT_MS = 10000;
const WINDOWS = process.platform === "win32";

function killTree(child) {
  if (WINDOWS) {
    // A check that has exited gave its pid back (its pipes can outlive it), and taskkill would hit whatever holds it now.
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: KILL_TIMEOUT_MS });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    return;
  }
}

function runCheck(argv, root, onChild) {
  return new Promise((resolve) => {
    const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg}"` : arg);
    const options = { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
    // Windows needs a shell to run .cmd shims such as pnpm. Elsewhere detached gives the check a process group to kill.
    const child = WINDOWS
      ? spawn(argv.map(quote).join(" "), { ...options, shell: true })
      : spawn(argv[0], argv.slice(1), { ...options, detached: true });
    let out = "";
    onChild(child, () => out);
    const keep = (chunk) => (out = (out + chunk).slice(-TAIL_BYTES));
    child.stdout.setEncoding("utf8").on("data", keep);
    child.stderr.setEncoding("utf8").on("data", keep);
    child.on("error", (err) => resolve({ code: -1, out: `${out}\ncould not start (${err.code})` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const entry = (argv, code, startedAt, out) => ({
  command: argv.join(" "),
  exit_code: code,
  duration_ms: Math.max(0, Date.now() - startedAt),
  tail: out.split(/\r?\n/).slice(-TAIL_LINES).join("\n"),
});

async function runChecks({ commands, root, deadlineMs }) {
  if (commands.length === 0) return { verdict: "no_checks", checks: [], failed: null };

  const checks = [];
  let child = null;
  let partial = () => "";
  let running = commands[0];
  let started = Date.now();
  let timedOut = false;
  let timer;
  // The deadline answers on its own: a killed check whose pipes never close must not hold the verdict.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (child) killTree(child);
      const failed = entry(running, null, started, partial());
      resolve({ verdict: "timed_out", checks: [...checks, failed], failed });
    }, deadlineMs);
  });

  const work = (async () => {
    for (const argv of commands) {
      if (timedOut) return { verdict: "timed_out", checks, failed: null };
      running = argv;
      started = Date.now();
      const { code, out } = await runCheck(argv, root, (spawned, read) => {
        child = spawned;
        partial = read;
      });
      const check = entry(argv, code, started, out);
      checks.push(check);
      if (code !== 0) return { verdict: "refuted", checks, failed: check };
    }
    return { verdict: "passed", checks, failed: null };
  })();

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runChecks };
