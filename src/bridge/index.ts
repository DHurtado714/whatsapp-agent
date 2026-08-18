import { BRIDGE_URL, DATA_DIR, getBridgeToken } from '../shared/config.js'
import { PermissionConfigError, describePermissions, resolvePermissions } from '../shared/permissions.js'
import { setPermissions } from './actions.js'
import { startServer } from './server.js'
import { logger, start, state, stop } from './socket.js'

function parseArgs(argv: string[]) {
  const args = {
    pair: undefined as string | undefined,
    login: false,
    help: false,
    allow: undefined as string | undefined,
    allowWrite: false,
    readOnly: false,
    allowNewContacts: false,
    dryRun: false,
    rateLimit: undefined as number | undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pair') args.pair = (argv[++i] ?? '').replace(/\D/g, '')
    else if (a.startsWith('--pair=')) args.pair = a.slice('--pair='.length).replace(/\D/g, '')
    else if (a === '--login') args.login = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (a === '--allow') args.allow = argv[++i] ?? ''
    else if (a.startsWith('--allow=')) args.allow = a.slice('--allow='.length)
    else if (a === '--allow-write') args.allowWrite = true
    else if (a === '--read-only' || a === '--readonly') args.readOnly = true
    else if (a === '--allow-new-contacts') args.allowNewContacts = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--rate-limit') args.rateLimit = Number(argv[++i] ?? Number.NaN)
    else if (a.startsWith('--rate-limit=')) args.rateLimit = Number(a.slice('--rate-limit='.length))
  }
  return args
}

const HELP = `
whatsapp-agent bridge - daemon that keeps your WhatsApp session alive and saves everything to SQLite

  whatsapp-agent bridge                     start the daemon (QR in the terminal if there's no session)
  whatsapp-agent bridge --pair 15551234567  link with an 8-digit code instead of a QR
  whatsapp-agent bridge --login             just link and sync history, then keep running

Permissions (reading is always allowed; writing is opt-in, and off by default):
  --allow <scopes>     comma-separated: send, media, chats, groups (or "all")
                         send   - send, reply, react, edit and delete messages
                         media  - send images, video, audio and documents
                         chats  - mark read, archive, pin, mute, typing indicators
                         groups - create groups, manage participants, rename, leave
  --allow-write        shorthand for --allow all
  --read-only          force read-only, ignoring WA_ALLOW (useful to override a service env)
  --allow-new-contacts allow writing to numbers with no existing chat (off by default)
  --dry-run            accept write calls but only report what they would do
  --rate-limit <n>     max outbound messages per minute (default 10, 0 disables)

Environment variables:
  WA_AGENT_DIR         data directory (default: ~/.whatsapp-agent)
  WA_BRIDGE_PORT       local API port (default: 8788)
  WA_BRIDGE_TOKEN      if set, the API requires Authorization: Bearer <token>
  WA_ALLOW             same as --allow
  WA_ALLOW_NEW_CONTACTS / WA_DRY_RUN / WA_SEND_RATE_LIMIT
  WA_BROWSER           macos | ubuntu | windows (default: macos)
  WA_SYNC_FULL_HISTORY "false" to skip requesting the full history
  WA_LOG_LEVEL         debug | info | warn | error (default: info)
`

/** Entry point for the `bridge` CLI subcommand. argv excludes the "bridge" word itself. */
export async function runBridge(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  // Resolve permissions before anything starts listening, so a typo in
  // --allow or WA_ALLOW fails immediately instead of at the first write.
  let permissions: ReturnType<typeof resolvePermissions>
  try {
    permissions = resolvePermissions({
      allow: args.allow,
      allowWrite: args.allowWrite,
      readOnly: args.readOnly,
      allowNewContacts: args.allowNewContacts || undefined,
      dryRun: args.dryRun || undefined,
      rateLimit: args.rateLimit,
    })
  } catch (err) {
    if (err instanceof PermissionConfigError) {
      process.stderr.write(`${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
  setPermissions(permissions)

  logger.info({ dataDir: DATA_DIR, permissions: describePermissions(permissions) }, 'starting wa-bridge')

  const server = startServer()

  const token = getBridgeToken()
  logger.info(`dashboard: ${token ? `${BRIDGE_URL}/?token=${token}` : `${BRIDGE_URL}/`}`)

  await start({
    pairWithNumber: args.pair,
    printQr: Boolean(process.stderr.isTTY) && !args.pair,
    onOpen: () => {
      if (args.login) {
        process.stderr.write(
          `\n  Linked as ${state.me?.name ?? state.me?.id}.\n` +
            `  Downloading history... leave this process running for a few minutes.\n\n`,
        )
      }
    },
  })

  const shutdown = () => {
    logger.info('shutting down...')
    stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Still runnable directly (`bun run src/bridge/index.ts --login`) for local
// dev, without going through the whatsapp-agent CLI router.
if (import.meta.main) {
  runBridge(process.argv.slice(2)).catch((err) => {
    logger.error({ err }, 'wa-bridge failed to start')
    process.exit(1)
  })
}
