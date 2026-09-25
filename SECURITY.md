# Security

Report a vulnerability in Krites privately to me by email at hello@krites.dev, not in a public issue or pull request.

Include the plugin version (in `.claude-plugin/plugin.json`), your OS and Node version, and the steps or input that show the problem. Leave out credentials and anything else you would not want stored, and scrub paths and output you send the same way.

In scope: the hooks (`hooks/`), the CLI (`cli.js`), the receipt signer and verifier (`lib/`, `verify-receipt.js`), and the ping endpoint at krites.dev. The limits the README lists under Known limits are known; a way around one that the README does not describe is in scope.

Please give me time to ship a fix before you disclose it.
