/**
 * Single source of truth for the risk disclaimer. Rendered in the README, the
 * setup wizard's first screen, the CLI --help footer, and the dashboard footer.
 * Keep it short enough to read in a terminal, but don't soften the ban risk.
 */
export const DISCLAIMER = `whatsapp-agent is not affiliated with, endorsed by, or sponsored by WhatsApp or Meta.

It talks to WhatsApp through Baileys, an unofficial, reverse-engineered
implementation of the WhatsApp Web protocol. Using an unofficial client can
violate WhatsApp's Terms of Service and may get your account banned or
restricted. This tool is read-only, but read-only is not a guarantee of
safety.

Use it only on a WhatsApp account you own. Your messages are stored
UNENCRYPTED in a local SQLite database on your machine. Provided "as is",
without warranty of any kind.`

export const DISCLAIMER_SHORT =
  'Unofficial WhatsApp client (Baileys). Read-only, but can still get your account banned. Own risk, own account only.'
