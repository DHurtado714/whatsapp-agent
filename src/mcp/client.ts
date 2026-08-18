import { BRIDGE_URL, getBridgeToken } from '../shared/config.js'

export class BridgeUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not connect to the WhatsApp bridge at ${BRIDGE_URL}. ` +
        `Start it with "whatsapp-agent bridge" and try again. ` +
        `Detail: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'BridgeUnavailableError'
  }
}

/**
 * A non-2xx answer from the bridge. The bridge already phrases its errors for
 * a human (and names the flag to add when a permission is missing), so the
 * message is surfaced as-is rather than wrapped in HTTP jargon.
 */
export class BridgeRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'BridgeRequestError'
    this.status = status
  }
}

async function toError(res: Response): Promise<BridgeRequestError> {
  const body = await res.text().catch(() => '')
  let message = body.slice(0, 500)
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed.error === 'string') message = parsed.error
  } catch {
    /* not JSON — fall back to the raw body */
  }
  return new BridgeRequestError(res.status, message || `bridge responded ${res.status}`)
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const bridgeToken = getBridgeToken()
  return bridgeToken ? { authorization: `Bearer ${bridgeToken}`, ...extra } : extra
}

export async function bridgeGet<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  const url = new URL(path, BRIDGE_URL)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    url.searchParams.set(k, String(v))
  }

  let res: Response
  try {
    res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(20_000) })
  } catch (err) {
    throw new BridgeUnavailableError(err)
  }

  if (!res.ok) throw await toError(res)
  return (await res.json()) as T
}

/**
 * Writes get a longer timeout than reads: sending media means the bridge has
 * to upload the file to WhatsApp's servers before it can answer.
 */
export async function bridgePost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const url = new URL(path, BRIDGE_URL)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err) {
    throw new BridgeUnavailableError(err)
  }

  if (!res.ok) throw await toError(res)
  return (await res.json()) as T
}
