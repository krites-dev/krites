const fs = require("node:fs");
const path = require("node:path");

const { scrub } = require("./scrub.js");
const settings = require("./settings.js");
const { canonical, fingerprintOf, sign } = require("./sign.js");
const state = require("./state.js");

const SCHEMA = "krites.receipt/0.3";
const RUN_SCHEMA = "krites.last-run/0.1";
const VERDICTS = ["passed", "refuted", "timed_out", "no_checks"];
const LAST_RUN = path.join(".krites", "last-run.json");
const NOTHING = "nothing to sign: no gate run is recorded for this repo";
const STALE = "the tree changed since the last gate run; run /krites:verify first";
const FORGED = "the recorded run is not one the gate wrote; run /krites:verify";

const CREATED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const HEAD = /^([0-9a-f]{40,64})?$/;
const CHECK_KEYS = "command,duration_ms,exit_code,tail";
const DIFF_KEYS = "deletions,files,files_changed,insertions";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string";
const isCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isList = (value, holds) => Array.isArray(value) && value.every(holds);
const keysAre = (value, names) => Object.keys(value).sort().join(",") === names;

// The verdict, the checks that ran and the commands configured tell one story, or no run of the gate wrote this.
function agrees(run) {
  const codes = run.checks.map((check) => check.exit_code);
  const all = [...run.commands, ...(run.slow || [])];
  if (codes.length > all.length) return false;
  if ((run.verdict === "passed" || run.verdict === "no_checks") !== (run.reason === null)) return false;
  if (run.diff.files_changed !== run.diff.files.length) return false;
  if (run.diff.files.length === 0 && run.diff.insertions + run.diff.deletions !== 0) return false;
  if (new Set(run.diff.files).size !== run.diff.files.length) return false;
  const earlierPassed = codes.slice(0, -1).every((code) => code === 0);
  // A stop runs the commands; /krites:verify runs them and then slow.
  const whole = codes.length === run.commands.length || codes.length === all.length;
  if (run.verdict === "passed") return codes.length > 0 && whole && codes.every((code) => code === 0);
  if (run.verdict === "no_checks") return run.commands.length === 0 && codes.length === 0;
  if (run.verdict === "timed_out") return codes[codes.length - 1] === null && earlierPassed;
  if (codes.length === 0) return isText(run.reason);
  return earlierPassed && codes[codes.length - 1] !== 0;
}

const wellFormed = (check) =>
  isObject(check) && keysAre(check, CHECK_KEYS) && isText(check.command) && isText(check.tail) && isCount(check.duration_ms) &&
  (check.exit_code === null || Number.isInteger(check.exit_code));

// Only the run the gate wrote is signed: the file sits in the repo, where an agent with a shell reaches it.
function gateWrote(run) {
  if (run.schema !== RUN_SCHEMA || !VERDICTS.includes(run.verdict)) return false;
  if (!["plugin_version", "created_at", "root_hash", "head", "fingerprint"].every((key) => isText(run[key]))) return false;
  if (!CREATED_AT.test(run.created_at) || !HEAD.test(run.head) || typeof run.dirty !== "boolean") return false;
  if (run.config_hash !== undefined && !isText(run.config_hash)) return false;
  if (![run.reason, run.session_id].every((value) => value === null || isText(value))) return false;
  if (!isList(run.commands, (argv) => isList(argv, isText))) return false;
  if (run.slow !== undefined && !isList(run.slow, (argv) => isList(argv, isText))) return false;
  if (run.env !== undefined && !isList(run.env, isText)) return false;
  const diff = run.diff;
  if (!isObject(diff) || !keysAre(diff, DIFF_KEYS)) return false;
  if (![diff.files_changed, diff.insertions, diff.deletions].every((count) => isCount(count) && Number.isInteger(count)) || !isList(diff.files, isText)) return false;
  if (!isList(run.checks, wellFormed)) return false;
  return agrees(run);
}

function clean(value, root) {
  if (typeof value === "string") return scrub(value, root);
  if (Array.isArray(value)) return value.map((item) => clean(item, root));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item, root)]));
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  return null;
}

function build(root) {
  let run;
  try {
    run = JSON.parse(fs.readFileSync(path.join(root, LAST_RUN), "utf8"));
  } catch {
    return { ok: false, reason: NOTHING };
  }
  if (!isObject(run)) return { ok: false, reason: NOTHING };
  if (!gateWrote(run)) return { ok: false, reason: FORGED };
  if (run.fingerprint !== state.fingerprint(root)) return { ok: false, reason: STALE };
  const off = settings.hooksOff(root);
  if (off !== null && off.definite) return { ok: false, reason: settings.describe(off) };

  const slow = run.slow || [];
  // Checks run in order and stop at the first failure, so what did not run is everything after the last one recorded.
  const notRun = [...run.commands, ...slow].slice(run.checks.length).map((argv) => argv.join(" "));
  // Scrubbed before it is signed, so the bytes on disk are the bytes the signature covers.
  const body = clean(
    {
      schema: SCHEMA,
      plugin_version: run.plugin_version,
      created_at: run.created_at,
      repo: { root_hash: run.root_hash, head: run.head, dirty: run.dirty },
      diff: run.diff,
      checks: run.checks,
      verdict: run.verdict,
      reason: run.reason,
      config_hash: run.config_hash,
      commands: run.commands,
      slow,
      not_run: notRun,
      env: run.env || [],
      tree_fingerprint: run.fingerprint,
      session_id: run.session_id,
    },
    root,
  );
  return { ok: true, receipt: { ...body, signature: sign(body) } };
}

// A one-line code span whose fence outruns every backtick run inside, so run content cannot close it.
function code(text) {
  // eslint-disable-next-line no-control-regex
  const flat = String(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ") || " ";
  const fence = "`".repeat(Math.max(0, ...(flat.match(/`+/g) || []).map((run) => run.length)) + 1);
  const pad = /^`|`$/.test(flat) ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}
const cell = (text) => code(text).replace(/\|/g, "\\|");

function markdown(receipt) {
  const diff = receipt.diff || { files_changed: 0, insertions: 0, deletions: 0 };
  const rows = [
    ...(receipt.checks || []).map((check) => `| ${cell(check.command)} | ${check.exit_code} | ${check.duration_ms} |`),
    ...(receipt.not_run || []).map((command) => `| ${cell(command)} | not run | |`),
  ];
  const env = receipt.env || [];
  return `${[
    "# Krites receipt",
    "",
    `Verdict: ${receipt.verdict}`,
    `Reason: ${receipt.reason === null ? "none" : code(receipt.reason.split("\n")[0])}`,
    "",
    "| Check | Exit code | Duration (ms) |",
    "| --- | --- | --- |",
    ...(rows.length > 0 ? rows : ["| none ran | | |"]),
    "",
    `Diff: ${diff.files_changed} changed, +${diff.insertions} -${diff.deletions}`,
    `Head: ${receipt.repo.head || "none"}`,
    `Config hash: ${code(receipt.config_hash)}`,
    ...(env.length > 0 ? env.map((entry) => `Env: ${code(entry)}`) : ["Env: none"]),
    "",
    `Signed by ${fingerprintOf(receipt.signature.public_key)}`,
  ].join("\n")}\n`;
}

// The stem comes out of the file the gate wrote, so it is held to one path segment of plain characters.
const stemPart = (value) => String(value).replace(/:/g, "-").replace(/[^0-9A-Za-z._-]/g, "");
const stemOf = (createdAt, head) => `${stemPart(createdAt)}-${stemPart(head).slice(0, 8) || "nohead"}`;
const relative = (dir, name) => `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/${name}`;

// Writing the first receipt makes the tree dirty, so a second build() would refuse: the stem comes from the run instead.
function existing(root, dir) {
  let run;
  try {
    run = JSON.parse(fs.readFileSync(path.join(root, LAST_RUN), "utf8"));
  } catch {
    return null;
  }
  if (run === null || typeof run !== "object" || Array.isArray(run)) return null;
  const rel = relative(dir, `${stemOf(run.created_at, run.head)}.json`);
  return fs.existsSync(path.join(root, rel)) ? rel : null;
}

function atomic(file, text) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function write(root, receipt, dir) {
  const stem = stemOf(receipt.created_at, receipt.repo.head);
  const target = path.join(root, dir);
  fs.mkdirSync(target, { recursive: true });
  atomic(path.join(target, `${stem}.json`), canonical(receipt));
  atomic(path.join(target, `${stem}.md`), markdown(receipt));
  return { json: relative(dir, `${stem}.json`), md: relative(dir, `${stem}.md`) };
}

module.exports = { build, existing, wellFormed, write };
