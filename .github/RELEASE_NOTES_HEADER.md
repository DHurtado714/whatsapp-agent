> **Not affiliated with, endorsed by, or sponsored by WhatsApp or Meta.** whatsapp-agent talks to WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial, reverse-engineered implementation of the WhatsApp Web protocol. This can violate WhatsApp's Terms of Service and may get your account banned or restricted. Read-only is not a guarantee of safety — use it only on an account you own.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/dhurtado714/whatsapp-agent/main/install.sh | bash
whatsapp-agent setup
```

Or download the archive for your platform below, verify it against `SHA256SUMS`, and extract it yourself.

Binaries are ~65–115MB (they bundle the Bun runtime) — see the README for why.

**No terminal?** Download `WhatsApp-Agent-<version>-darwin-<arm64|x64>.zip`, unzip, and drag
**WhatsApp Agent.app** to Applications. It isn't code-signed, so the first launch is
blocked by Gatekeeper — go to **System Settings → Privacy & Security → Open Anyway**,
then open it again. After that it runs the bridge in the background and everything else
(disclaimer, QR code, permissions, MCP client registration) happens from the dashboard
in your browser.

---
