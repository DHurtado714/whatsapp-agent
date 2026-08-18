import http from 'node:http'
import { BRIDGE_HOST, BRIDGE_PORT, getBridgeToken } from '../shared/config.js'
import { counts, getChat, getMessages, listChats, searchChats } from '../shared/db.js'
import { permissionsPayload } from '../shared/permissions.js'
import {
  ActionError,
  createGroup,
  deleteMessage,
  editMessage,
  getPermissions,
  markChatRead,
  reactToMessage,
  sendMedia,
  sendText,
  sendTyping,
  updateChat,
  updateGroup,
  updateGroupParticipants,
} from './actions.js'
import { DASHBOARD_HTML } from './dashboard.js'
import { logger, state } from './socket.js'

/** Anything bigger than this is a bug or an attack, not a legitimate control-plane call. */
const MAX_BODY_BYTES = 1_000_000

type Handler = (body: any) => Promise<unknown>

/**
 * Local HTTP API. Listens on loopback only.
 * The MCP server is a thin client of this: that way the WhatsApp session
 * lives in a single persistent process and several agents can share it.
 *
 * GET routes are reads and are always available. POST routes mutate, and each
 * one is gated on a permission scope that the operator has to grant explicitly
 * (see shared/permissions.ts) — with no scopes granted, which is the default,
 * every POST below answers 403 and this is a read-only API exactly as before.
 */
export function startServer(opts: { port?: number; host?: string } = {}): http.Server {
  // BRIDGE_PORT/BRIDGE_HOST are read once at module load, so setting
  // WA_BRIDGE_PORT afterwards has no effect. Tests need a free port without
  // depending on which file imported shared/config.ts first, hence the
  // explicit override.
  const host = opts.host ?? BRIDGE_HOST
  const port = opts.port ?? BRIDGE_PORT
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    }

    const fail = (err: unknown) => {
      if (err instanceof ActionError) return send(err.status, { error: err.message })
      logger.error({ err }, 'error handling request')
      send(500, { error: err instanceof Error ? err.message : String(err) })
    }

    try {
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'POST') {
        return send(405, { error: 'only GET and POST are allowed' })
      }

      // Binding to 127.0.0.1 stops other machines from connecting, but a
      // malicious webpage can still resolve a hostname it controls to
      // 127.0.0.1 (DNS rebinding) and make same-origin-looking requests
      // from a real browser. A Host check closes that gap.
      const rawHost = req.headers.host ?? ''
      // A bracketed IPv6 literal like "[::1]:8788" contains colons itself,
      // so a naive split(':')[0] would chop it to just "[" — strip the
      // bracket pair as a unit instead, then fall back to stripping ":port".
      const host = rawHost.startsWith('[') ? rawHost.slice(0, rawHost.indexOf(']') + 1) : rawHost.split(':')[0]
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
        return send(403, { error: 'forbidden: request Host must be 127.0.0.1, localhost, or [::1]' })
      }

      // Health dashboard: no chat data, doesn't require a token.
      if (method === 'GET' && (req.url ?? '/').split('?')[0] === '/') {
        const html = Buffer.from(DASHBOARD_HTML, 'utf-8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': html.length,
        })
        return res.end(html)
      }

      // The Host check above doesn't cover a page that fetches 127.0.0.1
      // directly: there the Host header is legitimately ours. For a GET that
      // didn't matter (CORS still hides the response from the page), but a
      // POST has already happened by the time the response is discarded, so
      // side effects would land. Browsers always attach Origin to a
      // cross-origin POST; our own clients never send it at all.
      if (method === 'POST' && req.headers.origin) {
        return send(403, { error: 'forbidden: cross-origin requests are not accepted' })
      }

      const url = new URL(req.url ?? '/', `http://${host}:${port}`)

      const bridgeToken = getBridgeToken()
      if (bridgeToken) {
        const auth = req.headers.authorization ?? ''
        // The dashboard page itself is token-free (it's static HTML with no
        // chat data), but its own JS polls /status like any other client and
        // can't set an Authorization header on a page navigation — so it
        // carries the token as a query param instead (see dashboard.ts and
        // the printed dashboard URL in bridge/index.ts).
        const tokenFromQuery = url.searchParams.get('token')
        if (auth !== `Bearer ${bridgeToken}` && tokenFromQuery !== bridgeToken) {
          return send(401, { error: 'invalid token' })
        }
      }

      if (method === 'POST') {
        const handler = WRITE_ROUTES[url.pathname]
        if (!handler) return send(404, { error: `unknown route: POST ${url.pathname}` })
        return readJsonBody(req)
          .then(handler)
          .then((result) => send(200, result))
          .catch(fail)
      }

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
            permissions: permissionsPayload(getPermissions()),
          })

        case '/permissions':
          return send(200, permissionsPayload(getPermissions()))

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
      fail(err)
    }
  })

  server.listen(port, host, () => {
    // Log the actual bound port, not the configured one: it can be 0 (let the
    // OS pick one, used by the tests to avoid port clashes).
    const addr = server.address()
    const boundPort = addr && typeof addr === 'object' ? addr.port : port
    logger.info(`API listening on http://${host}:${boundPort}`)
  })

  return server
}

/**
 * Each handler is a straight pass-through to actions.ts, which owns the
 * validation, the scope check and the guardrails — keeping that logic out of
 * the HTTP layer is what lets the unit tests exercise it without a server.
 */
const WRITE_ROUTES: Record<string, Handler> = {
  '/send': (b) => sendText(b),
  '/send/media': (b) => sendMedia(b),
  '/react': (b) => reactToMessage(b),
  '/edit': (b) => editMessage(b),
  '/delete': (b) => deleteMessage(b),
  '/chat/read': (b) => markChatRead(b),
  '/chat/update': (b) => updateChat(b),
  '/chat/typing': (b) => sendTyping(b),
  '/group/create': (b) => createGroup(b),
  '/group/participants': (b) => updateGroupParticipants(b),
  '/group/update': (b) => updateGroup(b),
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejected = true
        // Stop reading but don't destroy the socket: the 413 still has to be
        // written, and tearing the connection down here reaches the client as
        // an ECONNRESET instead of an explanation. Node closes the connection
        // itself once the response to a half-read request has flushed.
        req.pause()
        chunks.length = 0
        reject(new ActionError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (raw === '') return resolve({})
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new ActionError(400, 'request body must be a JSON object'))
        }
        resolve(parsed)
      } catch {
        reject(new ActionError(400, 'request body is not valid JSON'))
      }
    })
  })
}
