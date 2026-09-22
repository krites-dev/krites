Requires Node 20 or later.

# Krites

Krites runs your coding agent's work through checks the agent cannot touch and writes a signed receipt of what ran. It is a Claude Code plugin: every check is a command from your own repo and its exit code, run by the plugin's process, never narrated by the model. Pronounced KRY-tees.

## Install

```text
/plugin marketplace add krites-dev/krites
/plugin install krites@krites
```

- `/krites:init` shows the `krites.toml` it would write for this repo and the Node version it found. `/krites:init --write` creates it, or approves a `krites.toml` you edited yourself.
- `/krites:verify` runs the configured checks now and prints their raw output, nothing else. Its command file and `/krites:init`'s ask Claude to show the output as one code block, because Claude Code renders a reply as markdown and a glob's `**` or a line starting with `>` would otherwise not look like what was printed.
- `/krites:receipt` writes the last run as a signed JSON file and a Markdown rendering under `receipts/`.
- `/krites:telemetry on|off` answers the weekly ping question (see Telemetry).

Commit `krites.toml`. Until a repo has one, the plugin checks nothing there and says so once at session start.

## What it does

- Denies the edit tools on the paths in `[protect]`, on `krites.toml`, `.krites/` and `.git/`, and on anything outside the repo except this project's Claude Code memory folder in its default place, the `memory/` beside the session transcript Claude Code names in every hook call, so Claude can still save memory there. A memory folder that is a link, or that lives inside a repo, gets no exception.
- Runs `[checks].commands` in order when the agent tries to stop and blocks the stop on the first failure, with the command and the last 60 lines of its output as the reason.
- Exports a signed receipt of the last run.

A run ends in one of four verdicts: `passed` (every check exited 0), `refuted` (a check failed, or a protected path changed by any tool, Bash included), `timed_out` (the run passed `timeout_seconds` and its process tree was killed), `no_checks` (no command is configured: the stop goes through, the receipt says `no_checks`, never `passed`, and the session start line tells you nothing is being checked). Krites never says `verified` in v0: the checks are yours, and nothing here vouches for them.

The gate runs on every stop attempt. A failing check, a timeout or a changed protected path blocks at most `max_blocks` times in a row (default 3, 1 to 8); after that the stop is allowed, the run is recorded with the reason "attempt budget exhausted", and the next session start says so. The count resets when a gate passes, when a stop finds a clean tree at the session baseline, and when a session starts. A `krites.toml` that cannot be read, or a repo in which git cannot list what changed, is not counted: it blocks every stop until it is fixed.

## What a receipt proves

Reproduced by hand against the real hooks on 2026-09-18, Windows, after the core's review fixes:

| Step | Result |
| --- | --- |
| Session start on an honest config with a failing check | silent |
| Stop | refuted: `node fail.js` |
| Config weakened by a direct file write, then stop | refuted: `protected path changed: krites.toml. If you changed it yourself, run /krites:init to approve it.` |
| `.krites/` deleted, then stop (the hole the reviewer found) | refuted, same reason |
| `krites.toml` deleted too, then stop | blocked: `krites.toml is tracked but missing from the tree` |

In the last row the file was tracked, so even that case was caught. The README limit applies only when the file was never committed.

A receipt proves which commands ran, with which exit codes, on which diff at which commit, under which `krites.toml` (`config_hash`, and `commands` lists every configured check, including ones that never ran because an earlier one failed). It does not prove the tests are good. A signature proves the receipt was not altered after signing; it proves who signed only if you pin the key with `--key`, because anyone can make a key and sign a receipt they wrote by hand, and the verifier says "signer not pinned" when you do not.

A receipt is evidence from a machine you trust, not proof against the agent that ran on it. What gets signed is `.krites/last-run.json`, and the key sits in your user config directory: an agent with a shell can rewrite the first before you export, or read the second and sign on its own. `/krites:receipt` refuses a run file the gate could not have written (an unknown verdict, exit codes that contradict the verdict), and refuses when the tree changed since the run, but a carefully forged run file passes. Export receipts from a session you watched, or from CI.

## What it does not do

No model calls, no `verified` verdict in v0, no routing between agents. The router, the cross-agent budget and the ledger are the paid tier: https://krites.dev

## Known limits

The gate

- Bash, and any subprocess, can write anywhere; the protect hook covers the edit tools only. A protected path changed that way is caught at the next stop, not prevented. MCP tools that write files are outside the hook's matcher.
- With no Node on the PATH the hooks cannot start, and Claude Code lets a hook that fails to start, or that outlives its timeout, through. Every Krites hook carries its own deadline below Claude Code's for that reason.
- The agent can edit what your checks read, such as `scripts.test` in `package.json` or a lint config. Protect those paths in `[protect]` if that matters to you.
- A `krites.toml` edited through Bash is refuted for the rest of that session and accepted at the next session start. The `config_hash` and `commands` in a receipt are how a reader sees which checks a run really covered.
- `.krites/` and `.git/` are not in any diff, so tampering there through Bash is invisible: a missing or damaged baseline narrows the changed-path check to the diff against HEAD, and a block counter written by hand ends the blocking early (the run is still recorded as refuted, with the exhausted reason, and reported at the next session start). Files hidden with `.gitignore`, `assume-unchanged` or `skip-worktree` are invisible to the changed-path check too.
- Deleting both `krites.toml` and `.krites/` through Bash makes the plugin inert, when `krites.toml` was never committed. Commit it.
- A `krites.toml` that was never committed does not exist in a `claude -w` worktree session, so that session is inert apart from the session start line.
- A commit made after the last gate of a session that was killed rather than stopped is not gated in the next session. A commit made on another branch and reached by checking back out is never gated. Work moved out of the tree before a stop (a stash, another branch) makes that stop a clean one: it resets the attempt count, and the next session start no longer reports attempts that gave up, though `last-run.json` still holds the exhausted run. A resumed or compacted session keeps its baseline and its block count.
- The attempt budget is per `krites.toml`. Claude Code itself honors eight Stop blocks in a row and lets the ninth stop through, so several failing roots in one session can ask for more blocks than it grants; the last run then says refuted without the exhausted reason. After the watchdog or a crash, roots behind the interrupted one are not judged in that stop. A root whose `krites.toml` cannot be read, or whose changes git cannot list, blocks every stop until that is fixed, but it does not hold up the others: the roots behind it are still judged and recorded, and the block carries its reason along with the first failing root's. If `.krites/block-count` cannot be written, the gate keeps blocking and the reason names the file and the error code: a gate that cannot record does not let go silently. In these cases what ends the chain is Claude Code letting the ninth stop through, and no gave-up run is recorded for that root.
- Killing a timed-out check takes its process tree with it, except descendants that detached themselves; under a PID 1 that does not reap, killed processes can linger as zombies.
- Files over 5 MB, or past 64 MB in one pass, are fingerprinted by size and modification time, so a same-size in-place edit there during a run is not seen.

`/krites:verify`

- It runs through Claude Code's Bash tool, which delivers at most 600 s, and only when the model passes the timeout the command asks for. Under `/krites:verify` the checks of all roots together are cut off at 540 s; the stop gate allows up to `timeout_seconds` (at most 820). Long suites belong to the gate.

Receipts and keys

- The signing key lives in your user config directory (`%APPDATA%\krites`, or `$XDG_CONFIG_HOME/krites`, or `~/.config/krites`), never in the repo. An agent running as you can read it.
- `root_hash` is the hash of the repo's path; a short, guessable path can be recovered from it.
- Asking for a receipt twice for one run points at the file already written. After the tree changed, run `/krites:verify` first.

Stopping

- To stop gating a repo, delete `.krites/` and remove `krites.toml`. If a stop is blocked with "krites.toml is missing from a repo that Krites gated before", for instance after checking out a branch that predates `krites.toml`, either restore the file or delete `.krites/`.

## Verify a receipt

```text
node verify-receipt.js --key <fingerprint> <receipt.json>
```

`verify-receipt.js` is one file with no dependencies. It prints `valid: signed by <fingerprint>, verdict <verdict>` or `invalid: <why>`, and exits 0 or 1. Without `--key` the valid line ends with `signer not pinned (pass --key)`, and means only that the file is intact: a signature can be made for any receipt by anyone, and for some degenerate public keys without a private key at all. It checks that the file's bytes are the canonical form of the receipt, that the key and signature are canonical base64, that the signature matches, and, with `--key`, that the signer is the one you expect (the full fingerprint or at least its first 16 characters). The fingerprint is in the footer of the Markdown rendering.

## License and telemetry

Apache-2.0.

Telemetry is off until you are asked and say yes. `/krites:init`, `/krites:verify` and `/krites:receipt` end with the question until you answer it: may Krites send a ping to krites.dev, now and once a week, `{ "install_id": "<random uuid>", "version": "<plugin version>", "os": "win32|darwin|linux", "ts": "<time>" }`, and nothing else. The install id is random but stays the same from one ping to the next, so the ping is pseudonymous, not anonymous. Pings go to https://krites.dev/ping, a Cloudflare Worker run by Krites, which stores the install id, version, OS and timestamp and the day the ping was received, and does not store your IP address or any request header. Pings are kept for 12 months. The `KRITES_PING_ENDPOINT` environment variable wins over the built-in endpoint, and `KRITES_PING_ENDPOINT=off` (any case) switches telemetry off altogether; an empty value uses the built-in endpoint: nothing is asked and nothing is sent. After a yes, the ping leaves at most once a week, from the first allowed stop or Krites command of that week, in whichever repo that happens, with or without a `krites.toml`. It never leaves from a blocked or timed-out stop and never changes a verdict. `/krites:telemetry off` is permanent until you run `/krites:telemetry on`. The answer is stored next to the signing key, never in a repo.
