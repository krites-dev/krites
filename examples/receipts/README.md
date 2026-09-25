# A sample receipt

`2026-09-25T17-42-54Z-4a10c564.json` is the sample receipt krites.dev shows, and `2026-09-25T17-42-54Z-4a10c564.md` is the Markdown rendering `/krites:receipt` wrote beside it. It is a sample run on the plugin's Rust test fixture, with four checks (`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo doc --no-deps`, `cargo test`) and one line of `src/lib.rs` changed, made with plugin 0.2.1 (schema `krites.receipt/0.3`) and signed by the maintainer's key, fingerprint `6b11164d362ea9b5c7711d8f5465d76c7d6da068a55f9b4253bd697171978bfa`.

Verify it from the root of this repo:

```sh
node verify-receipt.js --key 6b11164d362ea9b5 examples/receipts/2026-09-25T17-42-54Z-4a10c564.json
```

It prints `valid: signed by 6b11164d362ea9b5c7711d8f5465d76c7d6da068a55f9b4253bd697171978bfa, verdict passed` and exits 0.

Change any field in a copy of the JSON, an exit code or a duration, and run the verifier on the copy: it prints an `invalid:` line, such as `invalid: the signature does not match the receipt`, and exits 1. The JSON is stored byte for byte (`-text` in `.gitattributes`), since a changed line ending breaks the signature too.
