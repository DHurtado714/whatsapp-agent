import { start, state, stop } from '../bridge/socket.js'

export type LinkOutcome = { connected: boolean; timedOut?: boolean }

export type LinkCallbacks = {
  onQr?: (qr: string, attempt: number) => void
  onPairingCode?: (code: string) => void
  /** Fired after 3 consecutive disconnects with no successful open — the Baileys #2677 symptom. */
  onRepeatedFailure?: (closeCount: number) => void
}

/**
 * Drives socket.ts's start() (the same code path the bridge daemon uses,
 * not a parallel implementation) until the connection opens or
 * connectTimeoutMs elapses, polling `state` rather than subscribing to raw
 * Baileys events directly.
 */
export async function linkAccount(
  opts: { pairWithNumber?: string; connectTimeoutMs?: number } & LinkCallbacks = {},
): Promise<LinkOutcome> {
  const timeoutMs = opts.connectTimeoutMs ?? 3 * 60_000
  const deadline = Date.now() + timeoutMs

  let lastSeenQr: string | null = null
  let qrAttempts = 0
  let pairingCodeSeen = false
  let closeCount = 0
  let everOpened = false
  let repeatedFailureReported = false

  await start({
    pairWithNumber: opts.pairWithNumber,
    printQr: false, // the wizard renders the QR itself via onQr, not socket.ts's own stderr QR art
  })

  return new Promise<LinkOutcome>((resolve) => {
    const interval = setInterval(() => {
      if (state.qr && state.qr !== lastSeenQr) {
        lastSeenQr = state.qr
        qrAttempts += 1
        opts.onQr?.(state.qr, qrAttempts)
      }
      if (state.pairingCode && !pairingCodeSeen) {
        pairingCodeSeen = true
        opts.onPairingCode?.(state.pairingCode)
      }
      if (state.connection === 'close' && !everOpened) {
        closeCount += 1
        if (closeCount >= 3 && !repeatedFailureReported) {
          repeatedFailureReported = true
          opts.onRepeatedFailure?.(closeCount)
        }
      }
      if (state.connection === 'open') {
        everOpened = true
        clearInterval(interval)
        resolve({ connected: true })
        return
      }
      if (Date.now() > deadline) {
        clearInterval(interval)
        resolve({ connected: false, timedOut: true })
      }
    }, 400)
  })
}

export type HistorySyncOutcome = { complete: boolean; received: number }

/**
 * Waits for history sync to finish, or for `idleTimeoutMs` to pass with no
 * new messages arriving — WhatsApp doesn't reliably emit a "complete"
 * status, so a pure completion-event wait can hang forever.
 */
export async function waitForHistorySync(
  opts: {
    idleTimeoutMs?: number
    onProgress?: (s: { received: number; progress: number | null; complete: boolean }) => void
  } = {},
): Promise<HistorySyncOutcome> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 90_000
  let lastReceived = state.historySync.received
  let lastProgressAt = Date.now()

  return new Promise<HistorySyncOutcome>((resolve) => {
    const interval = setInterval(() => {
      opts.onProgress?.(state.historySync)
      if (state.historySync.received !== lastReceived) {
        lastReceived = state.historySync.received
        lastProgressAt = Date.now()
      }
      if (state.historySync.complete) {
        clearInterval(interval)
        resolve({ complete: true, received: state.historySync.received })
        return
      }
      if (Date.now() - lastProgressAt > idleTimeoutMs) {
        clearInterval(interval)
        resolve({ complete: false, received: state.historySync.received })
      }
    }, 500)
  })
}

/** Stop the in-process Baileys socket the wizard opened for linking. */
export function stopLinking(): void {
  stop()
}
