import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import qrcode from 'qrcode-terminal'
import { DISCLAIMER, acceptDisclaimer, isDisclaimerAccepted } from '../shared/disclaimer.js'
import { listClientTargets, renderConfigSnippet } from './clients.js'
import { linkAccount, stopLinking, waitForHistorySync } from './link.js'
import { buildMcpEntry, registerAllClients } from './register.js'
import { verifyMcpEndToEnd } from './verify.js'

type SetupArgs = {
  yes: boolean
  pair?: string
  skipService: boolean
  skipMcp: boolean
  /** Preselected permission scopes, skipping the interactive question. */
  allow?: string
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
    else if (a === '--allow') args.allow = argv[++i] ?? ''
    else if (a.startsWith('--allow=')) args.allow = a.slice('--allow='.length)
    else if (a === '--allow-write') args.allow = 'all'
    else if (a === '--read-only' || a === '--readonly') args.allow = ''
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

const PERMISSION_CHOICES: Array<{ label: string; allow: string }> = [
  { label: 'Read only — the assistant can read your chats but never write (recommended to start)', allow: '' },
  { label: 'Read + send messages, replies, reactions, edits and deletions', allow: 'send' },
  { label: 'Read + send + files, and chat management (mark read, archive, pin, mute)', allow: 'send,media,chats' },
  { label: 'Everything, including creating groups and managing participants', allow: 'all' },
]

/**
 * Read-only is the default on every path: pressing enter, --yes, and a
 * non-TTY run all land there. Granting an assistant the ability to message
 * real people should take a deliberate keystroke.
 */
function askPermissions(autoYes: boolean): string {
  say('\n== What may your AI assistant do? ==')
  say('Reading your chats is always allowed. Writing is off unless you turn it on here.')
  say('You can change this later with "whatsapp-agent bridge --allow=..." or WA_ALLOW.\n')
  PERMISSION_CHOICES.forEach((choice, i) => say(`  ${i + 1}) ${choice.label}`))
  say('')

  if (autoYes || !process.stdin.isTTY) {
    say('(non-interactive — defaulting to read only; pass --allow=send,media,chats,groups to change it)')
    return ''
  }
  const answer = prompt('Choose [1-4] (default 1):')?.trim()
  if (!answer) return ''
  const index = Number(answer)
  if (!Number.isInteger(index) || index < 1 || index > PERMISSION_CHOICES.length) {
    say(`"${answer}" isn't one of the options — staying read only.`)
    return ''
  }
  return PERMISSION_CHOICES[index - 1].allow
}

export async function runSetup(argv: string[]): Promise<void> {
  const args = parseArgs(argv)

  // ---------------------------------------------------------- 0. disclaimer
  if (isDisclaimerAccepted()) {
    say('(disclaimer already accepted — skipping)')
  } else {
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
    acceptDisclaimer('cli')
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

  // ---------------------------------------------------------- 2. permissions
  // Asked before anything else happens, and applied by writing WA_ALLOW into
  // this process's env: the temporary bridge started below, the MCP client
  // entry we register, the installed service, and the `mcp` child process the
  // verify step spawns all read it from there, so they can't disagree.
  const allow = args.allow ?? askPermissions(args.yes)
  if (allow) {
    process.env.WA_ALLOW = allow
  } else {
    // Actually unset it: assigning undefined would store the string "undefined".
    // biome-ignore lint/performance/noDelete: process.env needs a real delete
    delete process.env.WA_ALLOW
  }
  const { setPermissions } = await import('../bridge/actions.js')
  const { describePermissions, resolvePermissions, scopeList } = await import('../shared/permissions.js')
  const permissions = resolvePermissions()
  setPermissions(permissions)
  say(`✓ Permissions: ${describePermissions(permissions)}`)

  let bridgeAlreadyRunning = false
  try {
    // Through bridgeGet so the bearer token is sent: a bare fetch gets a 401
    // from any install that already ran setup, which would look like "no
    // bridge running" and then collide on the port when we start our own.
    const { bridgeGet } = await import('../mcp/client.js')
    const running = await bridgeGet<{ permissions?: { scopes: string[] } }>('/status')
    bridgeAlreadyRunning = true
    say(`✓ A bridge is already running at ${BRIDGE_URL} — reusing it.`)

    // That bridge was started with whatever scopes it was given, and this
    // wizard can't change them from here. Say so now, rather than letting the
    // first write fail with a 403 that looks like a bug.
    const runningScopes = (running.permissions?.scopes ?? []).join(',')
    const chosenScopes = scopeList(permissions).join(',')
    if (runningScopes !== chosenScopes) {
      say(
        `⚠ The running bridge is ${runningScopes ? `granting: ${runningScopes}` : 'read-only'}, ` +
          `which doesn't match what you just chose (${chosenScopes || 'read-only'}).`,
      )
      say('  Restart it to pick up the new setting: "whatsapp-agent service restart"')
      say('  (or stop it and run "whatsapp-agent bridge" yourself with the flags you want).')
    }
  } catch {
    /* nothing listening, we'll start it below */
  }

  // ---------------------------------------------------------- 3. link
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

  // ---------------------------------------------------------- 4. register MCP clients
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
    const { ensureBridgeToken } = await import('../shared/config.js')
    const token = ensureBridgeToken()
    const entry = buildMcpEntry({ binPath, token, allow })

    const { results, targets } = await registerAllClients(entry, {
      confirmTarget: (target) =>
        confirm(`Register with ${target.label}${target.configPath ? ` (${target.configPath})` : ''}?`, args.yes),
      confirmOverwrite: () => confirm('  already has a different whatsapp MCP entry. Overwrite it?', args.yes, false),
    })

    if (targets.every((t) => !t.detected)) {
      say('No supported AI client was auto-detected. Add this to its MCP config manually:\n')
      say(renderConfigSnippet(entry))
    }
    for (const result of results) {
      if (!result.detected) {
        say(`  (${result.label} not detected — skipping)`)
        continue
      }
      switch (result.status) {
        case 'created':
          say(`  ✓ ${result.label}: created config and registered whatsapp`)
          break
        case 'updated':
          say(`  ✓ ${result.label}: registered whatsapp (backup: ${result.backupPath})`)
          break
        case 'already-configured':
          say(`  ✓ ${result.label}: already configured`)
          break
        case 'declined':
          say(`  skipped ${result.label}`)
          break
        case 'parse-error':
          say(`  ✗ ${result.label}: ${result.error} — leaving it untouched, register manually:`)
          say(renderConfigSnippet(entry))
          break
      }
    }
  }

  // ---------------------------------------------------------- 5. background service
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
          const result = await svc.installService({ WA_LOG_LEVEL: 'info', ...(allow ? { WA_ALLOW: allow } : {}) })
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

  // ---------------------------------------------------------- 6. verify
  say('\n== Verifying ==')
  const verifyResult = await verifyMcpEndToEnd()
  if (verifyResult.ok) {
    say(`✓ MCP server responds correctly (${verifyResult.toolCount} tools, connection=${verifyResult.connection}).`)
  } else {
    say(`✗ Verification failed: ${verifyResult.error}`)
  }

  // ---------------------------------------------------------- 7. cleanup + summary
  if (!bridgeAlreadyRunning) {
    stopLinking()
    server?.close()
  }

  say('\n== Done ==')
  say(`Data directory: ${DATA_DIR}`)
  say(`Permissions: ${describePermissions(permissions)}`)
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
