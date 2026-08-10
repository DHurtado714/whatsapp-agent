import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

let server: http.Server
let port: number

beforeAll(async () => {
  process.env.WA_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-server-test-'))
  process.env.WA_BRIDGE_PORT = '0'
  const { startServer } = await import('./server.js')
  server = startServer()
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
    tokenServer = startServer()
    await new Promise<void>((resolve) => tokenServer.once('listening', resolve))
    const addr = tokenServer.address()
    if (!addr || typeof addr === 'string') throw new Error('expected a bound TCP address')
    tokenPort = addr.port
  })

  afterAll(() => {
    tokenServer.close()
  })

  function requestWithAuth(authorization?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Host: `127.0.0.1:${tokenPort}` }
      if (authorization) headers.authorization = authorization
      const req = http.request({ host: '127.0.0.1', port: tokenPort, path: '/status', headers }, (res) =>
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
})
