import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import qrcode from 'qrcode-terminal'
import { DISCLAIMER } from '../shared/disclaimer.js'
import { type McpServerEntry, listClientTargets, renderConfigSnippet } from './clients.js'
import { linkAccount, stopLinking, waitForHistorySync } from './link.js'
import { verifyMcpEndToEnd } from './verify.js'

type SetupArgs = {
  yes: boolean
  pair?: string
  skipService: boolean
  skipMcp: boolean
}

function parseArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { yes: false, skipService: false, skipMcp: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') args.yes = true
    else if (a === '--pair') args.pair = (argv[++i] ?? '').replace(/\D/g, '')
    else if (a.startsWith('--pair=')) args.pair = a.slice('--pair='.length).replace(/\D/g, '')
    else if (a === '--skip-service') args.skipService = true
    else if (a === '--skip-mcp') args.skipMcp = true
  }
  return args
}

function say(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function confirm(question: string, autoYes: boolean, defaultYes = true): boolean {
  if (autoYes) return true
  if (!process.stdin.isTTY) {
    say(`${question} — not a TTY, assuming ${defaultYes ? 'yes' : 'no'}. Pass --yes to silence this.`)
    return defaultYes
  }
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = prompt(`${question} ${suffix}`)?.trim().toLowerCase()
  if (!answer) return defaultYes
  return answer === 'y' || answer === 'yes'
}

export async function runSetup(argv: string[]): Promise<void> {
  const args = parseArgs(argv)

  // ---------------------------------------------------------- 0. disclaimer
  say(`\n${DISCLAIMER}\n`)
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      say('Not a TTY — pass --yes to accept the above and run non-interactively.')
      process.exit(1)
    }
    const answer = prompt('Type "yes" to continue:')
    if (answer?.trim().toLowerCase() !== 'yes') {
      say('Aborted.')
      return
    }
  }

  const { DATA_DIR, AUTH_DIR, BRIDGE_URL, BRIDGE_PORT } = await import('../shared/config.js')

  // ---------------------------------------------------------- 1. preflight
  say('\n== Checking your system ==')
  if (os.platform() !== 'darwin' && os.platform() !== 'linux') {
    say(`✗ ${os.platform()} is not supported yet (macOS and Linux only).`)
    process.exit(1)
  }
  say(`✓ Platform: ${os.platform()}/${os.arch()}`)

  try {
    const { getDb } = await import('../shared/db.js')
    getDb() // also runs pending migrations, applies to the real data dir
    say(`✓ Database ready at ${DATA_DIR}`)
  } catch (err) {
    say(`✗ Could not open the local database: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  let bridgeAlreadyRunning = false
  try {
    const res = await fetch(new URL('/status', BRIDGE_URL), { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      bridgeAlreadyRunning = true
      say(`✓ A bridge is already running at ${BRIDGE_URL} — reusing it.`)
    }
  } catch {
    /* nothing listening, we'll start it below */
  }

  // ---------------------------------------------------------- 2. link
  const alreadyRegistered = fs.existsSync(path.join(AUTH_DIR, 'creds.json'))
  const server = bridgeAlreadyRunning ? null : (await import('../bridge/server.js')).startServer()

  if (alreadyRegistered && !bridgeAlreadyRunning) {
    say('\n== Reusing your existing WhatsApp session ==')
    // Still need the socket connected for the rest of setup (client
    // registration + the final verify step both need a live bridge).
  } else if (!bridgeAlreadyRunning) {
    say('\n== Linking WhatsApp ==')
    if (args.pair) {
      say(`Requesting a pairing code for +${args.pair}...`)
    } else {
      say('Scan this QR from your phone: WhatsApp > Settings > Linked devices > Link a device\n')
    }

    const outcome = await linkAccount({
      pairWithNumber: args.pair,
      onQr: (qr, attempt) => {
        if (attempt > 1) say(`\nQR expired, here's a new one (attempt ${attempt}):\n`)
        qrcode.generate(qr, { small: true }, (art) => say(art))
      },
      onPairingCode: (code) => {
        say(`\nPairing code: ${code}`)
        say('On your phone: Linked devices > Link a device > Link with phone number instead\n')
      },
      onRepeatedFailure: () => {
        say(
          '\n⚠ Several attempts failed without connecting. If this keeps looping, WhatsApp may be ' +
            'rejecting the reported client identity — try setting WA_BROWSER=ubuntu and running ' +
            '"whatsapp-agent setup" again. See the README troubleshooting section for details.\n',
        )
      },
    })

    if (!outcome.connected) {
      say('✗ Could not link within the time limit. Run "whatsapp-agent setup" again to retry.')
      server?.close()
      process.exit(1)
    }
    say('✓ Linked successfully.')
  }

  if (!bridgeAlreadyRunning) {
    say('\n== Syncing message history ==')
    say('(this can take a few minutes — WhatsApp decides how much history to send)')
    let lastLine = ''
    const syncOutcome = await waitForHistorySync({
      onProgress: (s) => {
        const line = `  ${s.received.toLocaleString()} messages received${s.progress != null ? ` (${s.progress}%)` : ''}`
        if (line !== lastLine) {
          process.stdout.write(`\r${line}`)
          lastLine = line
        }
      },
    })
    say('')
    if (syncOutcome.complete) {
      say(`✓ History sync complete (${syncOutcome.received.toLocaleString()} messages).`)
    } else {
      say(
        `⚠ Sync is still going after a while (${syncOutcome.received.toLocaleString()} messages so far). ` +
          'It will keep running in the background — continuing setup.',
      )
    }
  }

  // ---------------------------------------------------------- 3. register MCP clients
  if (!args.skipMcp) {
    say('\n== Registering with your AI tools ==')
    const { resolveSelfPath } = await import('../service/index.js')
    let binPath: string
    try {
      binPath = resolveSelfPath()
    } catch {
      binPath = process.execPath
      say('(running from source — the registered command will only work from this checkout)')
    }
    const entry: McpServerEntry = { command: binPath, args: ['mcp'] }

    const targets = await listClientTargets()
    const detected = targets.filter((t) => t.detected && t.register)
    if (detected.length === 0) {
      say('No supported AI client was auto-detected. Add this to its MCP config manually:\n')
      say(renderConfigSnippet(entry))
    }
    for (const target of detected) {
      const proceed = confirm(
        `Register with ${target.label}${target.configPath ? ` (${target.configPath})` : ''}?`,
        args.yes,
      )
      if (!proceed) {
        say(`  skipped ${target.label}`)
        continue
      }
      const result = await target.register!(entry, {
        confirmChange: (current, desired) =>
          confirm(`  ${target.label} already has a different whatsapp MCP entry. Overwrite it?`, args.yes, false),
      })
      switch (result.status) {
        case 'created':
          say(`  ✓ ${target.label}: created config and registered whatsapp`)
          break
        case 'updated':
          say(`  ✓ ${target.label}: registered whatsapp (backup: ${result.backupPath})`)
          break
        case 'already-configured':
          say(`  ✓ ${target.label}: already configured`)
          break
        case 'declined':
          say(`  skipped ${target.label} (kept existing entry)`)
          break
        case 'parse-error':
          say(`  ✗ ${target.label}: ${result.error} — leaving it untouched, register manually:`)
          say(renderConfigSnippet(entry))
          break
      }
    }
    for (const target of targets.filter((t) => !t.detected)) {
      say(`  (${target.label} not detected — skipping)`)
    }
  }

  // ---------------------------------------------------------- 4. background service
  let serviceInstalled = false
  if (!args.skipService) {
    say('\n== Background service ==')
    const svc = await import('../service/index.js')
    const platform = svc.detectPlatform()
    if (platform === 'unsupported') {
      say('No supported service manager on this platform (need launchd or systemd --user).')
      say('Run "whatsapp-agent bridge" yourself whenever you want it active.')
    } else {
      const install = confirm(
        `Install whatsapp-agent as a background service (${platform}), so it starts automatically?`,
        args.yes,
      )
      if (install) {
        try {
          const result = await svc.installService({ WA_LOG_LEVEL: 'info' })
          serviceInstalled = true
          say(`✓ Installed (${result.platform}): ${result.path}`)
          if (result.platform === 'systemd' && result.lingerEnabled === false) {
            say(
              '⚠ Could not enable linger for your user — the service will stop when you log out. ' +
                `Run "sudo loginctl enable-linger ${os.userInfo().username}" to fix that.`,
            )
          }
        } catch (err) {
          say(`✗ Could not install the service: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        say('Skipped. Run "whatsapp-agent service install" later if you change your mind.')
      }
    }
  }

  // ---------------------------------------------------------- 5. verify
  say('\n== Verifying ==')
  const verifyResult = await verifyMcpEndToEnd()
  if (verifyResult.ok) {
    say(`✓ MCP server responds correctly (${verifyResult.toolCount} tools, connection=${verifyResult.connection}).`)
  } else {
    say(`✗ Verification failed: ${verifyResult.error}`)
  }

  // ---------------------------------------------------------- 6. cleanup + summary
  if (!bridgeAlreadyRunning) {
    stopLinking()
    server?.close()
  }

  say('\n== Done ==')
  say(`Data directory: ${DATA_DIR}`)
  say(`Bridge API: ${BRIDGE_URL} (port ${BRIDGE_PORT})`)
  if (serviceInstalled) {
    say('The bridge is running in the background and will start automatically from now on.')
    say('Check on it any time with "whatsapp-agent status" or "whatsapp-agent service logs".')
  } else if (!bridgeAlreadyRunning) {
    say('Start it whenever you want to use it: "whatsapp-agent bridge" (leave that terminal open),')
    say('or run "whatsapp-agent service install" to have it start automatically.')
  }
  say('\nTry asking your AI assistant something like: "What did I talk about with X last week?"')
}
