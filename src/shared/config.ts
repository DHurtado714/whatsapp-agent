import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * All state lives in a single directory so it's trivial to back up or delete.
 *   <dir>/auth/    -> Baileys credentials (useMultiFileAuthState)
 *   <dir>/store.db -> SQLite with chats, contacts, and messages
 */
export const DATA_DIR = process.env.WA_AGENT_DIR
  ? path.resolve(process.env.WA_AGENT_DIR)
  : path.join(os.homedir(), '.whatsapp-agent')

export const AUTH_DIR = path.join(DATA_DIR, 'auth')
export const DB_PATH = path.join(DATA_DIR, 'store.db')

export const BRIDGE_HOST = process.env.WA_BRIDGE_HOST ?? '127.0.0.1'
export const BRIDGE_PORT = Number(process.env.WA_BRIDGE_PORT ?? 8788)
export const BRIDGE_URL = process.env.WA_BRIDGE_URL ?? `http://${BRIDGE_HOST}:${BRIDGE_PORT}`

/** If set, the bridge requires `Authorization: Bearer <token>`. Optional because it only listens on loopback. */
export const BRIDGE_TOKEN = process.env.WA_BRIDGE_TOKEN ?? ''

/** Which browser identity to report to WhatsApp. See socket.ts for why this matters. */
export const BROWSER = process.env.WA_BROWSER ?? 'macos'

/** Ask WhatsApp for the full history on first sync (slower, but that's what we want for reading). */
export const SYNC_FULL_HISTORY = process.env.WA_SYNC_FULL_HISTORY !== 'false'

/** Mark ourselves "online" on connect. false = your phone keeps receiving push notifications normally. */
export const MARK_ONLINE = process.env.WA_MARK_ONLINE === 'true'

export const LOG_LEVEL = process.env.WA_LOG_LEVEL ?? 'info'

export function ensureDataDir(): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
}
