import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey
} from 'baileys'
import type { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

import { AUTH_DIR, LOG_LEVEL, MARK_ONLINE, SYNC_FULL_HISTORY, ensureDataDir } from '../shared/config.js'
import {
  getDb,
  setMeta,
  upsertChat,
  upsertContact,
  upsertLidMapping,
  upsertMessages,
  type MessageInput
} from '../shared/db.js'
import { parseMessage, toMillis } from '../shared/message.js'

// pino a stderr: stdout queda limpio por si alguien encadena procesos.
export const logger = pino(
  { level: LOG_LEVEL },
  pino.destination({ dest: 2, sync: false })
)

export type BridgeState = {
  connection: 'connecting' | 'open' | 'close'
  registered: boolean
  me: { id: string; name?: string } | null
  qr: string | null
  pairingCode: string | null
  lastError: string | null
  historySync: { received: number; complete: boolean; progress: number | null }
  connectedAt: number | null
  processStartedAt: number
}

export const state: BridgeState = {
  connection: 'connecting',
  registered: false,
  me: null,
  qr: null,
  pairingCode: null,
  lastError: null,
  historySync: { received: 0, complete: false, progress: null },
  connectedAt: null,
  processStartedAt: Date.now()
}

type StartOptions = {
  /** Numero (solo digitos, con codigo de pais) para pedir un pairing code en vez de QR. */
  pairWithNumber?: string
  /** Imprimir el QR en la terminal. Se desactiva cuando corre como daemon sin TTY. */
  printQr?: boolean
  onOpen?: () => void
}

let sock: ReturnType<typeof makeWASocket> | null = null
let stopping = false

export function getSocket() {
  return sock
}

export function stop(): void {
  stopping = true
  try {
    sock?.end(undefined)
  } catch {
    /* noop */
  }
}

export async function start(opts: StartOptions = {}): Promise<void> {
  ensureDataDir()
  getDb()

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version, isLatest } = await fetchLatestBaileysVersion()
  logger.info({ version, isLatest }, 'usando protocolo de WhatsApp Web')

  state.registered = Boolean(authState.creds.registered)

  sock = makeWASocket({
    version,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger)
    },
    logger,
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: SYNC_FULL_HISTORY,
    markOnlineOnConnect: MARK_ONLINE,
    shouldSyncHistoryMessage: () => true,
    generateHighQualityLinkPreview: false,
    getMessage: async (key: WAMessageKey) => {
      if (!key.remoteJid || !key.id) return undefined
      const row = getDb()
        .prepare(`SELECT raw FROM messages WHERE chat_jid = ? AND msg_id = ?`)
        .get(key.remoteJid, key.id) as { raw: string | null } | undefined
      if (!row?.raw) return undefined
      try {
        return JSON.parse(row.raw)
      } catch {
        return undefined
      }
    }
  })

  let pairingRequested = false

  sock.ev.process(async (events) => {
    if (events['creds.update']) {
      await saveCreds()
      state.registered = Boolean(authState.creds.registered)
    }

    if (events['connection.update']) {
      const update = events['connection.update']

      if (update.qr) {
        state.qr = update.qr
        if (opts.pairWithNumber && !pairingRequested && !authState.creds.registered) {
          pairingRequested = true
          try {
            const code = await sock!.requestPairingCode(opts.pairWithNumber)
            state.pairingCode = code
            logger.info({ code }, 'codigo de vinculacion generado')
            process.stderr.write(
              `\n  Codigo de vinculacion: ${code}\n` +
                `  En tu telefono: WhatsApp > Ajustes > Dispositivos vinculados >\n` +
                `  Vincular dispositivo > Vincular con numero de telefono\n\n`
            )
          } catch (err) {
            logger.error({ err }, 'no se pudo pedir el pairing code')
          }
        } else if (opts.printQr && !opts.pairWithNumber) {
          process.stderr.write('\n  Escanea este QR desde WhatsApp > Dispositivos vinculados:\n\n')
          qrcode.generate(update.qr, { small: true }, (art: string) => process.stderr.write(art + '\n'))
        }
      }

      if (update.connection) {
        state.connection = update.connection
        if (update.connection === 'open') {
          state.qr = null
          state.pairingCode = null
          state.lastError = null
          state.connectedAt = Date.now()
          state.me = sock!.user ? { id: sock!.user.id, name: sock!.user.name } : null
          setMeta('me_jid', state.me?.id ?? '')
          setMeta('last_connected_at', String(Date.now()))
          logger.info({ me: state.me }, 'conectado a WhatsApp')
          opts.onOpen?.()
        }
      }

      if (update.connection === 'close') {
        const boom = update.lastDisconnect?.error as Boom | undefined
        const statusCode = boom?.output?.statusCode
        state.lastError = boom?.message ?? 'conexion cerrada'

        if (stopping) return

        if (statusCode === DisconnectReason.loggedOut) {
          logger.error(
            'la sesion fue cerrada desde el telefono. Borra la carpeta auth/ y vuelve a vincular.'
          )
          process.exitCode = 1
          return
        }

        const delay = statusCode === DisconnectReason.restartRequired ? 250 : 3000
        logger.warn({ statusCode }, `reconectando en ${delay}ms`)
        setTimeout(() => {
          start(opts).catch((err) => logger.error({ err }, 'fallo al reconectar'))
        }, delay)
      }
    }

    if (events['lid-mapping.update']) {
      const m = events['lid-mapping.update']
      if (m.lid && m.pn) upsertLidMapping(m.lid, m.pn)
    }

    if (events['contacts.upsert']) ingestContacts(events['contacts.upsert'])
    if (events['contacts.update']) ingestContacts(events['contacts.update'] as any[])

    if (events['chats.upsert']) ingestChats(events['chats.upsert'])
    if (events['chats.update']) ingestChats(events['chats.update'] as any[])

    if (events['groups.upsert']) {
      for (const g of events['groups.upsert']) {
        if (g.id) upsertChat({ jid: g.id, name: g.subject ?? null, isGroup: true })
      }
    }
    if (events['groups.update']) {
      for (const g of events['groups.update']) {
        if (g.id) upsertChat({ jid: g.id, name: g.subject ?? null, isGroup: true })
      }
    }

    if (events['messaging-history.set']) {
      const h = events['messaging-history.set']
      for (const m of h.lidPnMappings ?? []) {
        if (m.lid && m.pn) upsertLidMapping(m.lid, m.pn)
      }
      ingestContacts(h.contacts ?? [])
      ingestChats(h.chats ?? [])
      const n = ingestMessages(h.messages ?? [])
      state.historySync.received += n
      state.historySync.progress = h.progress ?? null
      logger.info(
        { batch: n, total: state.historySync.received, progress: h.progress },
        'lote de historial procesado'
      )
    }

    if (events['messaging-history.status']) {
      const s = events['messaging-history.status']
      if (s.status === 'complete') {
        state.historySync.complete = true
        setMeta('history_sync_complete_at', String(Date.now()))
        logger.info({ syncType: s.syncType }, 'sincronizacion de historial completa')
      }
    }

    if (events['messages.upsert']) {
      ingestMessages(events['messages.upsert'].messages)
    }

    if (events['messages.update']) {
      // Ediciones y borrados: re-ingerimos el contenido nuevo cuando viene.
      for (const u of events['messages.update']) {
        const inner = (u.update as any)?.message
        if (inner && u.key?.remoteJid && u.key?.id) {
          ingestMessages([{ key: u.key, message: inner, messageTimestamp: Date.now() / 1000 } as WAMessage])
        }
      }
    }
  })
}

// ---------------------------------------------------------------- ingestion

function ingestContacts(contacts: any[]): void {
  for (const c of contacts) {
    if (!c?.id) continue
    upsertContact({
      jid: c.id,
      lid: c.lid ?? null,
      phoneNumber: c.phoneNumber ?? (c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : null),
      name: c.name ?? null,
      notify: c.notify ?? null,
      verifiedName: c.verifiedName ?? null
    })
    if (c.lid && c.phoneNumber) upsertLidMapping(c.lid, c.phoneNumber)
  }
}

function ingestChats(chats: any[]): void {
  for (const c of chats) {
    const jid: string | undefined = c?.id
    if (!jid || isJidStatusBroadcast(jid)) continue
    upsertChat({
      jid,
      name: c.name ?? c.subject ?? c.displayName ?? null,
      isGroup: Boolean(isJidGroup(jid)),
      lastMessageAt: c.conversationTimestamp ? toMillis(c.conversationTimestamp) : null,
      unreadCount: typeof c.unreadCount === 'number' ? Math.max(c.unreadCount, 0) : null,
      archived: typeof c.archived === 'boolean' ? c.archived : null,
      pinned: c.pinned !== undefined && c.pinned !== null ? Boolean(c.pinned) : null,
      mutedUntil: c.muteEndTime ? toMillis(c.muteEndTime) : null
    })
  }
}

function ingestMessages(messages: WAMessage[]): number {
  const rows: MessageInput[] = []
  const seenChats = new Map<string, number>()

  for (const msg of messages) {
    const chatJid = msg.key?.remoteJid
    const msgId = msg.key?.id
    if (!chatJid || !msgId) continue
    if (isJidStatusBroadcast(chatJid) || isJidNewsletter(chatJid)) continue

    const parsed = parseMessage(msg)
    if (parsed.kind === 'protocolMessage' || parsed.kind === 'senderKeyDistributionMessage') continue

    const ts = toMillis(msg.messageTimestamp)
    const fromMe = msg.key.fromMe ? 1 : 0
    const senderRaw = fromMe
      ? (state.me?.id ?? null)
      : ((msg.key as any).participant ?? msg.participant ?? chatJid)
    const senderJid = senderRaw ? safeNormalize(senderRaw) : null

    const isMedia = Boolean(parsed.mediaType)
    let raw: string | null = null
    if ((fromMe || isMedia) && msg.message) {
      const json = JSON.stringify(msg.message)
      raw = json.length <= 200_000 ? json : null
    }

    rows.push({
      chat_jid: chatJid,
      msg_id: msgId,
      from_me: fromMe,
      sender_jid: senderJid,
      sender_name: msg.pushName ?? null,
      timestamp: ts,
      kind: parsed.kind,
      text: parsed.text,
      quoted_id: parsed.quotedId,
      media_type: parsed.mediaType,
      filename: parsed.filename,
      raw
    })

    const prev = seenChats.get(chatJid) ?? 0
    if (ts > prev) seenChats.set(chatJid, ts)

    // Un mensaje entrante tambien nos dice el pushName del remitente.
    if (!fromMe && senderJid && msg.pushName) {
      upsertContact({ jid: senderJid, notify: msg.pushName })
    }
  }

  // Aseguramos que el chat exista aunque no haya llegado por history sync.
  for (const [jid, ts] of seenChats) {
    upsertChat({ jid, isGroup: Boolean(isJidGroup(jid)), lastMessageAt: ts })
  }

  return upsertMessages(rows)
}

function safeNormalize(jid: string): string {
  try {
    return jidNormalizedUser(jid)
  } catch {
    return jid
  }
}
