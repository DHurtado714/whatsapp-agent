import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { DISCLAIMER_PATH } from './config.js'
import { acceptDisclaimer, isDisclaimerAccepted } from './disclaimer.js'

// Other test files (e.g. bridge/server.test.ts) accept the disclaimer too,
// and bun test shares one process/data dir across files with no guaranteed
// run order — so a clean slate has to be established before each test here,
// not just cleaned up after.
beforeEach(() => {
  fs.rmSync(DISCLAIMER_PATH, { force: true })
})
afterEach(() => {
  fs.rmSync(DISCLAIMER_PATH, { force: true })
})

describe('disclaimer acceptance', () => {
  test('is not accepted initially', () => {
    expect(isDisclaimerAccepted()).toBe(false)
  })

  test('acceptDisclaimer persists it as accepted', () => {
    acceptDisclaimer('cli')
    expect(isDisclaimerAccepted()).toBe(true)
  })

  test('the file is written with mode 0600', () => {
    acceptDisclaimer('dashboard')
    const mode = fs.statSync(DISCLAIMER_PATH).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('accepting is idempotent', () => {
    acceptDisclaimer('cli')
    acceptDisclaimer('cli')
    expect(isDisclaimerAccepted()).toBe(true)
  })

  test('an accepted record from an older version reads back as not accepted', () => {
    fs.writeFileSync(DISCLAIMER_PATH, JSON.stringify({ version: 0, accepted_at: '2020-01-01', source: 'cli' }))
    expect(isDisclaimerAccepted()).toBe(false)
  })
})
