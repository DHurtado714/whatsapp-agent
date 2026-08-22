import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { bridgeGet } from '../mcp/client.js'
import { installService, resolveSelfPath, serviceStatus, startService } from '../service/index.js'
import { buildMcpEntry, registerAllClients } from '../setup/register.js'
import { BRIDGE_URL, DATA_DIR, ensureBridgeToken, ensureDataDir } from '../shared/config.js'

const VERSION: string = pkg.version
const LOG_PATH = path.join(DATA_DIR, 'logs', 'app.log')
const STAGED_DIR = path.join(DATA_DIR, 'bin')
const STAGED_BIN_PATH = path.join(STAGED_DIR, 'whatsapp-agent')
const STAGED_VERSION_PATH = path.join(STAGED_DIR, '.version')

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function appendLog(line: string): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* best effort — there's nowhere else to report this */
  }
}

/**
 * A LaunchServices-started process gets PATH=/usr/bin:/bin:/usr/sbin:/sbin —
 * without this, Bun.which('claude') in setup/clients.ts would always miss,
 * silently downgrading Claude Code registration to the ~/.claude.json merge
 * path and mis-reporting whether it's actually installed.
 */
function extendPath(): void {
  const home = os.homedir()
  const extra = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.bun', 'bin'),
  ]
  process.env.PATH = [process.env.PATH ?? '', ...extra].filter(Boolean).join(':')
}

/**
 * Copies the running binary to a fixed, app-independent path. The LaunchAgent
 * and every registered MCP client config store this path — if it instead
 * pointed inside the .app bundle, moving the app to /Applications or trashing
 * it after "installing" would silently break the bridge and every MCP
 * client next login (doctor's commandExists check exists for exactly this).
 * A fresh Bun.write does not inherit the source's quarantine xattr, and
 * temp+rename avoids overwriting a running executable's inode.
 */
async function stageBinary(): Promise<{ path: string; changed: boolean }> {
  const selfPath = resolveSelfPath()
  const size = fs.statSync(selfPath).size
  const marker = `${VERSION} ${size}`

  const currentMarker = fs.existsSync(STAGED_VERSION_PATH) ? fs.readFileSync(STAGED_VERSION_PATH, 'utf-8').trim() : null
  if (currentMarker === marker && fs.existsSync(STAGED_BIN_PATH)) {
    return { path: STAGED_BIN_PATH, changed: false }
  }

  fs.mkdirSync(STAGED_DIR, { recursive: true })
  const tmpPath = path.join(STAGED_DIR, `.whatsapp-agent.tmp-${process.pid}`)
  await Bun.write(tmpPath, Bun.file(selfPath))
  fs.chmodSync(tmpPath, 0o755)
  fs.renameSync(tmpPath, STAGED_BIN_PATH)
  try {
    Bun.spawnSync(['xattr', '-d', 'com.apple.quarantine', STAGED_BIN_PATH])
  } catch {
    /* best effort */
  }
  fs.writeFileSync(STAGED_VERSION_PATH, marker)
  return { path: STAGED_BIN_PATH, changed: true }
}

function openBrowser(url: string): void {
  try {
    Bun.spawn(['/usr/bin/open', url])
  } catch (err) {
    appendLog(`could not open the browser: ${errMsg(err)}`)
  }
}

/**
 * `display dialog` targets osascript itself — no permission prompt. Passing
 * the message through argv (rather than interpolating it into the script
 * text) avoids AppleScript quoting/injection entirely. Deliberately not
 * `tell application "System Events"`, which would trip TCC.
 */
async function notifyUser(message: string): Promise<void> {
  try {
    const proc = Bun.spawn(
      [
        '/usr/bin/osascript',
        '-e',
        'on run argv',
        '-e',
        'display dialog (item 1 of argv) with title "WhatsApp Agent" buttons {"OK"} default button "OK" with icon caution',
        '-e',
        'end run',
        '--',
        message,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    await proc.exited
  } catch {
    /* best effort — the message is already in app.log */
  }
}

async function fail(message: string): Promise<void> {
  appendLog(`ERROR: ${message}`)
  await notifyUser(`${message}\n\nDetails: ${LOG_PATH}`)
}

async function waitForBridgeReachable(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      await bridgeGet('/status')
      return true
    } catch {
      await Bun.sleep(300)
    }
  }
  return false
}

/** Entry point for the `app` CLI subcommand — what the macOS .app's launcher script execs. */
export async function runApp(): Promise<void> {
  extendPath()
  ensureDataDir()
  appendLog(`starting whatsapp-agent app v${VERSION}`)

  const token = ensureBridgeToken()

  let stagedPath: string
  let stagedChanged: boolean
  try {
    const staged = await stageBinary()
    stagedPath = staged.path
    stagedChanged = staged.changed
    if (stagedChanged) appendLog(`staged binary at ${stagedPath}`)
  } catch (err) {
    await fail(`Could not prepare whatsapp-agent: ${errMsg(err)}`)
    return
  }

  try {
    const status = await serviceStatus()
    if (!status.installed || stagedChanged) {
      const result = await installService({ WA_LOG_LEVEL: 'info' }, { binPath: stagedPath })
      appendLog(`${status.installed ? 'reinstalled' : 'installed'} service (${result.platform}): ${result.path}`)
    } else if (!status.running) {
      await startService()
      appendLog('started the background service')
    }
  } catch (err) {
    await fail(`Could not start the background service: ${errMsg(err)}`)
    return
  }

  // Before waiting for the bridge: the dashboard already degrades gracefully
  // and self-heals on its next poll, so the user sees something in under a
  // second instead of staring at nothing with no Dock icon to reassure them.
  openBrowser(`${BRIDGE_URL}/?token=${token}`)

  try {
    const entry = buildMcpEntry({ binPath: stagedPath, token })
    const { results } = await registerAllClients(entry)
    for (const r of results) {
      if (r.detected) appendLog(`MCP client ${r.label}: ${r.status}${r.error ? ` (${r.error})` : ''}`)
    }
  } catch (err) {
    appendLog(`MCP client registration failed: ${errMsg(err)}`)
  }

  const reachable = await waitForBridgeReachable(30_000)
  if (!reachable) {
    await fail(`whatsapp-agent started but the bridge never became reachable at ${BRIDGE_URL}.`)
    return
  }
  appendLog('bridge is reachable — done')
}
