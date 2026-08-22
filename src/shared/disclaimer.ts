import fs from 'node:fs'
import { DATA_DIR, DISCLAIMER_PATH } from './config.js'

/**
 * Single source of truth for the risk disclaimer. Rendered in the README, the
 * setup wizard's first screen, the CLI --help footer, and the dashboard footer.
 * Keep it short enough to read in a terminal, but don't soften the ban risk.
 */
export const DISCLAIMER = `whatsapp-agent is not affiliated with, endorsed by, or sponsored by WhatsApp or Meta.

It talks to WhatsApp through Baileys, an unofficial, reverse-engineered
implementation of the WhatsApp Web protocol. Using an unofficial client can
violate WhatsApp's Terms of Service and may get your account banned or
restricted. Reading is not a guarantee of safety, and sending messages is
riskier than reading them: automated sending is exactly what anti-spam
systems look for. Writing is off unless you grant it explicitly.

Use it only on a WhatsApp account you own. Your messages are stored
UNENCRYPTED in a local SQLite database on your machine. Provided "as is",
without warranty of any kind.`

export const DISCLAIMER_SHORT =
  'Unofficial WhatsApp client (Baileys). Can get your account banned. Writing is opt-in. Own risk, own account only.'

/** Bump when DISCLAIMER changes materially — accepted versions below this are treated as not-accepted. */
export const DISCLAIMER_VERSION = 1

type DisclaimerRecord = { version: number; accepted_at: string; source: 'cli' | 'dashboard' }

export function isDisclaimerAccepted(): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(DISCLAIMER_PATH, 'utf-8')) as DisclaimerRecord
    return record.version >= DISCLAIMER_VERSION
  } catch {
    return false
  }
}

export function acceptDisclaimer(source: 'cli' | 'dashboard'): void {
  const record: DisclaimerRecord = { version: DISCLAIMER_VERSION, accepted_at: new Date().toISOString(), source }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(DISCLAIMER_PATH, JSON.stringify(record), { mode: 0o600 })
}
