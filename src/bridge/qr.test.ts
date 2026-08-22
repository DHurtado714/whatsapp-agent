import { describe, expect, test } from 'bun:test'
import { renderQrSvg } from './qr.js'

const BAILEYS_LIKE_PAYLOAD = '2@abcdefghijklmnop/qrstuvwxyz+0123456789==,ABCDEFGHIJ/KLMNOP==,QRSTUVWXYZ==,1'

describe('renderQrSvg', () => {
  test('produces a well-formed SVG', () => {
    const svg = renderQrSvg(BAILEYS_LIKE_PAYLOAD)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('<path')
  })

  test('module count (QR version) is odd and in the valid range', () => {
    const svg = renderQrSvg(BAILEYS_LIKE_PAYLOAD, { moduleSize: 1, quietZone: 0 })
    const match = svg.match(/viewBox="0 0 (\d+) \d+"/)
    const count = Number(match?.[1])
    expect(count % 2).toBe(1)
    expect(count).toBeGreaterThanOrEqual(21)
    expect(count).toBeLessThanOrEqual(177)
  })

  test('is deterministic for the same payload', () => {
    expect(renderQrSvg(BAILEYS_LIKE_PAYLOAD)).toBe(renderQrSvg(BAILEYS_LIKE_PAYLOAD))
  })

  test('does not leak the raw payload into the markup', () => {
    const svg = renderQrSvg(BAILEYS_LIKE_PAYLOAD)
    expect(svg).not.toContain(BAILEYS_LIKE_PAYLOAD)
  })

  test('throws on empty input', () => {
    expect(() => renderQrSvg('')).toThrow()
  })

  test('a payload with XML-sensitive characters does not break the markup', () => {
    const svg = renderQrSvg('2@<script>&"\'')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
  })
})
