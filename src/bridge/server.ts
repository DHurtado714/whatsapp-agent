import http from 'node:http'
import { BRIDGE_HOST, BRIDGE_PORT, getBridgeToken } from '../shared/config.js'
import { counts, getChat, getMessages, listChats, searchChats } from '../shared/db.js'
import { DASHBOARD_HTML } from './dashboard.js'
import { logger, state } from './socket.js'

/**
 * Local, READ-ONLY HTTP API. Listens on loopback only.
 * The MCP server is a thin client of this: that way the WhatsApp session
 * lives in a single persistent process and several agents can read at once.
 */
export function startServer(): http.Server {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    }

    try {
      if (req.method !== 'GET') return send(405, { error: 'only GET is allowed (read-only bridge)' })

      // Binding to 127.0.0.1 stops other machines from connecting, but a
      // malicious webpage can still resolve a hostname it controls to
      // 127.0.0.1 (DNS rebinding) and make same-origin-looking requests
      // from a real browser. A same-origin cross-site page can't read the
      // response (CORS), but doesn't need to for a GET-only, side-effect-
      // free API — a Host check closes that gap.
      const rawHost = req.headers.host ?? ''
      // A bracketed IPv6 literal like "[::1]:8788" contains colons itself,
      // so a naive split(':')[0] would chop it to just "[" — strip the
      // bracket pair as a unit instead, then fall back to stripping ":port".
      const host = rawHost.startsWith('[') ? rawHost.slice(0, rawHost.indexOf(']') + 1) : rawHost.split(':')[0]
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
        return send(403, { error: 'forbidden: request Host must be 127.0.0.1, localhost, or [::1]' })
      }

      // Health dashboard: no chat data, doesn't require a token.
      if ((req.url ?? '/').split('?')[0] === '/') {
        const html = Buffer.from(DASHBOARD_HTML, 'utf-8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': html.length,
        })
        return res.end(html)
      }

      const bridgeToken = getBridgeToken()
      if (bridgeToken) {
        const auth = req.headers.authorization ?? ''
        if (auth !== `Bearer ${bridgeToken}`) return send(401, { error: 'invalid token' })
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
            stored: counts(),
          })

        case '/chats':
          return send(200, {
            chats: listChats({
              limit: num('limit') ?? 25,
              offset: num('offset') ?? 0,
              type: (q.get('type') as 'all' | 'dm' | 'group' | null) ?? 'all',
              unreadOnly: bool('unread_only'),
              includeArchived: bool('include_archived'),
            }),
          })

        case '/chats/search': {
          const query = q.get('q')
          if (!query) return send(400, { error: 'missing q parameter' })
          return send(200, { chats: searchChats(query, num('limit') ?? 20) })
        }

        case '/chat': {
          const jid = q.get('jid')
          if (!jid) return send(400, { error: 'missing jid parameter' })
          const chat = getChat(jid)
          return chat ? send(200, { chat }) : send(404, { error: 'chat not found' })
        }

        case '/messages': {
          const jid = q.get('chat_jid')
          if (!jid) return send(400, { error: 'missing chat_jid parameter' })
          return send(200, {
            chat: getChat(jid),
            messages: getMessages({
              chatJid: jid,
              limit: num('limit') ?? 50,
              before: num('before'),
              after: num('after'),
            }),
          })
        }

        default:
          return send(404, { error: `unknown route: ${url.pathname}` })
      }
    } catch (err) {
      logger.error({ err }, 'error handling request')
      send(500, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    // Log the actual bound port, not the configured one: BRIDGE_PORT can be
    // 0 (let the OS pick one, used by the e2e suite to avoid port clashes).
    const addr = server.address()
    const boundPort = addr && typeof addr === 'object' ? addr.port : BRIDGE_PORT
    logger.info(`read-only API listening on http://${BRIDGE_HOST}:${boundPort}`)
  })

  return server
}
