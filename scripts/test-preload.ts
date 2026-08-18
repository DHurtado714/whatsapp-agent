import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Runs before any test module is imported (see bunfig.toml [test] preload).
 *
 * shared/config.ts resolves DATA_DIR, DB_PATH, TOKEN_PATH and BRIDGE_PORT into
 * consts at module load. A test file that sets WA_AGENT_DIR in beforeAll()
 * therefore only affects those values if it happens to be the first file to
 * import config.ts — and `bun test` shares one process across files, so that
 * ordering is not something a test can rely on. When it loses the race the
 * suite silently points at the developer's real ~/.whatsapp-agent, reads their
 * actual bridge token, and starts failing in ways that look unrelated.
 *
 * Setting the environment here removes the race entirely: nothing has been
 * imported yet, so every test file sees the same throwaway data directory.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-tests-'))

process.env.WA_AGENT_DIR = dir
process.env.WA_BRIDGE_PORT = '0'
process.env.WA_LOG_LEVEL = 'error'

// Never inherit the developer's own configuration: a token or a granted scope
// leaking in from the shell would change what the tests are actually asserting.
for (const key of [
  'WA_BRIDGE_TOKEN',
  'WA_BRIDGE_URL',
  'WA_ALLOW',
  'WA_ALLOW_NEW_CONTACTS',
  'WA_DRY_RUN',
  'WA_SEND_RATE_LIMIT',
]) {
  delete process.env[key]
}

process.on('exit', () => {
  fs.rmSync(dir, { recursive: true, force: true })
})
