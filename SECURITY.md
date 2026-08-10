# Security

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue: use
[GitHub's private vulnerability reporting](https://github.com/danielhurtado714/whatsapp-agent/security/advisories/new)
on this repository, or email the maintainer directly if that isn't available.

Please include:
- What you found and why it's a security issue (not just a bug)
- Steps to reproduce
- The impact you'd expect (data exposure, account compromise, code execution, ...)

We'll acknowledge within a few days and let you know before any public disclosure.

## Scope and known risk model

Read this before reporting — some things here are known, accepted tradeoffs rather than
vulnerabilities:

- **whatsapp-agent stores your WhatsApp messages unencrypted** in a local SQLite file at
  `~/.whatsapp-agent/store.db`, and your session credentials (full account access) at
  `~/.whatsapp-agent/auth/`. This is by design for a local, single-user tool — full-disk
  encryption and normal OS file permissions are the intended protection, not application-
  level encryption. If you have a concrete way to compromise that data through the
  application itself (not "the disk is unencrypted"), that's in scope.
- **The bridge's HTTP API binds to `127.0.0.1` only** and is unauthenticated by default
  (an optional bearer token via `WA_BRIDGE_TOKEN` is supported, and `setup` generates one
  automatically). A same-machine process can reach chat data without a token. A DNS-
  rebinding attack from a malicious webpage is mitigated by a `Host` header check in
  `src/bridge/server.ts` — if you find a way around that check, please report it.
- **whatsapp-agent talks to WhatsApp through Baileys**, an unofficial protocol
  implementation. Bugs in Baileys itself should generally be reported upstream at
  [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys), unless the issue
  is specifically in how this project uses it.
- **Using an unofficial WhatsApp client carries an inherent account-ban/restriction
  risk.** That's a product risk disclosed in the README, not a security vulnerability to
  report here.

## Supported versions

Only the latest released version is supported. Please update before reporting.
