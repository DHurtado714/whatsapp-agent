import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  __resetForTests,
  counts,
  getChat,
  getDb,
  getMessages,
  upsertChat,
  upsertContact,
  upsertLidMapping,
  upsertMessages
} from './db.js'

// Every test calls __resetForTests(path) then does synchronous db work only
// (bun:sqlite is synchronous end to end) — no `await` sits between the reset
// and the assertions, so a test body is one uninterrupted turn and can't
// interleave with another test resetting the same module-level singleton.

const scratchDirs: string[] = []
function scratchDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-db-test-'))
  scratchDirs.push(dir)
  return path.join(dir, 'store.db')
}

afterEach(() => {
  __resetForTests(null)
})

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('bun:sqlite strict binding', () => {
  test('bare named params round-trip instead of silently binding NULL', () => {
    // Regression test for the single highest-risk bug in the bun:sqlite
    // migration: without `strict: true`, bare named params like `{ jid }`
    // bound against `@jid` silently insert NULL with no error. Every write
    // in db.ts uses bare named params.
    __resetForTests(scratchDbPath())
    upsertContact({ jid: 'alice@s.whatsapp.net', name: 'Alice' })
    const row = getDb()
      .query('SELECT jid, name FROM contacts WHERE jid = ?')
      .get('alice@s.whatsapp.net') as { jid: string; name: string | null }
    expect(row.name).toBe('Alice')
  })

  test('upsertChat and upsertMessages bind every named param correctly', () => {
    __resetForTests(scratchDbPath())
    upsertChat({ jid: 'chat1@g.us', name: 'Team', isGroup: true, lastMessageAt: 1000 })
    upsertMessages([
      {
        chat_jid: 'chat1@g.us',
        msg_id: 'm1',
        from_me: 0,
        sender_jid: '11111@lid',
        sender_name: 'Bob',
        timestamp: 1000,
        kind: 'text',
        text: 'hello world',
        quoted_id: null,
        media_type: null,
        filename: null
      }
    ])

    const chat = getChat('chat1@g.us')
    expect(chat?.name).toBe('Team')
    expect(chat?.is_group).toBe(1)

    const msgs = getMessages({ chatJid: 'chat1@g.us' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.text).toBe('hello world')
    expect(msgs[0]?.sender_display).toBe('Bob') // falls back to sender_name, no contact/lid row yet

    expect(counts().messages).toBe(1)
  })

  test('lid_map resolves a phone number for chats addressed by @lid', () => {
    // lid_map is joined on the CHAT's own jid, i.e. it only resolves a
    // phone number for chats that are themselves addressed as "<lid>@lid"
    // (WhatsApp's newer per-contact identifier), not for arbitrary senders.
    __resetForTests(scratchDbPath())
    upsertLidMapping('11111@lid', '15550100001')
    upsertChat({ jid: '11111@lid', isGroup: false, lastMessageAt: 1000 })

    const chat = getChat('11111@lid')
    expect(chat?.phone_number).toBe('15550100001')
  })
})

describe('migration v2: English placeholders + FTS rebuild', () => {
  function seedV1Database(dbPath: string): void {
    const seed = new Database(dbPath, { create: true, strict: true })
    seed.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER DEFAULT 0,
        last_message_at INTEGER, unread_count INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
        pinned INTEGER DEFAULT 0, muted_until INTEGER, updated_at INTEGER);
      CREATE TABLE messages (chat_jid TEXT, msg_id TEXT, from_me INTEGER DEFAULT 0,
        sender_jid TEXT, sender_name TEXT, timestamp INTEGER, kind TEXT, text TEXT,
        quoted_id TEXT, media_type TEXT, filename TEXT, raw TEXT,
        PRIMARY KEY (chat_jid, msg_id));
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text, chat_jid UNINDEXED, msg_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)
    seed.query("INSERT INTO chats (jid) VALUES ('c1@s.whatsapp.net')").run()
    const seedRows: Array<[string, string]> = [
      ['m1', '[nota de voz]'],
      ['m2', '[contactos] Alice, Bob'], // must survive the [contacto] ordering trap
      ['m3', '[contacto] Alice'],
      ['m4', '[ubicacion] 10.0,20.0'],
      ['m5', '[reaccion] +1'],
      ['m6', '[encuesta] Lunch?'],
      ['m7', '[ubicacion en vivo]'],
      ['m8', '[sticker]'], // already English, must be left untouched
      ['m9', 'plain text']
    ]
    for (const [id, text] of seedRows) {
      seed
        .query('INSERT INTO messages (chat_jid, msg_id, timestamp, text) VALUES (@c, @id, @ts, @text)')
        .run({ c: 'c1@s.whatsapp.net', id, ts: Date.now(), text })
      seed
        .query('INSERT INTO messages_fts (text, chat_jid, msg_id) VALUES (@text, @c, @id)')
        .run({ text, c: 'c1@s.whatsapp.net', id })
    }
    seed.exec('PRAGMA user_version = 1')
    seed.close()
  }

  test('rewrites placeholders in both messages and messages_fts, bumps user_version', () => {
    const dbPath = scratchDbPath()
    seedV1Database(dbPath)
    __resetForTests(dbPath)

    const d = getDb()
    expect((d.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)

    const rows = d.query('SELECT msg_id, text FROM messages ORDER BY msg_id').all() as Array<{
      msg_id: string
      text: string
    }>
    const byId = Object.fromEntries(rows.map((r) => [r.msg_id, r.text]))
    expect(byId.m1).toBe('[voice note]')
    expect(byId.m2).toBe('[contacts] Alice, Bob')
    expect(byId.m3).toBe('[contact] Alice')
    expect(byId.m4).toBe('[location] 10.0,20.0')
    expect(byId.m5).toBe('[reaction] +1')
    expect(byId.m6).toBe('[poll] Lunch?')
    expect(byId.m7).toBe('[live location]')
    expect(byId.m8).toBe('[sticker]')
    expect(byId.m9).toBe('plain text')

    const ftsRows = d.query('SELECT msg_id, text FROM messages_fts ORDER BY msg_id').all() as Array<{
      msg_id: string
      text: string
    }>
    expect(ftsRows).toEqual(rows)
  })

  test('a second open of an already-migrated database is a no-op', () => {
    const dbPath = scratchDbPath()
    seedV1Database(dbPath)
    __resetForTests(dbPath)
    getDb() // runs migration v2, takes a backup

    const dir = path.dirname(dbPath)
    const backupsAfterFirstOpen = fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length
    expect(backupsAfterFirstOpen).toBe(1)

    __resetForTests(dbPath)
    getDb() // second open, already at user_version 2

    const backupsAfterSecondOpen = fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length
    expect(backupsAfterSecondOpen).toBe(backupsAfterFirstOpen) // migration did not re-run
  })
})

describe('FTS5 availability', () => {
  test('bun:sqlite in this environment supports fts5', () => {
    const db = new Database(':memory:', { strict: true })
    expect(() => {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(x)')
    }).not.toThrow()
    db.close()
  })
})
