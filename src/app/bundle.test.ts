import { describe, expect, test } from 'bun:test'
import { INNER_BIN_NAME, LAUNCHER_NAME, renderInfoPlist, renderLauncherScript } from './bundle.js'

describe('renderInfoPlist', () => {
  test('escapes XML special characters in interpolated version string', () => {
    const xml = renderInfoPlist({ version: '1.0.0 <beta> & "quoted"', hasIcon: false })
    expect(xml).toContain('&lt;beta&gt;')
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&quot;quoted&quot;')
    expect(xml).not.toContain('<beta>')
  })

  test('is well-formed XML (rough structural check)', () => {
    const xml = renderInfoPlist({ version: '0.1.0', hasIcon: false })
    const opens = xml.match(/<dict>/g)?.length ?? 0
    const closes = xml.match(/<\/dict>/g)?.length ?? 0
    expect(opens).toBe(closes)
    expect(xml.trim().startsWith('<?xml')).toBe(true)
    expect(xml.trim().endsWith('</plist>')).toBe(true)
  })

  test('sets the launcher as CFBundleExecutable, and LSUIElement true', () => {
    const xml = renderInfoPlist({ version: '0.1.0', hasIcon: false })
    expect(xml).toContain(`<string>${LAUNCHER_NAME}</string>`)
    expect(xml).toContain('<key>LSUIElement</key>\n    <true/>')
    expect(xml).toContain('<string>APPL</string>')
  })

  test('omits CFBundleIconFile when there is no icon', () => {
    const xml = renderInfoPlist({ version: '0.1.0', hasIcon: false })
    expect(xml).not.toContain('CFBundleIconFile')
  })

  test('includes CFBundleIconFile when there is an icon', () => {
    const xml = renderInfoPlist({ version: '0.1.0', hasIcon: true })
    expect(xml).toContain('<key>CFBundleIconFile</key>\n    <string>AppIcon</string>')
  })
})

describe('renderLauncherScript', () => {
  test('starts with a shebang and execs the inner binary with "app"', () => {
    const script = renderLauncherScript({ arch: 'x64' })
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain(`exec "$dir/${INNER_BIN_NAME}" app`)
    expect(script).toContain('dir=$(dirname "$0")')
  })

  test('only the arm64 build emits the wrong-architecture guard', () => {
    const arm = renderLauncherScript({ arch: 'arm64' })
    const x64 = renderLauncherScript({ arch: 'x64' })
    expect(arm).toContain('uname -m')
    expect(arm).toContain('Wrong download')
    expect(x64).not.toContain('uname -m')
  })
})
