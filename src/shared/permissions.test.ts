import { afterEach, describe, expect, test } from 'bun:test'
import {
  ALL_SCOPES,
  DEFAULT_SEND_RATE_LIMIT,
  PermissionConfigError,
  READ_TOOLS,
  WRITE_TOOLS,
  describePermissions,
  expectedTools,
  isReadOnly,
  parseScopes,
  permissionsPayload,
  resolvePermissions,
  scopeList,
} from './permissions.js'

const PERMISSION_ENV = ['WA_ALLOW', 'WA_ALLOW_NEW_CONTACTS', 'WA_DRY_RUN', 'WA_SEND_RATE_LIMIT']

afterEach(() => {
  for (const key of PERMISSION_ENV) delete process.env[key]
})

describe('parseScopes', () => {
  test('empty string means read-only', () => {
    expect(parseScopes('').size).toBe(0)
  })

  test('parses a comma-separated list, tolerating whitespace and case', () => {
    expect([...parseScopes(' send , CHATS ')].sort()).toEqual(['chats', 'send'])
  })

  test('"all" expands to every scope', () => {
    expect(parseScopes('all').size).toBe(ALL_SCOPES.length)
  })

  test('"none" and read-only aliases stay empty', () => {
    for (const alias of ['none', 'read', 'readonly', 'read-only']) {
      expect(parseScopes(alias).size).toBe(0)
    }
  })

  test('an unknown scope is a hard error, not a silent drop', () => {
    // A typo in WA_ALLOW must not quietly leave a capability disabled — that
    // reads as a bug somewhere else entirely.
    expect(() => parseScopes('send,sned')).toThrow(PermissionConfigError)
    expect(() => parseScopes('send,sned')).toThrow(/unknown permission scope "sned"/)
  })
})

describe('resolvePermissions precedence', () => {
  test('defaults to read-only with no flags and no env', () => {
    const perms = resolvePermissions()
    expect(isReadOnly(perms)).toBe(true)
    expect(perms.dryRun).toBe(false)
    expect(perms.allowNewContacts).toBe(false)
    expect(perms.sendRateLimit).toBe(DEFAULT_SEND_RATE_LIMIT)
  })

  test('WA_ALLOW is used when no flag is given', () => {
    process.env.WA_ALLOW = 'send,media'
    expect(scopeList(resolvePermissions())).toEqual(['send', 'media'])
  })

  test('--allow beats WA_ALLOW', () => {
    process.env.WA_ALLOW = 'all'
    expect(scopeList(resolvePermissions({ allow: 'chats' }))).toEqual(['chats'])
  })

  test('--allow-write beats --allow and grants everything', () => {
    expect(scopeList(resolvePermissions({ allow: 'chats', allowWrite: true }))).toEqual([...ALL_SCOPES])
  })

  test('--read-only wins over everything, including a service-provided WA_ALLOW', () => {
    process.env.WA_ALLOW = 'all'
    const perms = resolvePermissions({ allow: 'all', allowWrite: true, readOnly: true })
    expect(isReadOnly(perms)).toBe(true)
  })

  test('an empty --allow means read-only, and still overrides WA_ALLOW', () => {
    process.env.WA_ALLOW = 'all'
    expect(isReadOnly(resolvePermissions({ allow: '' }))).toBe(true)
  })

  test('scopeList is sorted canonically regardless of input order', () => {
    expect(scopeList(resolvePermissions({ allow: 'groups,send' }))).toEqual(['send', 'groups'])
  })
})

describe('guardrail configuration', () => {
  test('WA_DRY_RUN and WA_ALLOW_NEW_CONTACTS are read from the env', () => {
    process.env.WA_DRY_RUN = 'true'
    process.env.WA_ALLOW_NEW_CONTACTS = '1'
    const perms = resolvePermissions()
    expect(perms.dryRun).toBe(true)
    expect(perms.allowNewContacts).toBe(true)
  })

  test('a flag can turn a guardrail on but the env value stands otherwise', () => {
    expect(resolvePermissions({ dryRun: true }).dryRun).toBe(true)
    expect(resolvePermissions().dryRun).toBe(false)
  })

  test('WA_SEND_RATE_LIMIT overrides the default, and 0 disables it', () => {
    process.env.WA_SEND_RATE_LIMIT = '3'
    expect(resolvePermissions().sendRateLimit).toBe(3)
    process.env.WA_SEND_RATE_LIMIT = '0'
    expect(resolvePermissions().sendRateLimit).toBe(0)
  })

  test('--rate-limit beats the env', () => {
    process.env.WA_SEND_RATE_LIMIT = '3'
    expect(resolvePermissions({ rateLimit: 42 }).sendRateLimit).toBe(42)
  })

  test('a non-numeric or negative rate limit is rejected', () => {
    process.env.WA_SEND_RATE_LIMIT = 'lots'
    expect(() => resolvePermissions()).toThrow(PermissionConfigError)
    expect(() => resolvePermissions({ rateLimit: -1 })).toThrow(/expected a number >= 0/)
  })
})

describe('reporting', () => {
  test('describePermissions says read-only when nothing is granted', () => {
    expect(describePermissions(resolvePermissions())).toBe('read-only')
  })

  test('describePermissions lists scopes and active guardrails', () => {
    const perms = resolvePermissions({ allow: 'send', dryRun: true, rateLimit: 5 })
    expect(describePermissions(perms)).toBe('read + send (dry-run, 5/min)')
  })

  test('the payload shape is stable for the HTTP API', () => {
    expect(permissionsPayload(resolvePermissions({ allow: 'send,chats' }))).toEqual({
      scopes: ['send', 'chats'],
      read_only: false,
      dry_run: false,
      allow_new_contacts: false,
      send_rate_limit_per_minute: DEFAULT_SEND_RATE_LIMIT,
    })
  })
})

describe('expectedTools', () => {
  test('read-only exposes only the read tools', () => {
    expect(expectedTools(resolvePermissions())).toEqual([...READ_TOOLS].sort())
  })

  test('each scope contributes its own tools and nothing else', () => {
    const tools = expectedTools(resolvePermissions({ allow: 'send' }))
    for (const name of WRITE_TOOLS.send) expect(tools).toContain(name)
    for (const name of WRITE_TOOLS.groups) expect(tools).not.toContain(name)
  })

  test('no tool name is claimed by two scopes', () => {
    const all = ALL_SCOPES.flatMap((s) => [...WRITE_TOOLS[s]])
    expect(new Set(all).size).toBe(all.length)
    for (const name of all) expect(READ_TOOLS).not.toContain(name)
  })
})
