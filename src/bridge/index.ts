#!/usr/bin/env node
import { DATA_DIR } from '../shared/config.js'
import { logger, start, state, stop } from './socket.js'
import { startServer } from './server.js'

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
wa-bridge - daemon que mantiene tu sesion de WhatsApp viva y guarda todo en SQLite

  wa-bridge                    arranca el daemon (QR en la terminal si no hay sesion)
  wa-bridge --pair 573001234567   vincula con codigo de 8 digitos en vez de QR
  wa-bridge --login            solo vincula y sincroniza el historial, luego sigue corriendo

Variables de entorno:
  WA_AGENT_DIR         directorio de datos (default: ~/.whatsapp-agent)
  WA_BRIDGE_PORT       puerto de la API local (default: 8788)
  WA_BRIDGE_TOKEN      si se define, la API exige Authorization: Bearer <token>
  WA_SYNC_FULL_HISTORY "false" para no pedir el historial completo
  WA_LOG_LEVEL         debug | info | warn | error (default: info)
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  logger.info({ dataDir: DATA_DIR }, 'iniciando wa-bridge')

  const server = startServer()

  await start({
    pairWithNumber: args.pair,
    printQr: Boolean(process.stderr.isTTY) && !args.pair,
    onOpen: () => {
      if (args.login) {
        process.stderr.write(
          `\n  Vinculado como ${state.me?.name ?? state.me?.id}.\n` +
            `  Descargando historial... deja este proceso corriendo unos minutos.\n\n`
        )
      }
    }
  })

  const shutdown = () => {
    logger.info('cerrando...')
    stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  logger.error({ err }, 'wa-bridge fallo al arrancar')
  process.exit(1)
})
