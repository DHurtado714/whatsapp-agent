# whatsapp-agent

WhatsApp bridge + MCP server, so your AI assistant can read your chats — and, if you
let it, reply to them.

```
You:    What did I talk about with Alice last week?

Claude: You and Alice discussed the Q3 budget review on Tuesday — she asked
        you to send the updated spreadsheet by Friday. On Thursday you
        confirmed the offsite date (Oct 14th) and she shared a restaurant
        recommendation for the team dinner.
```

> [!WARNING]
> **whatsapp-agent is not affiliated with, endorsed by, or sponsored by WhatsApp or Meta.**
> It talks to WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys), an
> unofficial, reverse-engineered implementation of the WhatsApp Web protocol. Using an
> unofficial client can violate WhatsApp's Terms of Service and **may get your account
> banned or restricted**. Reading is not a guarantee of safety, and **sending messages is
> riskier than reading them** — automated sending is what WhatsApp's anti-spam systems
> look for. Writing is off by default; you opt in per capability, and you own that choice.
> Use it only on a WhatsApp account you own. Your messages are stored
> **unencrypted** in a local SQLite file on your machine. Provided "as is", without
> warranty of any kind. See [Things worth knowing](#things-worth-knowing) below.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/danielhurtado714/whatsapp-agent/main/install.sh | bash
```

This downloads the right binary for your machine (macOS or Linux, Intel or ARM), verifies
its checksum, and installs it — no Node, no Bun, no build step required.

<details>
<summary>macOS app (no terminal)</summary>

If you'd rather not touch a terminal at all: download `WhatsApp-Agent-<version>-darwin-<arm64|x64>.zip`
from the [latest release](https://github.com/danielhurtado714/whatsapp-agent/releases/latest)
(arm64 if you have Apple Silicon, x64 if you have an Intel Mac), unzip it, and drag
**WhatsApp Agent.app** to your Applications folder.

It isn't code-signed by Apple, so the first launch will be blocked:

1. Double-click the app. macOS says it "cannot be opened because Apple cannot check it for
   malicious software." Click **Cancel** — not **Move to Trash**.
2. Open **System Settings → Privacy & Security**, scroll to *Security*, and click
   **Open Anyway** next to the WhatsApp Agent entry. Confirm with Touch ID or your password.
3. Double-click the app again — this time it opens.

That's it after the first time. The app starts the bridge as a background service and
opens the dashboard in your browser, where you'll accept the disclaimer, scan the QR
code, and (optionally) turn on write permissions — all from the page, no terminal
involved. It also registers itself with Claude Desktop, Cursor, and Claude Code
automatically; restart them to pick up the new MCP server.

</details>

<details>
<summary>Manual download</summary>

Grab the archive for your platform from the [latest release](https://github.com/danielhurtado714/whatsapp-agent/releases/latest), verify it against `SHA256SUMS`, then:

```bash
tar xzf whatsapp-agent-<platform>.tar.gz
sudo install -m 755 whatsapp-agent-<platform> /usr/local/bin/whatsapp-agent
```

On macOS, if you see "Apple could not verify this app": that's Gatekeeper's quarantine
flag, which browsers add to downloaded files (`curl` doesn't, which is why the one-liner
above doesn't hit this). Clear it with:

```bash
xattr -d com.apple.quarantine /usr/local/bin/whatsapp-agent
```

</details>

<details>
<summary>Build from source</summary>

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
git clone https://github.com/danielhurtado714/whatsapp-agent.git
cd whatsapp-agent
bun install
bun run build
bun dist/cli/index.js setup
```

</details>

Binaries bundle the Bun runtime, so they're not small: ~72–75MB on macOS, ~105–116MB on
Linux. That's the tradeoff for "no separate runtime to install."

## Set up

```bash
whatsapp-agent setup
```

This walks you through everything:

```
== Checking your system ==
✓ Platform: darwin/arm64
✓ Database ready at ~/.whatsapp-agent

== Linking WhatsApp ==
Scan this QR from your phone: WhatsApp > Settings > Linked devices > Link a device

  [QR code]

✓ Linked successfully.

== Syncing message history ==
  14,302 messages received (62%)
✓ History sync complete (23,108 messages).

== Registering with your AI tools ==
Register with Claude Code (~/.claude.json)? [Y/n] y
  ✓ Claude Code: registered whatsapp
Register with Claude Desktop (...)? [Y/n] y
  ✓ Claude Desktop: registered whatsapp

== Background service ==
Install whatsapp-agent as a background service (launchd)? [Y/n] y
✓ Installed (launchd): ~/Library/LaunchAgents/io.github.whatsapp-agent.bridge.plist

== Verifying ==
✓ MCP server responds correctly (4 tools, connection=open).

== Done ==
Try asking your AI assistant something like: "What did I talk about with X last week?"
```

Prefer a pairing code over a QR (useful over SSH)? `whatsapp-agent setup --pair 15551234567`.

Setup is safe to re-run any time — it detects what's already done (linked, registered,
installed) and skips it instead of redoing it.

## What your agent can do

Reading is always available. Everything that changes something is gated behind a
permission scope you grant explicitly — see [Permissions](#permissions).

**Always available (read)**

| Tool              | What it's for                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_status` | Is the bridge connected, which account, how much is stored, sync progress, which write scopes are active.                                                               |
| `list_chats`      | Recent conversations, pinned first. Filter by type (dm/group), unread, archived.                                                                                       |
| `search_chats`    | Find a chat by contact name, group name, or phone number.                                                                                                              |
| `get_messages`    | Read a conversation's history. Accepts a JID, a name, or a number — no need to look up an ID first. Supports date ranges (`since`/`until`, ISO or relative like `7d`). |

Example prompts: _"What did Bob say about the trip?"_, _"Summarize the #launch group from this week"_, _"Find the message where someone sent me an address."_

**Opt-in (write)**

| Tool                        | Scope    | What it does                                                                                       |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `send_message`              | `send`   | Send a text message, optionally as a reply to a specific message, with @-mentions.                 |
| `react_to_message`          | `send`   | Add or remove an emoji reaction.                                                                   |
| `edit_message`              | `send`   | Rewrite one of your own messages (WhatsApp allows this for a limited window).                       |
| `delete_message`            | `send`   | Retract a message for everyone, or remove it only from your devices.                                |
| `send_media`                | `media`  | Send an image, video, audio clip, voice note, document or sticker from a local path or an http URL. |
| `mark_chat_read`            | `chats`  | Clear the unread badge and send a read receipt.                                                     |
| `update_chat`               | `chats`  | Archive, pin or mute a chat.                                                                        |
| `send_typing`               | `chats`  | Show "typing…" / "recording…", or clear it.                                                         |
| `create_group`              | `groups` | Create a group and add participants.                                                                |
| `manage_group_participants` | `groups` | Add, remove, promote or demote participants.                                                        |
| `update_group`              | `groups` | Rename, change the description, get/revoke the invite link, or leave.                               |

Write tools only appear in the tool list when their scope is granted, so a read-only
install advertises exactly the four read tools and nothing else.

## Permissions

Write access is off by default. Nothing you do to the MCP client changes that — the
**bridge** is what enforces it, because the bridge is the process holding the WhatsApp
session:

```bash
whatsapp-agent bridge                          # read-only (default)
whatsapp-agent bridge --allow=send             # + send/reply/react/edit/delete
whatsapp-agent bridge --allow=send,chats       # + mark read, archive, pin, mute, typing
whatsapp-agent bridge --allow-write            # everything, including group admin
whatsapp-agent bridge --read-only              # force read-only, ignoring WA_ALLOW
```

`whatsapp-agent setup` asks which level you want and writes it into both the background
service and your MCP client's config, so the two agree. `WA_ALLOW` is the env equivalent
of `--allow`; `whatsapp-agent status` shows what's actually in force.

| Scope    | Grants                                                             |
| -------- | ------------------------------------------------------------------ |
| `send`   | Send, reply, react, edit, delete messages                          |
| `media`  | Send files (images, video, audio, documents, stickers)             |
| `chats`  | Mark read, archive, pin, mute, typing indicators                   |
| `groups` | Create groups, add/remove/promote participants, rename, leave      |

### Guardrails

These apply whenever any write scope is granted:

- **No new contacts.** A write to a number with no existing chat is refused. This is the
  guard against an agent that has invented a phone number and would otherwise message a
  stranger. Override with `--allow-new-contacts` if you actually need to start new
  conversations.
- **Rate limit.** 10 outbound messages per minute by default (`--rate-limit=<n>`, `0`
  disables it). Reactions, typing indicators and chat settings don't count against it.
  This is as much about not looking like a spam bot to WhatsApp as it is about a runaway
  loop.
- **Dry run.** `--dry-run` accepts every write call and reports exactly what it *would*
  have done without touching WhatsApp. Useful for testing prompts and automations.
- **Ambiguity is fatal.** `get_messages` will offer you a list when a name matches several
  chats; the write tools refuse instead. A misread name costs a turn when reading and
  costs you a message to the wrong person when writing.
- **Your MCP client still asks.** Write tools are annotated `readOnlyHint: false` (and
  `destructiveHint: true` for deletions and group changes), which is what makes clients
  like Claude Code prompt for approval before each call.

## How it works

```
  your phone ──WhatsApp Web protocol──▶  whatsapp-agent bridge  ──▶  ~/.whatsapp-agent/store.db
                                              (daemon)                    (SQLite)
                                                  │
                                                  │ local HTTP (GET always,
                                                  │ POST only for granted scopes)
                                                  │ 127.0.0.1:8788
                                                  ▼
     Claude / any MCP-capable agent  ◀──stdio MCP──  whatsapp-agent mcp
```

Two processes, on purpose:

**`whatsapp-agent bridge`** is a daemon that keeps a single WhatsApp session alive and
writes everything that arrives (chats, contacts, messages) into SQLite. It stays running.

**`whatsapp-agent mcp`** is the MCP server your AI client talks to. It doesn't touch
WhatsApp directly — it only queries the bridge over HTTP. It's stateless, starts in
milliseconds, and several agents can use it at once without fighting over the session.

If the MCP server ran Baileys directly instead, every agent startup would mean a
reconnect and a history re-sync — slow, noisy, and WhatsApp sees it as a device that
keeps reconnecting for no reason.

## Your data

Everything lives in `~/.whatsapp-agent/` (override with `WA_AGENT_DIR`):

- `auth/` — your WhatsApp session credentials. Full access to your account.
- `store.db` — your chats and messages, in plaintext SQLite.

Nothing leaves your machine. The bridge only listens on `127.0.0.1`.

To unlink and delete everything: `whatsapp-agent logout --purge`.

## Run it in the background

`whatsapp-agent setup` offers to install this for you. To do it later, or manage it
directly:

```bash
whatsapp-agent service install     # generates and starts a launchd/systemd unit
whatsapp-agent service status
whatsapp-agent service logs -f
whatsapp-agent service uninstall   # stops it; does NOT delete your data
```

**Linux only:** a systemd `--user` service stops when you log out unless linger is
enabled. `setup`/`service install` try to enable it automatically; if that fails
(common over plain SSH), run:

```bash
sudo loginctl enable-linger $USER
```

## Configuration

Everything's an environment variable, all optional:

| Variable               | Default             | What it does                                                                                                          |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `WA_AGENT_DIR`         | `~/.whatsapp-agent` | Where credentials and the database live.                                                                              |
| `WA_BRIDGE_PORT`       | `8788`              | Local API port.                                                                                                       |
| `WA_BRIDGE_TOKEN`      | (none)              | If set, the API requires `Authorization: Bearer <token>`. Set it for both processes.                                  |
| `WA_ALLOW`             | (none)              | Write scopes to grant: `send`, `media`, `chats`, `groups`, or `all`. Same as `--allow`. Empty means read-only.         |
| `WA_ALLOW_NEW_CONTACTS`| `false`             | `true` permits writing to numbers with no existing chat.                                                               |
| `WA_DRY_RUN`           | `false`             | `true` reports what writes would do without performing them.                                                          |
| `WA_SEND_RATE_LIMIT`   | `10`                | Outbound messages per minute. `0` disables the limit.                                                                  |
| `WA_BROWSER`           | `macos`             | `macos`, `ubuntu`, or `windows` — the client identity reported to WhatsApp. See [Troubleshooting](#troubleshooting).  |
| `WA_SYNC_FULL_HISTORY` | `true`              | `false` to sync less history, faster.                                                                                 |
| `WA_MARK_ONLINE`       | `false`             | `true` marks you "online" on connect (your phone stops getting push notifications while connected). Leave it `false`. |
| `WA_LOG_LEVEL`         | `info`              | `debug` when something's off.                                                                                         |
| `WA_SQLITE_LIB`        | (system default)    | Path to a custom `libsqlite3` if your system's doesn't support FTS5.                                                  |

## Troubleshooting

Run `whatsapp-agent doctor` first — it checks your SQLite/FTS5 support, data directory,
bridge reachability, session status, background service, and which MCP clients have
whatsapp registered (and whether the path they point at still exists). Include its
output in any bug report.

**"Apple could not verify this app" / quarantine.** See [Manual download](#install) above — use the `curl` install, or `xattr -d com.apple.quarantine` on a manual download.

**New linking loops with `statusCode: 428` / "Connection Terminated", never shows a QR.** Not your network or install — since late June 2026 WhatsApp has rejected the `'Desktop'` platform identifier before completing the handshake ([known Baileys issue](https://github.com/WhiskeySockets/Baileys/issues/2677)). whatsapp-agent already reports `'Chrome'` instead, which works. If it starts failing again, try `WA_BROWSER=ubuntu whatsapp-agent setup`.

**Port already in use.** Something else is on 8788, or a previous bridge is still running. `whatsapp-agent status` tells you if it's actually your own bridge; `WA_BRIDGE_PORT=8789` picks a different one.

**History sync seems stuck / incomplete.** WhatsApp decides how much history to send, not whatsapp-agent — usually the last few months per chat, not everything since account creation. It keeps arriving the longer the bridge stays running.

**Logged out from your phone.** WhatsApp closes linked devices after ~14 days without the phone connecting. Run `whatsapp-agent setup` again to re-link — your existing message history is kept.

**Linux service dies after logout.** See the linger note under [Run it in the background](#run-it-in-the-background).

## FAQ

**Can it send messages?** Only if you turn that on. Start the bridge with `--allow=send` (or pick a write level during `whatsapp-agent setup`). With no scopes granted — the default — every write is refused by the bridge and the write tools aren't even advertised to your agent. See [Permissions](#permissions).

**Will I get banned?** Unknown, and sending raises the risk. Reading and behaving like a normal linked device is low-risk; automated sending is what anti-spam systems are built to catch, especially to people who haven't messaged you first. If you enable `send`, keep the rate limit low, leave the new-contacts guard on, and don't use it for outreach.

**Can I let it read but not reply?** That's the default — you have to opt in per scope, and you can revoke it at any time by restarting the bridge with `--read-only`.

**Multiple accounts?** Not yet — one bridge, one linked account.

**Windows?** Not supported. macOS and Linux only.

## Things worth knowing

**Baileys is unofficial.** It reimplements the WhatsApp Web protocol; WhatsApp could suspend the account. Risk is low while you only read and behave like a normal linked device, and higher as soon as you let something send messages on your behalf.

**`~/.whatsapp-agent/` is sensitive.** `auth/` grants full account access; `store.db` holds your messages in plaintext. Don't put it in a shared backup or commit it anywhere.

**Old messages only show up if WhatsApp sends them.** The bridge can't request arbitrary history — it keeps whatever arrived during the initial sync plus everything new since. The longer it runs, the more complete it gets.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
