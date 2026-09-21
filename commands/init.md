---
description: Detect this repo's checks and show the krites.toml Krites would write; --write creates or approves it.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/cli.js":*)
argument-hint: [--write]
disable-model-invocation: true
---
!`node "${CLAUDE_PLUGIN_ROOT}/cli.js" init $ARGUMENTS`

Reply with the output above inside one fenced code block, exactly as printed, and nothing else: every line of it inside the block, no summary, no advice, no sentence of your own before or after the block. If the output itself holds a line of backticks, make your fence longer than it. Use no tool: do not open, read, run or change anything, including any file the output names.
