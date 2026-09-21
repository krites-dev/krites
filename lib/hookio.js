const STDIN_DEADLINE_MS = 5000;

// A hook that crashes or outlives the agent's timeout fails open, so every path here answers first.
function run({ handle, fail }) {
  let done = false;
  const finish = (output) => {
    if (done) return;
    done = true;
    process.stdout.write(output || "", () => process.exit(0));
  };
  const crashed = (err) => finish(fail(`failed (${(err && (err.code || err.name)) || "unknown"})`));

  process.on("uncaughtException", crashed);
  const deadline = setTimeout(() => finish(fail("timed out reading its input")), STDIN_DEADLINE_MS);

  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("error", () => finish(fail("could not read its input")));
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", async () => {
    clearTimeout(deadline);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return finish(fail("could not read its input"));
    }
    try {
      finish(await handle(payload));
    } catch (err) {
      crashed(err);
    }
  });
}

module.exports = { run, STDIN_DEADLINE_MS };
