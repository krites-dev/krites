const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const { configDir } = require("./sign.js");

// Empty ships the plugin with telemetry off altogether: no question, no state file, nothing sent.
const ENDPOINT = "";
const VERSION = require("../.claude-plugin/plugin.json").version;
const CAP_MS = 2000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FILE = "telemetry.json";

const OFFLINE = "Telemetry is not available in this build: no endpoint is configured.";
const ON = "Telemetry is on: an anonymous ping goes out now and once a week. Run /krites:telemetry off to stop it.";
const OFF = "Telemetry is off. Nothing is sent. Run /krites:telemetry on to allow it.";
const QUESTION = [
  "Krites can send an anonymous ping: an install id, the plugin version, the operating system and a timestamp, now and once a week.",
  "Nothing else is ever sent, and nothing is sent until you answer. Run /krites:telemetry on to allow it, or /krites:telemetry off to decline.",
].join("\n");

const endpointOf = () => process.env.KRITES_PING_ENDPOINT || ENDPOINT;

// A file that does not parse reads as no consent, so a damaged state never sends and is left where it is.
function state() {
  let raw = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir(), FILE), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = {};
  }
  return {
    install_id: typeof raw.install_id === "string" ? raw.install_id : null,
    consent: raw.consent === "granted" || raw.consent === "declined" ? raw.consent : null,
    last_attempt_at: typeof raw.last_attempt_at === "string" ? raw.last_attempt_at : null,
  };
}

function save(next) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(temp, path.join(dir, FILE));
}

function post(endpoint, payload, capMs) {
  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const body = Buffer.from(JSON.stringify(payload));
    // The global agent pools keep-alive sockets, which would hold a hook open after its answer.
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      agent: false,
      headers: { "content-type": "application/json", "content-length": body.length },
    });
    const finish = () => {
      clearTimeout(timer);
      request.destroy();
      resolve();
    };
    const timer = setTimeout(finish, capMs);
    request.on("error", finish);
    request.on("response", (response) => response.resume().on("end", finish));
    request.end(body);
  });
}

const due = (current, now) => {
  if (current.consent !== "granted") return false;
  const last = Date.parse(current.last_attempt_at);
  return Number.isNaN(last) || now - last >= WEEK_MS;
};

async function send({ endpoint = endpointOf(), now = Date.now(), capMs = CAP_MS } = {}) {
  try {
    if (endpoint === "") return;
    const current = state();
    if (!due(current, now)) return;
    const ts = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
    const install_id = current.install_id || crypto.randomUUID();
    // Stamped before the request leaves, so a dead endpoint costs one attempt a week and not one per stop.
    save({ install_id, consent: "granted", last_attempt_at: ts });
    await post(endpoint, { install_id, version: VERSION, os: process.platform, ts }, capMs);
  } catch {
    return;
  }
}

const question = () => (endpointOf() !== "" && state().consent === null ? QUESTION : null);

function telemetry(answer) {
  if (endpointOf() === "") return OFFLINE;
  if (answer === "on" || answer === "off") {
    const current = state();
    save({ ...current, install_id: current.install_id || crypto.randomUUID(), consent: answer === "on" ? "granted" : "declined" });
  }
  const { consent } = state();
  if (consent === "granted") return ON;
  return consent === "declined" ? OFF : QUESTION;
}

module.exports = { CAP_MS, ENDPOINT, OFFLINE, QUESTION, endpointOf, question, send, state, telemetry };
