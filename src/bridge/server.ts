import http from 'node:http'
import { BRIDGE_HOST, BRIDGE_PORT, BRIDGE_TOKEN } from '../shared/config.js'
import { counts, getChat, getMessages, listChats, searchChats } from '../shared/db.js'
import { DASHBOARD_HTML } from './dashboard.js'
import { logger, state } from './socket.js'

/**
 * API HTTP local, SOLO LECTURA. Escucha en loopback.
 * El servidor MCP es un cliente delgado de esto: asi la sesion de WhatsApp
 * vive en un unico proceso persistente y varios agentes pueden leer a la vez.
 */
export function startServer(): http.Server {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload)
      })
      res.end(payload)
    }

    try {
      if (req.method !== 'GET') return send(405, { error: 'solo se permite GET (bridge de solo lectura)' })

      // Dashboard de salud: sin datos de chats, no requiere token.
      if ((req.url ?? '/').split('?')[0] === '/') {
        const html = Buffer.from(DASHBOARD_HTML, 'utf-8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': html.length
        })
        return res.end(html)
      }

      if (BRIDGE_TOKEN) {
        const auth = req.headers.authorization ?? ''
        if (auth !== `Bearer ${BRIDGE_TOKEN}`) return send(401, { error: 'token invalido' })
      }

      const url = new URL(req.url ?? '/', `http://${BRIDGE_HOST}:${BRIDGE_PORT}`)
      const q = url.searchParams
      const num = (k: string): number | null => {
        const v = q.get(k)
        if (v === null || v === '') return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }
      const bool = (k: string): boolean => q.get(k) === 'true' || q.get(k) === '1'

      switch (url.pathname) {
        case '/status':
          return send(200, {
            connection: state.connection,
            registered: state.registered,
            me: state.me,
            awaiting_qr: Boolean(state.qr),
            pairing_code: state.pairingCode,
            last_error: state.lastError,
            connected_at: state.connectedAt,
            process_started_at: state.processStartedAt,
            history_sync: state.historySync,
            stored: counts()
          })

        case '/chats':
          return send(200, {
            chats: listChats({
              limit: num('limit') ?? 25,
              offset: num('offset') ?? 0,
              type: (q.get('type') as 'all' | 'dm' | 'group' | null) ?? 'all',
              unreadOnly: bool('unread_only'),
              includeArchived: bool('include_archived')
            })
          })

        case '/chats/search': {
          const query = q.get('q')
          if (!query) return send(400, { error: 'falta el parametro q' })
          return send(200, { chats: searchChats(query, num('limit') ?? 20) })
        }

        case '/chat': {
          const jid = q.get('jid')
          if (!jid) return send(400, { error: 'falta el parametro jid' })
          const chat = getChat(jid)
          return chat ? send(200, { chat }) : send(404, { error: 'chat no encontrado' })
        }

        case '/messages': {
          const jid = q.get('chat_jid')
          if (!jid) return send(400, { error: 'falta el parametro chat_jid' })
          return send(200, {
            chat: getChat(jid),
            messages: getMessages({
              chatJid: jid,
              limit: num('limit') ?? 50,
              before: num('before'),
              after: num('after')
            })
          })
        }

        default:
          return send(404, { error: `ruta desconocida: ${url.pathname}` })
      }
    } catch (err) {
      logger.error({ err }, 'error atendiendo request')
      send(500, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    logger.info(`API de lectura escuchando en http://${BRIDGE_HOST}:${BRIDGE_PORT}`)
  })

  return server
}
