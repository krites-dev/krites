<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.png">
  <img alt="Krites: Don't ask your agent to run the tests. Force it." src=".github/assets/banner-dark.png" width="100%">
</picture>

# Krites

**Don't ask your agent to run the tests. Force it.**

Krites runs your checks itself and blocks the stop until they pass. It is a Claude Code plugin: every check is a command from your own repo and its exit code, run by the plugin's process, never narrated by the model. Open source, no account, verifies offline. Pronounced KRY-tees.

```sh
claude plugin install krites@anthropic-plugin-directory
```

Requires Claude Code and Node 20 or later. This installs from Anthropic's plugin directory, which Claude Code includes as the built-in marketplace `anthropic-plugin-directory`; inside a session, `/plugin install krites@anthropic-plugin-directory` does the same. To install from this repo instead: `claude plugin marketplace add krites-dev/krites`, then `claude plugin install krites@krites`.

- `/krites:init` shows the `krites.toml` it would write for this repo and the Node version it found. `/krites:init-write` creates it, or approves a `krites.toml` you edited yourself.
- `/krites:approve` shows the protected paths that commits changed since the session baseline, with those commits and their diff, and `/krites:approve-write` approves those changes up to the HEAD it showed.
- `/krites:verify` runs the configured checks now and prints their raw output, nothing else.
- `/krites:receipt` writes the last run as a signed JSON file and a Markdown rendering under `receipts/`.
- `/krites:telemetry-on` and `/krites:telemetry-off` answer the weekly ping question, and `/krites:telemetry` shows the answer (see [License and telemetry](#license-and-telemetry)).

Commit `krites.toml`. Until a repo has one, the plugin checks nothing there and says so once at session start.

## What happens in a session

A recording of the real hooks on a copy of the plugin's Rust test fixture, with `tests/**` protected and `cargo fmt --check` and `cargo test` as the checks. The `agent` lines are the tool calls and stops sent to the hooks; `src/lib.rs` was broken on purpose, then fixed. Every `krites` line is the text Claude Code hands the agent, word for word, and an empty one means the hook said nothing and the stop went through; `...` marks trimmed lines. The receipt was signed with a throwaway key; the published sample is under [Receipts](#receipts).

```text
agent   Edit tests/total.rs
krites  Blocked: tests/total.rs is protected. Protected paths are human-edited only.

agent   (breaks src/lib.rs, then stops)
krites  Krites refuted the stop: cargo test
        ...
        test total_sums_the_values ... FAILED
        ...
        assertion `left == right` failed
          left: 5
         right: 7
        ...
        test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
        ...
        Fix it and let the checks run before stopping. Do not describe results; the gate reads them.

agent   (fixes src/lib.rs, then stops)
krites

> /krites:receipt
krites  receipts/2026-09-25T16-11-37Z-382ebfd1.json
        receipts/2026-09-25T16-11-37Z-382ebfd1.md
```

<a href=".github/assets/chip.gif"><img alt="A circuit chip grows one crystal per check. The last check fails red and shrinks, then regrows green, while the chip turns slowly." src=".github/assets/chip.gif" width="440"></a>

Adapted from the site's How it works animation: one crystal per check in the sample receipt, with a scripted failure on the last check before it passes.

## How it works

- **Protect.** The edit tools are denied on paths you name in `krites.toml`, on `krites.toml` itself, and outside the repo, before the write lands.
- **Gate.** When the agent tries to stop, Krites runs your checks itself. The first failure blocks it and hands back the command and its last 60 lines.
- **Receipt.** `/krites:receipt` signs the last run: commands, exit codes, diff and commit. Anyone can verify it offline with `verify-receipt.js`.

A run ends in one of four verdicts: `passed` (every check exited 0), `refuted` (a check failed, or a protected path changed by any tool, Bash included), `timed_out` (the run passed `timeout_seconds` and its process tree was killed), or `no_checks` (no command is configured: the stop goes through, and the receipt says `no_checks`, never `passed`). Krites never says `verified`: the checks are yours, and nothing here vouches for them.

The changed-path check compares against the session baseline, so a protected change refutes every stop of the session, even one a person made. The reason tells the agent to undo its own change and leave a person's to a commit and `/krites:approve`. That lists every protected path that differs between the baseline and HEAD, protected under the working `krites.toml`, the baseline's or HEAD's so a narrowed one hides nothing, then the commits in between that changed them, then the diff for those paths, read with `git --no-replace-objects` and no external diff or textconv driver. Control characters print as `\xNN` and format and separator characters as `\u{N}`; at most 200 lines are shown, and a cut names the full command, with commit ids and no path: `git --no-replace-objects --literal-pathspecs diff --no-ext-diff --no-textconv --text <baseline> <HEAD>`. When HEAD does not descend from the baseline the heading says the paths differ between the two, and the commit list can be empty, which it says. Protected paths where the working tree differs from HEAD are listed as not committed, so not approvable; a change staged and then reverted on disk is not listed, because the gate does not see it either. `/krites:approve-write` refuses if HEAD or the baseline moved after they were shown, lists the commits and the paths again, and records the approval. From then on a protected path refutes only when it differs from both the baseline and the approved commit, so a later change still refutes and a revert to the baseline does not. What is excused is the approved commit's content: the same content stays excused even if it later stops being committed (`git reset --soft`). The baseline does not move: the next stop still runs the checks on everything since the baseline, and only a pass or a new session moves it, which ends the approval (a `/clear` keeps both); `/krites:init-write` ends it too, since a changed `krites.toml` can protect a path the approval never showed. Both commands end with the consent question until it is answered.

The gate runs on every stop attempt. A failing check, a timeout or a changed protected path blocks at most `max_blocks` times in a row (default 3, 1 to 8); after that the stop is allowed, the run is recorded with the reason "attempt budget exhausted", and the next session start says so. Session start means a fresh startup: a resumed or compacted session keeps its baseline and its block count, and a `/clear` keeps the baseline but reports a chain that gave up and starts the count over, since the turn before it may have been interrupted with no stop. The count resets when a gate passes, when a stop finds a clean tree at the session baseline, when a new session starts, and at a `/clear`. A `krites.toml` that cannot be read, or a repo in which git cannot list what changed, blocks every stop until it is fixed.

## Receipts

[A real receipt](examples/receipts/2026-09-25T17-42-54Z-4a10c564.md) ([JSON](examples/receipts/2026-09-25T17-42-54Z-4a10c564.json)), the one krites.dev shows. Verify it from the root of this repo:

```sh
node verify-receipt.js --key 6b11164d362ea9b5 examples/receipts/2026-09-25T17-42-54Z-4a10c564.json
```

It prints `valid: signed by <fingerprint>, verdict <verdict>` or `invalid: <why>`, and exits 0 or 1. `verify-receipt.js` is one file with no dependencies. It checks that the file's bytes are the canonical form of the receipt, that the key and signature are canonical base64, that the signature matches, and, with `--key`, that the signer is the one you expect (the full fingerprint or at least its first 16 characters). The fingerprint is in the footer of the Markdown rendering.

A receipt proves which commands ran, with which exit codes, on which diff, at which commit, under which `krites.toml` (`config_hash`). It does not prove your tests are good; it proves they ran.

- A signature proves the receipt was not altered after signing. It proves who signed only if you pin the key with `--key`: anyone can make a key and sign a receipt they wrote by hand, and without `--key` the valid line ends with `signer not pinned (pass --key)`.
- A receipt is evidence from a machine you trust, not proof against the agent that ran on it. What gets signed is `.krites/last-run.json`, and the key sits in your user config directory (`%APPDATA%\krites`, or `$XDG_CONFIG_HOME/krites`, or `~/.config/krites`), never in the repo: an agent with a shell can rewrite the first before you export, or read the second and sign on its own. `/krites:receipt` refuses a run file the gate could not have written and refuses when the tree changed since the run, but a carefully forged run file passes, and one can also be carried into the next passing stop. Export receipts from a session you watched, or from CI.
- `commands` and `slow` list every configured check, `not_run` names each one that did not run, and `env` holds the `[checks.env]` assignments, scrubbed. `root_hash` is the hash of the repo's path, so a short, guessable path can be recovered from it.
- Asking for a receipt twice for one run points at the file already written. After the tree changed, run `/krites:verify` first.

## Configuration

`/krites:init` proposes a `krites.toml` for the repo it finds. A minimal one:

```toml
version = 1

[checks]
commands = [
  "cargo fmt --check",
  "cargo test",
]
timeout_seconds = 300

[protect]
globs = ["tests/**"]
```

- `[checks].commands` run in order at every stop; the first failure blocks it. `max_blocks` sets the attempt budget.
- `[checks].slow` runs only under `/krites:verify`, after `commands` and only when every one of them passed. A stop never starts a slow check; its receipt lists them as not run, unless its own commands all passed and the latest recorded run is a passed `/krites:verify` on the same tree and config with every slow check at exit 0, whose slow results it then carries.
- A check runs without a shell, so `GOTOOLCHAIN=go1.26.6 make vulncheck` sets nothing. Put the variable in `[checks.env]` (`GOTOOLCHAIN = "go1.26.6"`), and every check gets it, at a stop and under `/krites:verify`. Names are letters, digits and `_`, not starting with a digit, and two names may not differ only in case. Values are used as written, with no `$VAR` expansion, and may not hold a control character, `"`, `&`, `|`, `<`, `>`, `^`, `%` or `!`.
- `[protect].globs` adds to what is always protected: `krites.toml`, `.krites/`, `.git/`, and anything outside the repo except this project's Claude Code memory folder in its default place. A memory folder that is a link, or that sits inside a repo, gets no exception.
- A folder inside the session's repo with a `krites.toml` of its own, such as a nested repo or a git worktree, keeps its own protected paths: from a session in the outer repo, an edit there is checked against the outer repo's globs and then each such folder's, each on the path relative to its own folder. A session started inside such a folder takes it as the outer repo: the repos around it do not apply. A nested `krites.toml` that does not load, or a nested `.krites/session-head` with no `krites.toml`, blocks every edit below it until it is fixed from a session started there. Nested folders are found by their files alone, so a nested repo whose committed `krites.toml` is missing from its tree is not one, and a target opened by `allow_outside` is held to no nested folder's globs.
- A change to `krites.toml` changes its `config_hash` and needs `/krites:init-write` to approve it, or, once committed, `/krites:approve-write` while the file matches the commit.

To open folders outside the repo to the edit tools, such as a scratchpad, list them in `config.toml` in your Krites config directory, not in the repo, so a repo you clone cannot decide where in your home folder the agent may write:

```toml
[protect]
allow_outside = ["~/.claude-work/**"]
```

Each entry is a glob that starts with `~/`, `/`, or a drive letter such as `C:/`, matched against the target's real path after links are followed; the entry itself is not resolved, so name the real folder (on macOS, `/private/tmp`, not `/tmp`). A relative entry is an error that denies every edit outside the repo until it is fixed. An entry naming a network share matches nothing. Matching ignores case on Windows and macOS, and `**` matches what is under a folder, not the folder itself. The Krites config directory, `~/.claude`, `~/.claude*.json` and a non-empty `$CLAUDE_CONFIG_DIR` stay closed whatever the list says. A broad entry such as `~/**` still opens shell startup files, which can set `CLAUDE_CONFIG_DIR` or move the Krites config directory for the next session, so keep entries to the folders your workflow writes.

Claude Code can tell a session to keep temporary files in a scratchpad outside the repo, which the protect hook denies like any outside path. On Windows it has been seen at `C:\Users\<you>\AppData\Local\Temp\claude\<project>\<session id>\scratchpad`; Claude Code does not document the place, so check the path your own session names. For that place, this entry opens the scratchpad folders and nothing beside or above them, for every session at once, so one session's edit tools can also write another's:

```toml
[protect]
allow_outside = ["~/AppData/Local/Temp/claude/*/*/scratchpad/**"]
```

If your session names another path, for example because `TEMP` points elsewhere, write the entry for that path instead.

To stop gating a repo, delete `.krites/` and remove `krites.toml`. If a stop is blocked with "krites.toml is missing from a repo that Krites gated before", for instance after checking out a branch that predates it, restore the file or delete `.krites/`.

## Pinning a release

An install from this repo follows its default branch; Claude Code leaves auto-update off for a third-party marketplace by default, so nothing changes until you update it. Every release is tagged `krites--v<version>`, the version in `.claude-plugin/plugin.json`. The release script never moves a pushed tag, but a tag can be moved by hand on GitHub, so pin the commit too when that matters. If you installed from the directory, run `claude plugin uninstall krites@anthropic-plugin-directory` first, so only one copy runs.

```text
/plugin marketplace add https://github.com/krites-dev/krites.git#krites--v<version>
/plugin install krites@krites
```

A team marketplace can pin the commit with an entry in the `plugins` array of its `marketplace.json`; a `github` source takes `ref` and `sha`, and when both are set the `sha` is the effective pin.

```json
{
  "name": "krites",
  "source": { "source": "github", "repo": "krites-dev/krites", "ref": "krites--v<version>", "sha": "<the tagged commit, 40 hex characters>" }
}
```

The tags are annotated, so the commit is the `^{}` line of `git ls-remote https://github.com/krites-dev/krites.git "refs/tags/krites--v<version>*"`.

To vendor it instead: `git clone --depth 1 --branch krites--v<version> https://github.com/krites-dev/krites.git vendor/krites`, review it, delete `vendor/krites/.git`, commit it, and add it with `/plugin marketplace add ./vendor/krites`.

Sources: [Discover and install plugins](https://code.claude.com/docs/en/discover-plugins) and [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).

## Known limits

- The protect hook covers the edit tools only. Bash, any subprocess, and MCP tools that write files can write anywhere; a protected path changed that way is caught at the next stop, not prevented.
- A nested repo or worktree inside the project root, with its own `krites.toml`, is judged at every later stop of a session, whatever the cwd, once an edit tool wrote in it. Work there through Bash alone is not seen by the protect hook, so it is judged only from a cwd inside it. Every root of a stop shares the one 820 s budget, judged in order, so several such roots with long checks can time the last one out. `/krites:verify` and `/krites:approve` reach the cwd and project roots only, so a protected change a person commits in a nested root keeps refuting the outer session's stops; a session started in that root begins from its HEAD, which clears it. A nested root recorded with no HEAD, and with no baseline of its own, is judged as a root the session never saw, and a recorded HEAD that no longer exists there (history rewritten and pruned) leaves its changed-path check against HEAD. A record made while a stop trims a `.krites/touched` past 4096 lines can be lost, and a trim past 4096 lines drops other sessions' oldest lines, so a long-lived session (a resumed one) can lose its line for a nested root, which its next edit there records again. An edit in a repo outside the project root (an added directory) is recorded there and judged only from a stop whose cwd is inside that repo. When no krites root holding `CLAUDE_PROJECT_DIR` holds the nested root (or the variable is unset), the record goes to the outermost session root holding the edit, so a later edit from a cwd in a root between the two can record a later HEAD there, and which HEAD the gate takes depends on which root it reads first.
- With no Node on the PATH the hooks cannot start, and Claude Code lets a hook that fails to start, or that outlives its timeout, through.
- The agent can edit what your checks read, such as `scripts.test` in `package.json` or a lint config. Protect those paths if that matters to you.
- A `krites.toml` edited through Bash is refuted for the rest of that session and accepted at the next fresh session start. A receipt's `config_hash` and `commands` show which checks a run really covered.
- `.krites/` and `.git/` are not in any diff, so tampering there through Bash is invisible, and so are files hidden with `.gitignore`, a global exclude (`core.excludesFile`), `assume-unchanged` or `skip-worktree`. Ignored files stay out on purpose: Claude Code itself writes `.claude/settings.local.json` on every standing permission approval ([settings](https://code.claude.com/docs/en/settings)), so judging it would refute the stop after the person's own click. `cli.js approve` run through Bash, or a hand-written `.krites/approve-pending`, arms `/krites:approve-write`, which lists the commits and paths again before it records anything; `cli.js approve --write` run through Bash, or a hand-written `.krites/approved-head`, approves as a person would, and as invisibly as any `.krites/` write. A missing or damaged baseline narrows the changed-path check to the diff against HEAD, and a block counter written by hand ends the blocking early.
- What `/krites:approve` shows reaches you through the model's reply, as `/krites:init`'s does, and a scrubbed line hides text, so run `git --no-replace-objects --literal-pathspecs diff --no-ext-diff --no-textconv --text` between the baseline and HEAD yourself when in doubt.
- A `krites.toml` that was never committed can be deleted along with `.krites/` to make the plugin inert, and does not exist in a `claude -w` worktree session. Commit it.
- A commit made after the last gate of a session that was killed rather than stopped is not gated in the next session, and neither is one made on another branch and reached by checking back out. Work moved out of the tree before a stop (a stash, another branch) makes that stop a clean one: it resets the attempt count, and the next session start no longer reports attempts that gave up.
- The attempt budget is per `krites.toml`. Claude Code honors eight Stop blocks in a row and lets the ninth through, so several failing roots in one session can ask for more blocks than it grants; the last run then says refuted without the exhausted reason. After the watchdog or a crash, roots behind the interrupted one are not judged in that stop.
- If `.krites/block-count` cannot be written, the gate keeps blocking and the reason names the file and the error code. There, and for a `krites.toml` that cannot be read, what ends the chain is Claude Code letting the ninth stop through, and no gave-up run is recorded.
- `/krites:verify` runs through Claude Code's Bash tool, which delivers at most 600 s, and only when the model passes the 600000 ms timeout the command asks for. Its checks, for all roots together, are cut off at 540 s, and a `slow` check shares that budget with `commands` and the roots before it; one still running when it is spent is killed and recorded as timed out; the stop gate allows up to `timeout_seconds` (at most 820). Suites longer than that belong in CI.
- Killing a timed-out check takes its process tree with it, except descendants that detached themselves; under a PID 1 that does not reap, killed processes can linger as zombies.
- Files over 5 MB, or past 64 MB in one pass, are fingerprinted by size and modification time, so a same-size in-place edit there during a run is not seen.
- `/krites:verify` names a settings file that turns Krites' hooks off, and `/krites:receipt` refuses while one definitely does. Both read the settings files only (user, project, local, and the managed file with its `managed-settings.d` drop-ins), not managed settings from the Windows registry, a macOS plist or the server, or a `--settings` file.

Krites makes no model calls and does no routing between agents. Pro is in development: the switcher, and the observatory, which shows first-try pass rate and cost per verified pass for each agent and model, measured on your own runs. See https://krites.dev.

## License and telemetry

Apache-2.0.

Telemetry is off until you are asked and say yes. `/krites:init`, `/krites:approve`, `/krites:approve-write`, `/krites:verify` and `/krites:receipt` end with the question until you answer it: may Krites send a ping to krites.dev, now and once a week, `{ "install_id": "<random uuid>", "version": "<plugin version>", "os": "win32|darwin|linux", "ts": "<time>" }`, and nothing else. The install id is random but stays the same from one ping to the next, so the ping is pseudonymous, not anonymous. Pings go to https://krites.dev/ping, a Cloudflare Worker run by Krites, which stores the install id, version, OS and timestamp and the day the ping was received, and does not store your IP address or any request header. Pings are kept for 12 months. The `KRITES_PING_ENDPOINT` environment variable wins over the built-in endpoint, and `KRITES_PING_ENDPOINT=off` (any case) switches telemetry off altogether: nothing is asked and nothing is sent. An empty value uses the built-in endpoint. After a yes, the ping leaves at most once a week, from the first allowed stop or Krites command of that week, in whichever repo that happens, with or without a `krites.toml`. It never leaves from a blocked or timed-out stop and never changes a verdict. `/krites:telemetry-off` is permanent until you run `/krites:telemetry-on`. The answer is stored next to the signing key, never in a repo.

Krites is built by Quinn Lott. Report a vulnerability privately to hello@krites.dev, not in a public issue; see [SECURITY.md](SECURITY.md).

[krites.dev](https://krites.dev) · hello@krites.dev
