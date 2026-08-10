import { DATA_DIR } from '../shared/config.js'
import { startServer } from './server.js'
import { logger, start, state, stop } from './socket.js'

function parseArgs(argv: string[]) {
  const args = { pair: undefined as string | undefined, login: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pair') args.pair = (argv[++i] ?? '').replace(/\D/g, '')
    else if (a.startsWith('--pair=')) args.pair = a.slice('--pair='.length).replace(/\D/g, '')
    else if (a === '--login') args.login = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

const HELP = `
whatsapp-agent bridge - daemon that keeps your WhatsApp session alive and saves everything to SQLite

  whatsapp-agent bridge                     start the daemon (QR in the terminal if there's no session)
  whatsapp-agent bridge --pair 15551234567  link with an 8-digit code instead of a QR
  whatsapp-agent bridge --login             just link and sync history, then keep running

Environment variables:
  WA_AGENT_DIR         data directory (default: ~/.whatsapp-agent)
  WA_BRIDGE_PORT       local API port (default: 8788)
  WA_BRIDGE_TOKEN      if set, the API requires Authorization: Bearer <token>
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

  logger.info({ dataDir: DATA_DIR }, 'starting wa-bridge')

  const server = startServer()

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
