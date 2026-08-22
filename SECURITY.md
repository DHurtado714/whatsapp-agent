# Security

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue: use
[GitHub's private vulnerability reporting](https://github.com/dhurtado714/whatsapp-agent/security/advisories/new)
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
  automatically). A same-machine process can reach chat data — and, if a write scope is
  granted, send messages — without a token. That is an accepted tradeoff for a local
  single-user tool. Two browser-specific gaps are closed deliberately: a DNS-rebinding
  attack is mitigated by a `Host` header check, and write requests carrying an `Origin`
  header are refused outright, since only a browser sends one and a `POST`'s side effect
  lands even when CORS hides the response. If you find a way around either, please report
  it.
- **Write access is opt-in and enforced by the bridge**, not by the MCP server. With no
  scopes granted (the default), every mutating route answers `403`. The MCP server
  additionally omits write tools it has no scope for, but that is a usability measure —
  the bridge is the security boundary. A way to perform a mutation without the
  corresponding scope is in scope for a report.
- **The `media` scope lets an agent send any file the bridge's user can read.** That is
  the documented purpose of the scope, so "an agent could exfiltrate a local file over
  WhatsApp" is an accepted consequence of granting it, not a vulnerability. Don't grant
  `media` to an agent you wouldn't trust with your filesystem. A path traversal or scope
  bypass that sends files *without* `media` granted is in scope.
- **whatsapp-agent talks to WhatsApp through Baileys**, an unofficial protocol
  implementation. Bugs in Baileys itself should generally be reported upstream at
  [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys), unless the issue
  is specifically in how this project uses it.
- **Using an unofficial WhatsApp client carries an inherent account-ban/restriction
  risk**, which increases when you enable sending. That's a product risk disclosed in the
  README, not a security vulnerability to report here.

## Supported versions

Only the latest released version is supported. Please update before reporting.
