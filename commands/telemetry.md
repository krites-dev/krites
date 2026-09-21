---
description: Turn the anonymous Krites ping on or off.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/cli.js":*)
argument-hint: on|off
disable-model-invocation: true
---
!`node "${CLAUDE_PLUGIN_ROOT}/cli.js" telemetry $ARGUMENTS`

Reply with the output above exactly as printed and nothing else: no summary, no advice, no sentence of your own before or after it. Use no tool: do not open, read, run or change anything, including any file the output names.
