import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import http from 'node:http'

let server: http.Server
let port: number

beforeAll(async () => {
  // The data directory and the port come from scripts/test-preload.ts, which
  // has to run before config.ts is imported — see the comment there.
  const { startServer } = await import('./server.js')
  server = startServer({ port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('expected a bound TCP address')
  port = addr.port
})

afterAll(() => {
  server.close()
})

function requestWithHost(hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/status', headers: { Host: hostHeader } }, (res) =>
      resolve(res.statusCode ?? 0),
    )
    req.on('error', reject)
    req.end()
  })
}

describe('Host header check (DNS rebinding protection)', () => {
  test('accepts a legitimate 127.0.0.1 Host header', async () => {
    expect(await requestWithHost(`127.0.0.1:${port}`)).toBe(200)
  })

  test('accepts localhost', async () => {
    expect(await requestWithHost(`localhost:${port}`)).toBe(200)
  })

  test('rejects a spoofed Host header (simulated DNS rebinding)', async () => {
    expect(await requestWithHost('evil.example.com')).toBe(403)
  })

  test('rejects a Host header with no port at all', async () => {
    expect(await requestWithHost('attacker.test')).toBe(403)
  })
})

describe('write surface', () => {
  // actions.test.ts runs earlier in the same process and leaves its own
  // permissions in the module-level state; pin read-only here so these
  // assertions don't depend on test-file ordering.
  beforeAll(async () => {
    const { setPermissions } = await import('./actions.js')
    const { resolvePermissions } = await import('../shared/permissions.js')
    setPermissions(resolvePermissions({ readOnly: true }))
  })

  function request(
    method: string,
    urlPath: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...extraHeaders }
      if (payload) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = String(Buffer.byteLength(payload))
      }
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        let raw = ''
        res.on('data', (c) => {
          raw += c
        })
        res.on('end', () => {
          let parsed: any = null
          try {
            parsed = JSON.parse(raw)
          } catch {
            /* non-JSON body — the assertions that care check status only */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  test('methods other than GET and POST are still rejected', async () => {
    expect((await request('PUT', '/chats')).status).toBe(405)
    expect((await request('DELETE', '/chats')).status).toBe(405)
  })

  test('an unknown POST route is a 404, not a 405', async () => {
    expect((await request('POST', '/nope', {})).status).toBe(404)
  })

  test('with no scopes granted, a write route answers 403 and names the flag', async () => {
    const res = await request('POST', '/send', { chat_jid: '1@s.whatsapp.net', text: 'hi' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/--allow=send/)
  })

  test('a POST carrying an Origin header is refused before it reaches a handler', async () => {
    // The Host check can't catch a page that fetches 127.0.0.1 directly, and a
    // POST's side effect lands even though CORS hides the response.
    const res = await request(
      'POST',
      '/send',
      { chat_jid: '1@s.whatsapp.net', text: 'hi' },
      {
        origin: 'https://evil.example.com',
      },
    )
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/cross-origin/)
  })

  test('the Origin refusal outranks the missing-scope error', async () => {
    const res = await request('POST', '/group/create', { subject: 'x' }, { origin: 'null' })
    expect(res.body.error).toMatch(/cross-origin/)
  })

  test('a malformed JSON body is a 400', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/send',
          method: 'POST',
          headers: { Host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
        },
        (r) => resolve({ status: r.statusCode ?? 0 }),
      )
      req.on('error', reject)
      req.end('{ not json')
    })
    expect(res.status).toBe(400)
  })

  test('a JSON array body is rejected — handlers expect an object', async () => {
    expect((await request('POST', '/send', ['a', 'b'])).status).toBe(400)
  })

  test('an oversized body is refused rather than buffered', async () => {
    const res = await request('POST', '/send', { chat_jid: '1@s.whatsapp.net', text: 'x'.repeat(1_200_000) })
    expect(res.status).toBe(413)
  })

  test('GET /permissions reports read-only by default', async () => {
    const res = await request('GET', '/permissions')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ read_only: true, scopes: [] })
  })

  test('GET /status embeds the same permissions block', async () => {
    const res = await request('GET', '/status')
    expect(res.body.permissions.read_only).toBe(true)
  })
})

describe('bridge token enforcement', () => {
  // A separate server instance, started only after ensureBridgeToken() has
  // written a token to disk — getBridgeToken() re-reads that file on every
  // request, so this also verifies the "already-running bridge picks it up
  // without a restart" property the token generation comment relies on.
  let tokenServer: http.Server
  let tokenPort: number
  let token: string

  beforeAll(async () => {
    const { ensureBridgeToken } = await import('../shared/config.js')
    token = ensureBridgeToken()
    const { startServer } = await import('./server.js')
    tokenServer = startServer({ port: 0 })
    await new Promise<void>((resolve) => tokenServer.once('listening', resolve))
    const addr = tokenServer.address()
    if (!addr || typeof addr === 'string') throw new Error('expected a bound TCP address')
    tokenPort = addr.port
  })

  afterAll(() => {
    tokenServer.close()
  })

  function requestWithAuth(authorization?: string, path = '/status'): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Host: `127.0.0.1:${tokenPort}` }
      if (authorization) headers.authorization = authorization
      const req = http.request({ host: '127.0.0.1', port: tokenPort, path, headers }, (res) =>
        resolve(res.statusCode ?? 0),
      )
      req.on('error', reject)
      req.end()
    })
  }

  test('rejects requests with no Authorization header', async () => {
    expect(await requestWithAuth()).toBe(401)
  })

  test('rejects requests with the wrong token', async () => {
    expect(await requestWithAuth('Bearer wrong-token')).toBe(401)
  })

  test('accepts requests with the right token', async () => {
    expect(await requestWithAuth(`Bearer ${token}`)).toBe(200)
  })

  test('accepts the token as a ?token= query param too (the dashboard uses this)', async () => {
    expect(await requestWithAuth(undefined, `/status?token=${token}`)).toBe(200)
  })

  test('rejects the wrong token in a ?token= query param', async () => {
    expect(await requestWithAuth(undefined, '/status?token=wrong-token')).toBe(401)
  })
})
