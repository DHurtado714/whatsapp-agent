import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureJsonKey } from './jsonConfig.js'

const scratchDirs: string[] = []
function scratchFile(name = 'config.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-jsonconfig-test-'))
  scratchDirs.push(dir)
  return path.join(dir, name)
}

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('ensureJsonKey', () => {
  test('creates a new file with the desired key when none exists', async () => {
    const file = scratchFile()
    const result = await ensureJsonKey(file, 'mcpServers', { whatsapp: { command: 'x' } })
    expect(result.status).toBe('created')
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(written).toEqual({ mcpServers: { whatsapp: { command: 'x' } } })
  })

  test('creates parent directories as needed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-jsonconfig-test-'))
    scratchDirs.push(dir)
    const file = path.join(dir, 'nested', 'deep', 'config.json')
    const result = await ensureJsonKey(file, 'mcpServers', { whatsapp: {} })
    expect(result.status).toBe('created')
    expect(fs.existsSync(file)).toBe(true)
  })

  test('preserves unrelated keys already in the file', async () => {
    const file = scratchFile()
    fs.writeFileSync(
      file,
      JSON.stringify({ unrelatedTopLevelKey: 'keep me', preferences: { theme: 'dark', nested: { a: 1 } } })
    )
    const result = await ensureJsonKey(file, 'mcpServers', { whatsapp: { command: 'x' } })
    expect(result.status).toBe('updated')
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(written.unrelatedTopLevelKey).toBe('keep me')
    expect(written.preferences).toEqual({ theme: 'dark', nested: { a: 1 } })
    expect(written.mcpServers).toEqual({ whatsapp: { command: 'x' } })
  })

  test('is a no-op and writes nothing when the value already matches', async () => {
    const file = scratchFile()
    const desired = { whatsapp: { command: 'x', env: { A: '1' } } }
    fs.writeFileSync(file, JSON.stringify({ mcpServers: desired, other: true }))
    const before = fs.statSync(file).mtimeMs
    const result = await ensureJsonKey(file, 'mcpServers', desired)
    expect(result.status).toBe('already-configured')
    // File must not have been touched at all — not even rewritten identically.
    expect(fs.statSync(file).mtimeMs).toBe(before)
    const dir = path.dirname(file)
    expect(fs.readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false)
  })

  test('merging an existing whatsapp entry alongside a sibling MCP server keeps the sibling', async () => {
    const file = scratchFile()
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { otherTool: { command: 'other' } } }))
    const result = await ensureJsonKey(file, 'mcpServers', {
      otherTool: { command: 'other' },
      whatsapp: { command: 'whatsapp-agent', args: ['mcp'] }
    })
    expect(result.status).toBe('updated')
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(written.mcpServers.otherTool).toEqual({ command: 'other' })
    expect(written.mcpServers.whatsapp).toEqual({ command: 'whatsapp-agent', args: ['mcp'] })
  })

  test('never overwrites a file that fails to parse as JSON', async () => {
    const file = scratchFile()
    fs.writeFileSync(file, '{ this is not valid json,,, ')
    const before = fs.readFileSync(file, 'utf-8')
    const result = await ensureJsonKey(file, 'mcpServers', { whatsapp: {} })
    expect(result.status).toBe('parse-error')
    expect(fs.readFileSync(file, 'utf-8')).toBe(before) // untouched
  })

  test('rejects a file whose top-level value is not an object', async () => {
    const file = scratchFile()
    fs.writeFileSync(file, JSON.stringify([1, 2, 3]))
    const result = await ensureJsonKey(file, 'mcpServers', { whatsapp: {} })
    expect(result.status).toBe('parse-error')
  })

  test('takes a backup before changing an existing file, preserving its mode', async () => {
    const file = scratchFile()
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { whatsapp: { command: 'old' } } }))
    fs.chmodSync(file, 0o600)
    const result = await ensureJsonKey(file, 'mcpServers', { whatsapp: { command: 'new' } })
    expect(result.status).toBe('updated')
    if (result.status !== 'updated') throw new Error('unreachable')
    expect(fs.existsSync(result.backupPath)).toBe(true)
    expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600)
    const backup = JSON.parse(fs.readFileSync(result.backupPath, 'utf-8'))
    expect(backup.mcpServers.whatsapp.command).toBe('old')
  })

  test('does not take a backup when creating a brand-new file', async () => {
    const file = scratchFile()
    await ensureJsonKey(file, 'mcpServers', { whatsapp: {} })
    const dir = path.dirname(file)
    expect(fs.readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false)
  })

  test('prunes old backups beyond maxBackups', async () => {
    const file = scratchFile()
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }))
    for (let i = 0; i < 8; i++) {
      await ensureJsonKey(file, 'mcpServers', { whatsapp: { rev: i } }, { maxBackups: 3 })
      // Ensure distinct timestamps so backup filenames don't collide.
      await new Promise((r) => setTimeout(r, 5))
    }
    const dir = path.dirname(file)
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak-'))
    expect(backups.length).toBeLessThanOrEqual(3)
  })

  test('confirmChange callback can decline the change, leaving the file untouched', async () => {
    const file = scratchFile()
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { whatsapp: { command: 'old' } } }))
    const before = fs.readFileSync(file, 'utf-8')
    const result = await ensureJsonKey(file, 'mcpServers', { whatsapp: { command: 'new' } }, {
      confirmChange: () => false
    })
    expect(result.status).toBe('declined')
    expect(fs.readFileSync(file, 'utf-8')).toBe(before)
  })

  test('confirmChange is not called when the value already matches', async () => {
    const file = scratchFile()
    const desired = { whatsapp: { command: 'x' } }
    fs.writeFileSync(file, JSON.stringify({ mcpServers: desired }))
    let called = false
    await ensureJsonKey(file, 'mcpServers', desired, { confirmChange: () => ((called = true), true) })
    expect(called).toBe(false)
  })

  test('confirmChange can approve the change asynchronously', async () => {
    const file = scratchFile()
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { whatsapp: { command: 'old' } } }))
    const result = await ensureJsonKey(file, 'mcpServers', { whatsapp: { command: 'new' } }, {
      confirmChange: async () => true
    })
    expect(result.status).toBe('updated')
  })

  test('a second call is idempotent (no duplicate backups, no changes)', async () => {
    const file = scratchFile()
    const desired = { whatsapp: { command: 'x' } }
    const first = await ensureJsonKey(file, 'mcpServers', desired)
    expect(first.status).toBe('created')
    const second = await ensureJsonKey(file, 'mcpServers', desired)
    expect(second.status).toBe('already-configured')
  })
})
