---
description: Run this repo's configured checks now and show their raw output.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/cli.js":*)
disable-model-invocation: true
---
Run this exact command with the Bash tool, once, with the Bash tool's timeout parameter set to 600000, and run nothing else:

node "${CLAUDE_PLUGIN_ROOT}/cli.js" verify

Then reply with the output of that command inside one fenced code block, exactly as printed, and nothing else: every line of it inside the block, no summary, no verdict, no advice, no sentence of your own before or after the block. If the output itself holds a line of backticks, make your fence longer than it. If the Bash tool call is denied or fails, reply with exactly what the tool said and nothing else.
