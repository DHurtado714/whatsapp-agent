import crypto from 'node:crypto'
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

export const TOKEN_PATH = path.join(DATA_DIR, 'token')

function readTokenFile(): string {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf-8').trim()
  } catch {
    return ''
  }
}

/**
 * If set, the bridge requires `Authorization: Bearer <token>`. Optional
 * because it only listens on loopback, but `setup` generates and persists
 * one by default (see ensureBridgeToken) so the API isn't wide open to any
 * other local process by default either. WA_BRIDGE_TOKEN always wins if
 * set. Deliberately a function, not a frozen constant read once at import:
 * ensureBridgeToken() can write the token file *after* this module has
 * already been imported elsewhere in the same process (e.g. by the setup
 * wizard, which imports config.js for DATA_DIR before it knows whether a
 * token needs generating) — a top-level const would have frozen at '' and
 * never picked up the newly written file.
 */
export function getBridgeToken(): string {
  return process.env.WA_BRIDGE_TOKEN ?? readTokenFile()
}

/**
 * Generates a token on first run and persists it at TOKEN_PATH (0600), or
 * returns the existing one. Called by the setup wizard before registering
 * MCP clients. Because getBridgeToken() re-reads the file on every request
 * rather than caching it, this takes effect immediately for an already
 * running bridge too — no restart needed. Loopback-only binding + the Host
 * header check in server.ts are still the primary controls; this token is
 * defense in depth on top of them.
 */
export function ensureBridgeToken(): string {
  const existing = readTokenFile()
  if (existing) return existing
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 })
  return token
}

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
