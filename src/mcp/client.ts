import { BRIDGE_TOKEN, BRIDGE_URL } from '../shared/config.js'

export class BridgeUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `No pude conectarme al bridge de WhatsApp en ${BRIDGE_URL}. ` +
        `Arrancalo con "wa-bridge" (o "npm run bridge") y volve a intentar. ` +
        `Detalle: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'BridgeUnavailableError'
  }
}

export async function bridgeGet<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  const url = new URL(path, BRIDGE_URL)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    url.searchParams.set(k, String(v))
  }

  let res: Response
  try {
    res = await fetch(url, {
      headers: BRIDGE_TOKEN ? { authorization: `Bearer ${BRIDGE_TOKEN}` } : {},
      signal: AbortSignal.timeout(20_000)
    })
  } catch (err) {
    throw new BridgeUnavailableError(err)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`bridge respondio ${res.status}: ${body.slice(0, 500)}`)
  }
  return (await res.json()) as T
}
