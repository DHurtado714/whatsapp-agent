#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
// biome-ignore lint: JSON import, needed at runtime for --version and doctor.
import pkg from '../../package.json' with { type: 'json' }
import { DISCLAIMER } from '../shared/disclaimer.js'

const VERSION: string = pkg.version

const HELP = `whatsapp-agent v${VERSION}

Read-only WhatsApp bridge + MCP server, so AI agents can read your chats.

Usage: whatsapp-agent <command> [options]

Commands:
  setup              Interactive setup wizard (link WhatsApp, register your
                      MCP client, install the background service)
  bridge              Start the daemon that keeps WhatsApp linked and syncs
                      chats/messages into SQLite. Run "whatsapp-agent bridge
                      --help" for its own options (--pair, --login).
  mcp                 Start the MCP server over stdio. This is what your AI
                      client (Claude Code, Claude Desktop, ...) should run —
                      not something you run by hand.
  status [--json]     Show whether the bridge is connected and what's stored.
  service <action>    Manage the background service: install, uninstall,
                       start, stop, restart, status, logs.
  logout [--purge] [--yes]
                       Remove the linked WhatsApp session (forces a fresh QR
                       next time). --purge also deletes all stored messages.
  doctor [--json]     Print diagnostic info, useful for bug reports.

  -h, --help          Show this help.
  -v, --version        Print the version.

${DISCLAIMER}
`

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return
  }

  switch (command) {
    case 'bridge': {
      const { runBridge } = await import('../bridge/index.js')
      await runBridge(rest)
      return
    }

    case 'mcp': {
      // stdio JSON-RPC breaks on a single stray byte on stdout. Redirect the
      // console.* family to stderr before importing anything, in case a
      // dependency (not just our own code) logs there.
      const toStderr = (...args: unknown[]) => {
        process.stderr.write(`${args.map(String).join(' ')}\n`)
      }
      console.log = toStderr
      console.info = toStderr
      console.debug = toStderr
      console.warn = toStderr

      const { main: runMcp } = await import('../mcp/index.js')
      await runMcp()
      return
    }

    case 'status':
      await runStatus(rest)
      return

    case 'doctor':
      await runDoctor(rest)
      return

    case 'logout':
      await runLogout(rest)
      return

    case 'setup': {
      const { runSetup } = await import('../setup/index.js')
      await runSetup(rest)
      return
    }

    case 'service':
      await runService(rest)
      return

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
      process.exit(1)
  }
}

// ---------------------------------------------------------------- status

async function runStatus(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const { BRIDGE_URL } = await import('../shared/config.js')

  let res: Response
  try {
    res = await fetch(new URL('/status', BRIDGE_URL), { signal: AbortSignal.timeout(5000) })
  } catch (err) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ reachable: false, error: String(err) })}\n`)
    } else {
      process.stderr.write(
        `Could not reach the bridge at ${BRIDGE_URL}.\n` +
          `Start it with "whatsapp-agent bridge" (or check "whatsapp-agent service status" ` +
          `if you installed it as a background service).\n`
      )
    }
    process.exit(1)
    return
  }

  const data = (await res.json()) as any
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
    return
  }

  const lines = [
    `Connection: ${data.connection}${data.registered ? '' : ' (not linked yet)'}`,
    data.me ? `Account: ${data.me.name ?? '(no name)'} — ${data.me.id}` : 'Account: not linked',
    `Stored locally: ${data.stored.chats} chats, ${data.stored.messages} messages, ${data.stored.contacts} contacts`,
    `History sync: ${data.history_sync.complete ? 'complete' : 'in progress'} (${data.history_sync.received} messages received)`,
    data.last_error ? `Last error: ${data.last_error}` : null
  ].filter(Boolean)
  process.stdout.write(`${lines.join('\n')}\n`)
}

// ---------------------------------------------------------------- doctor

async function runDoctor(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const { DATA_DIR, AUTH_DIR, DB_PATH, BRIDGE_URL } = await import('../shared/config.js')

  const report: Record<string, unknown> = {
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version
  }

  // SQLite / FTS5
  try {
    const probe = new Database(':memory:', { strict: true })
    report.sqlite_version = (probe.query('SELECT sqlite_version() v').get() as { v: string }).v
    try {
      probe.exec('CREATE VIRTUAL TABLE t USING fts5(x)')
      report.fts5 = true
    } catch {
      report.fts5 = false
    }
    probe.close()
  } catch (err) {
    report.sqlite_error = err instanceof Error ? err.message : String(err)
  }

  // Data directory
  report.data_dir = DATA_DIR
  report.data_dir_exists = fs.existsSync(DATA_DIR)
  report.auth_present = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0
  if (fs.existsSync(DB_PATH)) {
    report.store_db_bytes = fs.statSync(DB_PATH).size
    try {
      const { counts, getMeta } = await import('../shared/db.js')
      report.stored = counts()
      report.me_jid = getMeta('me_jid')
      report.history_sync_complete = getMeta('history_sync_complete_at') !== null
    } catch (err) {
      report.db_error = err instanceof Error ? err.message : String(err)
    }
  } else {
    report.stored = null
  }

  // Bridge reachability
  report.bridge_url = BRIDGE_URL
  try {
    const res = await fetch(new URL('/status', BRIDGE_URL), { signal: AbortSignal.timeout(3000) })
    const body = (await res.json()) as any
    report.bridge_reachable = true
    report.bridge_connection = body.connection
  } catch {
    report.bridge_reachable = false
  }

  // Background service
  try {
    const svc = await import('../service/index.js')
    report.service = await svc.serviceStatus()
  } catch (err) {
    report.service_error = err instanceof Error ? err.message : String(err)
  }

  // Which MCP clients have a whatsapp entry, and whether its command still
  // exists on disk — catches "I moved/reinstalled the binary and forgot to
  // re-run setup" as a clear diagnosis instead of a silent tool failure.
  try {
    const { listClientTargets } = await import('../setup/clients.js')
    const targets = await listClientTargets()
    const clients: Array<{ id: string; registered: boolean; commandExists?: boolean }> = []
    for (const t of targets) {
      if (!t.configPath) continue
      const file = Bun.file(t.configPath)
      if (!(await file.exists())) continue
      try {
        const cfg = JSON.parse(await file.text())
        const entry = cfg?.mcpServers?.whatsapp
        if (entry?.command) {
          clients.push({ id: t.id, registered: true, commandExists: fs.existsSync(entry.command) })
        }
      } catch {
        /* unparseable config — not our concern here, jsonConfig.ts refuses to touch it */
      }
    }
    report.mcp_clients = clients
  } catch (err) {
    report.mcp_clients_error = err instanceof Error ? err.message : String(err)
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const service = report.service as { platform: string; installed: boolean; running: boolean } | undefined
  const mcpClients = (report.mcp_clients as Array<{ id: string; registered: boolean; commandExists?: boolean }>) ?? []

  const lines = [
    `whatsapp-agent v${report.version} (${report.platform}/${report.arch}, bun ${report.bun})`,
    `SQLite: ${report.sqlite_version ?? report.sqlite_error} (FTS5: ${report.fts5 ? 'yes' : 'no'})`,
    `Data dir: ${report.data_dir} (${report.data_dir_exists ? 'exists' : 'missing'})`,
    `Session linked: ${report.auth_present ? 'yes' : 'no'}${report.me_jid ? ` — ${report.me_jid}` : ''}`,
    report.stored
      ? `Stored: ${(report.stored as any).chats} chats, ${(report.stored as any).messages} messages, ${(report.stored as any).contacts} contacts (${Math.round(Number(report.store_db_bytes ?? 0) / 1e6)} MB)`
      : 'Stored: no database yet',
    `History sync complete: ${report.history_sync_complete ? 'yes' : 'no'}`,
    `Bridge (${report.bridge_url}): ${report.bridge_reachable ? `reachable, connection=${report.bridge_connection}` : 'not reachable'}`,
    service
      ? `Background service: ${service.installed ? `installed (${service.platform}), ${service.running ? 'running' : 'not running'}` : 'not installed'}`
      : `Background service: ${report.service_error}`,
    mcpClients.length > 0
      ? `MCP clients registered: ${mcpClients.map((c) => `${c.id}${c.commandExists === false ? ' (binary path missing!)' : ''}`).join(', ')}`
      : 'MCP clients registered: none found'
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

// ---------------------------------------------------------------- logout

async function runLogout(argv: string[]): Promise<void> {
  const purge = argv.includes('--purge')
  const skipConfirm = argv.includes('--yes')
  const { AUTH_DIR, DB_PATH } = await import('../shared/config.js')

  if (!fs.existsSync(AUTH_DIR) && !fs.existsSync(DB_PATH)) {
    process.stdout.write('Nothing to do — no linked session or stored data found.\n')
    return
  }

  const what = purge
    ? 'delete your linked session AND all stored messages'
    : 'delete your linked session (stored messages are kept)'
  process.stdout.write(
    `This will ${what}.\n` +
      `${purge ? `Database: ${DB_PATH}\n` : ''}Auth: ${AUTH_DIR}\n`
  )

  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      process.stderr.write('Not a TTY — pass --yes to confirm non-interactively.\n')
      process.exit(1)
    }
    const answer = prompt('Type "yes" to continue:')
    if (answer?.trim().toLowerCase() !== 'yes') {
      process.stdout.write('Aborted.\n')
      return
    }
  }

  fs.rmSync(AUTH_DIR, { recursive: true, force: true })
  if (purge) {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${DB_PATH}${suffix}`, { force: true })
    }
  }
  process.stdout.write(
    purge
      ? 'Done. Session and stored messages deleted.\n'
      : 'Done. Session deleted — stored messages were kept. Run "whatsapp-agent bridge" to link again.\n'
  )
}

// ---------------------------------------------------------------- service

async function runService(argv: string[]): Promise<void> {
  const [action, ...rest] = argv
  const svc = await import('../service/index.js')

  switch (action) {
    case 'install': {
      const result = await svc.installService({ WA_LOG_LEVEL: process.env.WA_LOG_LEVEL ?? 'info' })
      process.stdout.write(`Installed (${result.platform}): ${result.path}\n`)
      if (result.platform === 'systemd' && result.lingerEnabled === false) {
        process.stdout.write(
          '⚠ Could not enable linger for your user — the service will stop when you log out.\n' +
            `Run "sudo loginctl enable-linger ${process.env.USER ?? '<user>'}" to fix that.\n`
        )
      }
      return
    }
    case 'uninstall':
      await svc.uninstallService()
      process.stdout.write('Uninstalled. Stored data was not touched.\n')
      return
    case 'start':
      await svc.startService()
      process.stdout.write('Started.\n')
      return
    case 'stop':
      await svc.stopService()
      process.stdout.write('Stopped.\n')
      return
    case 'restart':
      await svc.restartService()
      process.stdout.write('Restarted.\n')
      return
    case 'status': {
      const s = await svc.serviceStatus()
      if (!s.installed) {
        process.stdout.write(`Not installed (platform: ${s.platform}).\n`)
      } else {
        process.stdout.write(`Installed (${s.platform}), ${s.running ? 'running' : 'not running'}.\n`)
      }
      return
    }
    case 'logs': {
      const follow = rest.includes('-f') || rest.includes('--follow')
      for await (const chunk of svc.tailLogs(follow)) process.stdout.write(chunk)
      return
    }
    default:
      process.stderr.write(
        'Usage: whatsapp-agent service <install|uninstall|start|stop|restart|status|logs [-f]>\n'
      )
      process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`whatsapp-agent failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
