import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Todo el estado vive en un solo directorio para que sea trivial respaldarlo o borrarlo.
 *   <dir>/auth/    -> credenciales de Baileys (useMultiFileAuthState)
 *   <dir>/store.db -> SQLite con chats, contactos y mensajes
 */
export const DATA_DIR = process.env.WA_AGENT_DIR
  ? path.resolve(process.env.WA_AGENT_DIR)
  : path.join(os.homedir(), '.whatsapp-agent')

export const AUTH_DIR = path.join(DATA_DIR, 'auth')
export const DB_PATH = path.join(DATA_DIR, 'store.db')

export const BRIDGE_HOST = process.env.WA_BRIDGE_HOST ?? '127.0.0.1'
export const BRIDGE_PORT = Number(process.env.WA_BRIDGE_PORT ?? 8788)
export const BRIDGE_URL = process.env.WA_BRIDGE_URL ?? `http://${BRIDGE_HOST}:${BRIDGE_PORT}`

/** Si se define, el bridge exige `Authorization: Bearer <token>`. Opcional porque solo escucha en loopback. */
export const BRIDGE_TOKEN = process.env.WA_BRIDGE_TOKEN ?? ''

/** Pedirle a WhatsApp el historial completo en el primer sync (mas lento, pero es lo que queremos para leer). */
export const SYNC_FULL_HISTORY = process.env.WA_SYNC_FULL_HISTORY !== 'false'

/** Marcarnos "en linea" al conectar. false = tu telefono sigue recibiendo notificaciones normalmente. */
export const MARK_ONLINE = process.env.WA_MARK_ONLINE === 'true'

export const LOG_LEVEL = process.env.WA_LOG_LEVEL ?? 'info'

export function ensureDataDir(): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
}
