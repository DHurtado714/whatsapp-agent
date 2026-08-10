import { describe, expect, test } from 'bun:test'
import { listClientTargets, renderConfigSnippet } from './clients.js'

describe('renderConfigSnippet', () => {
  test('renders valid, parseable JSON with the whatsapp entry', () => {
    const snippet = renderConfigSnippet({
      command: '/usr/local/bin/whatsapp-agent',
      args: ['mcp'],
      env: { WA_BRIDGE_TOKEN: 'secret' },
    })
    const parsed = JSON.parse(snippet)
    expect(parsed.mcpServers.whatsapp).toEqual({
      command: '/usr/local/bin/whatsapp-agent',
      args: ['mcp'],
      env: { WA_BRIDGE_TOKEN: 'secret' },
    })
  })
})

describe('listClientTargets', () => {
  test('returns one entry per known client, all read-only (no fs writes)', async () => {
    const targets = await listClientTargets()
    const ids = targets.map((t) => t.id).sort()
    expect(ids).toEqual(['claude-code', 'claude-desktop', 'cursor', 'windsurf'])
    for (const t of targets) {
      expect(typeof t.detected).toBe('boolean')
      expect(typeof t.label).toBe('string')
    }
  })
})
