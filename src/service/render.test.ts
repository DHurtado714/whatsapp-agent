import { describe, expect, test } from 'bun:test'
import { renderLaunchdPlist } from './launchd.js'
import { renderSystemdUnit } from './systemd.js'

describe('renderLaunchdPlist', () => {
  test('escapes XML special characters in interpolated paths', () => {
    const xml = renderLaunchdPlist({
      binPath: '/Users/O\'Brien & Sons/bin/whatsapp-agent',
      logPath: '/Users/O\'Brien & Sons/.whatsapp-agent/logs/<bridge>.log',
      env: { WA_LOG_LEVEL: 'info' }
    })
    // A raw `&`, `<`, or `'` here would produce a plist that fails
    // `plutil -lint` and launchd rejects with an opaque error.
    expect(xml).toContain('O&apos;Brien &amp; Sons')
    expect(xml).toContain('&lt;bridge&gt;.log')
    expect(xml).not.toContain("O'Brien & Sons")
    expect(xml).not.toContain('<bridge>.log')
  })

  test('includes the bridge subcommand and env vars', () => {
    const xml = renderLaunchdPlist({
      binPath: '/usr/local/bin/whatsapp-agent',
      logPath: '/tmp/bridge.log',
      env: { WA_LOG_LEVEL: 'debug', WA_BRIDGE_PORT: '8788' }
    })
    expect(xml).toContain('<string>bridge</string>')
    expect(xml).toContain('<key>WA_LOG_LEVEL</key>')
    expect(xml).toContain('<string>debug</string>')
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<key>Crashed</key>')
    expect(xml).toContain('<true/>')
  })

  test('is well-formed XML (rough structural check)', () => {
    const xml = renderLaunchdPlist({ binPath: '/bin/x', logPath: '/tmp/x.log' })
    const opens = xml.match(/<dict>/g)?.length ?? 0
    const closes = xml.match(/<\/dict>/g)?.length ?? 0
    expect(opens).toBe(closes)
    expect(xml.trim().startsWith('<?xml')).toBe(true)
    expect(xml.trim().endsWith('</plist>')).toBe(true)
  })
})

describe('renderSystemdUnit', () => {
  test('includes the bridge subcommand, Restart=always, and env vars', () => {
    const unit = renderSystemdUnit({
      binPath: '/usr/local/bin/whatsapp-agent',
      env: { WA_LOG_LEVEL: 'info', WA_BRIDGE_PORT: '8788' }
    })
    expect(unit).toContain('ExecStart=/usr/local/bin/whatsapp-agent bridge')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('Environment=WA_LOG_LEVEL=info')
    expect(unit).toContain('Environment=WA_BRIDGE_PORT=8788')
    expect(unit).toContain('WantedBy=default.target')
  })

  test('handles a bin path containing a space', () => {
    // systemd unit files don't need shell-style quoting/escaping for
    // ExecStart in the common case, but a path with a space is worth
    // pinning down explicitly since it's a common source of "works on my
    // machine" unit file bugs.
    const unit = renderSystemdUnit({ binPath: '/opt/My Apps/whatsapp-agent' })
    expect(unit).toContain('ExecStart=/opt/My Apps/whatsapp-agent bridge')
  })
})
