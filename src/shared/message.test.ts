import { describe, expect, test } from 'bun:test'
import { parseMessage, toMillis } from './message.js'

describe('parseMessage', () => {
  test('plain text', () => {
    const r = parseMessage({ message: { conversation: 'hello world' } } as any)
    expect(r.text).toBe('hello world')
    expect(r.kind).toBe('conversation')
  })

  test('extendedTextMessage with a quote', () => {
    const r = parseMessage({
      message: {
        extendedTextMessage: { text: 'replying to this', contextInfo: { stanzaId: 'ABC123' } },
      },
    } as any)
    expect(r.text).toBe('replying to this')
    expect(r.quotedId).toBe('ABC123')
  })

  test('image with caption', () => {
    const r = parseMessage({
      message: { imageMessage: { caption: 'look at this', mimetype: 'image/jpeg' } },
    } as any)
    expect(r.text).toBe('look at this')
    expect(r.mediaType).toBe('image')
  })

  test('document with filename', () => {
    const r = parseMessage({ message: { documentMessage: { fileName: 'invoice.pdf' } } } as any)
    expect(r.mediaType).toBe('document')
    expect(r.filename).toBe('invoice.pdf')
  })

  test('voice note', () => {
    const r = parseMessage({ message: { audioMessage: { ptt: true, seconds: 12 } } } as any)
    expect(r.mediaType).toBe('audio')
    expect(r.text).toBe('[voice note]')
  })

  test('ephemeral wrapper is unwrapped', () => {
    const r = parseMessage({
      message: { ephemeralMessage: { message: { conversation: 'disappearing message' } } },
    } as any)
    expect(r.text).toBe('disappearing message')
  })

  test('viewOnce wrapper is unwrapped', () => {
    const r = parseMessage({
      message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'one time only' } } } },
    } as any)
    expect(r.mediaType).toBe('image')
    expect(r.text).toBe('one time only')
  })

  test('empty message does not throw', () => {
    const r = parseMessage({ message: null } as any)
    expect(r.kind).toBe('unknown')
    expect(r.text).toBeNull()
  })

  test('location, contact, poll placeholders are in English', () => {
    expect(
      parseMessage({
        message: { locationMessage: { degreesLatitude: 10, degreesLongitude: 20 } },
      } as any).text,
    ).toBe('[location] 10,20')
    expect(parseMessage({ message: { contactMessage: { displayName: 'Alice' } } } as any).text).toBe('[contact] Alice')
    expect(
      parseMessage({
        message: { pollCreationMessage: { name: 'Lunch?' } },
      } as any).text,
    ).toBe('[poll] Lunch?')
  })
})

describe('toMillis', () => {
  test('seconds are converted to milliseconds', () => {
    expect(toMillis(1754600000)).toBe(1754600000000)
  })

  test('millisecond timestamps pass through', () => {
    expect(toMillis(1754600000000)).toBe(1754600000000)
  })

  test('protobufjs Long-like objects are supported', () => {
    expect(toMillis({ toNumber: () => 1754600000 })).toBe(1754600000000)
  })
})
