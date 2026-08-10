import { Database } from 'bun:sqlite'
import { DB_PATH, ensureDataDir } from './config.js'

export type ChatRow = {
  jid: string
  name: string | null
  is_group: number
  last_message_at: number | null
  unread_count: number
  archived: number
  pinned: number
  muted_until: number | null
}

export type MessageRow = {
  chat_jid: string
  msg_id: string
  from_me: number
  sender_jid: string | null
  sender_name: string | null
  timestamp: number
  kind: string | null
  text: string | null
  quoted_id: string | null
  media_type: string | null
  filename: string | null
}

let db: Database | null = null
let dbPathOverride: string | null = null

export function getDb(): Database {
  if (db) return db
  const targetPath = dbPathOverride ?? DB_PATH
  if (!dbPathOverride) ensureDataDir()
  // strict:true is not optional. Without it bun:sqlite silently binds NULL
  // for bare named parameters (e.g. `@jid` bound from `{ jid: ... }`) instead
  // of throwing — every write below uses bare named params, so this single
  // flag is the difference between a working database and a silently
  // all-NULL one. See src/shared/db.test.ts for the regression test.
  db = new Database(targetPath, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  assertFts5Available(db)
  migrate(db)
  return db
}

/**
 * Test-only: close the current connection and point the next getDb() call at
 * a different file (or back at the default). Synchronous and side-effect
 * free otherwise — callers must not `await` between calling this and using
 * the db, so a test body stays a single uninterrupted turn and can't
 * interleave with another test mutating the same module-level state.
 */
export function __resetForTests(newPath: string | null = null): void {
  // No throwOnError: db.ts relies on db.query()'s statement cache, and those
  // cached statements are still "outstanding" from SQLite's point of view,
  // which makes close(true) throw "database is locked" even on a clean
  // shutdown. A plain close() releases the connection regardless.
  db?.close()
  db = null
  dbPathOverride = newPath
}

/**
 * bun:sqlite dlopen's the OS-provided libsqlite3 on macOS (Apple's build),
 * and links its own on Linux. FTS5 support therefore isn't guaranteed the
 * way it is with a vendored better-sqlite3 build. Fail loudly and early with
 * an escape hatch instead of a confusing "no such module: fts5" mid-query.
 */
function assertFts5Available(d: Database): void {
  try {
    d.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)")
    d.exec('DROP TABLE __fts_probe')
  } catch (err) {
    throw new Error(
      'This SQLite build does not support FTS5 (needed for message search). ' +
        'If you have a newer SQLite installed separately, point WA_SQLITE_LIB ' +
        'at its shared library (e.g. /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib) ' +
        'and restart.',
      { cause: err }
    )
  }
}

// ---------------------------------------------------------------- migrations

type Migration = { version: number; up: (d: Database) => void }

const MIGRATIONS: Migration[] = [
  {
    // v1: base schema. Idempotent DDL so it's also what a brand-new install runs.
    version: 1,
    up: (d) => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE IF NOT EXISTS contacts (
          jid           TEXT PRIMARY KEY,
          lid           TEXT,
          phone_number  TEXT,
          name          TEXT,
          notify        TEXT,
          verified_name TEXT,
          updated_at    INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_contacts_lid   ON contacts(lid);
        CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);

        -- LID <-> phone number mapping. WhatsApp migrated to @lid addresses
        -- and without this many chats show up as opaque identifiers.
        CREATE TABLE IF NOT EXISTS lid_map (
          lid TEXT PRIMARY KEY,
          pn  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lid_map_pn ON lid_map(pn);

        CREATE TABLE IF NOT EXISTS chats (
          jid             TEXT PRIMARY KEY,
          name            TEXT,
          is_group        INTEGER NOT NULL DEFAULT 0,
          last_message_at INTEGER,
          unread_count    INTEGER NOT NULL DEFAULT 0,
          archived        INTEGER NOT NULL DEFAULT 0,
          pinned          INTEGER NOT NULL DEFAULT 0,
          muted_until     INTEGER,
          updated_at      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_chats_last ON chats(last_message_at DESC);

        CREATE TABLE IF NOT EXISTS messages (
          chat_jid    TEXT NOT NULL,
          msg_id      TEXT NOT NULL,
          from_me     INTEGER NOT NULL DEFAULT 0,
          sender_jid  TEXT,
          sender_name TEXT,
          timestamp   INTEGER NOT NULL,
          kind        TEXT,
          text        TEXT,
          quoted_id   TEXT,
          media_type  TEXT,
          filename    TEXT,
          raw         TEXT,
          PRIMARY KEY (chat_jid, msg_id)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages(timestamp DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text,
          chat_jid UNINDEXED,
          msg_id   UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `)
    }
  },
  {
    // v2: the message-placeholder strings written by src/shared/message.ts
    // used to be Spanish ("[nota de voz]", "[ubicacion] ...", ...). Rewrite
    // any already-persisted rows so old and new messages read consistently,
    // and rebuild the FTS index (it's a *contentful* fts5 table, so it holds
    // its own copy of `text` and doesn't pick this up automatically).
    version: 2,
    up: (d) => {
      // Exact-match placeholders first, then prefix placeholders that also
      // carry a caption (e.g. "[contacto] Alice"). Ordering matters:
      // '[contactos] X' LIKE '[contacto]%' is TRUE, so contactos must run
      // before contacto or it becomes "[contact]s X". Also note SQLite's
      // LIKE gives no special meaning to '[' / ']' (unlike T-SQL) and none
      // of these literals contain '%' or '_', so no escaping is needed.
      d.exec(`UPDATE messages SET text = '[voice note]' WHERE text = '[nota de voz]'`)
      d.exec(`UPDATE messages SET text = '[live location]' WHERE text = '[ubicacion en vivo]'`)
      d.exec(
        `UPDATE messages SET text = '[contacts]' || substr(text, length('[contactos]') + 1) WHERE text LIKE '[contactos]%'`
      )
      d.exec(
        `UPDATE messages SET text = '[contact]' || substr(text, length('[contacto]') + 1) WHERE text LIKE '[contacto]%'`
      )
      d.exec(
        `UPDATE messages SET text = '[location]' || substr(text, length('[ubicacion]') + 1) WHERE text LIKE '[ubicacion]%'`
      )
      d.exec(
        `UPDATE messages SET text = '[reaction]' || substr(text, length('[reaccion]') + 1) WHERE text LIKE '[reaccion]%'`
      )
      d.exec(
        `UPDATE messages SET text = '[poll]' || substr(text, length('[encuesta]') + 1) WHERE text LIKE '[encuesta]%'`
      )

      // Rebuild rather than mirror the UPDATEs above into messages_fts: it's
      // simpler, trivially correct, and also repairs any historical drift
      // between messages and messages_fts.
      d.exec('DELETE FROM messages_fts')
      d.exec(`
        INSERT INTO messages_fts (text, chat_jid, msg_id)
        SELECT text, chat_jid, msg_id FROM messages WHERE text IS NOT NULL
      `)
      d.exec(`INSERT INTO messages_fts(messages_fts) VALUES('optimize')`)
    }
  }
]

function migrate(d: Database): void {
  const tableExists = (name: string) =>
    d.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== null

  let current = (d.query('PRAGMA user_version').get() as { user_version: number }).user_version

  // Bootstrap for pre-existing databases created before this migration
  // framework existed: the base schema is already applied (CREATE TABLE IF
  // NOT EXISTS is a no-op anyway), so stamp v1 without re-running its body.
  if (current === 0 && tableExists('messages')) {
    d.exec('PRAGMA user_version = 1')
    current = 1
  }

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    if (m.version >= 2 && current >= 1) {
      // Snapshot before a data-mutating migration. VACUUM INTO is
      // WAL-consistent, unlike a plain file copy. Use the connection's own
      // filename, not the DB_PATH constant — they differ under a test-only
      // path override (see __resetForTests).
      const backupPath = `${d.filename}.bak-v${current}-${Date.now()}`
      d.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
    }
    const run = d.transaction(() => {
      m.up(d)
      d.exec(`PRAGMA user_version = ${m.version}`)
    })
    run()
    current = m.version
  }
}

export function setMeta(key: string, value: string): void {
  getDb()
    .query(`INSERT INTO meta (key, value) VALUES (@key, @value)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run({ key, value })
}

export function getMeta(key: string): string | null {
  const row = getDb().query(`SELECT value FROM meta WHERE key = @key`).get({ key }) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

// ---------------------------------------------------------------- upserts

export function upsertContact(c: {
  jid: string
  lid?: string | null
  phoneNumber?: string | null
  name?: string | null
  notify?: string | null
  verifiedName?: string | null
}): void {
  // COALESCE(excluded.x, x) => never overwrite a good value with null.
  getDb()
    .query(
      `INSERT INTO contacts (jid, lid, phone_number, name, notify, verified_name, updated_at)
       VALUES (@jid, @lid, @phoneNumber, @name, @notify, @verifiedName, @now)
       ON CONFLICT(jid) DO UPDATE SET
         lid           = COALESCE(excluded.lid, contacts.lid),
         phone_number  = COALESCE(excluded.phone_number, contacts.phone_number),
         name          = COALESCE(excluded.name, contacts.name),
         notify        = COALESCE(excluded.notify, contacts.notify),
         verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
         updated_at    = excluded.updated_at`
    )
    .run({
      jid: c.jid,
      lid: c.lid ?? null,
      phoneNumber: c.phoneNumber ?? null,
      name: c.name ?? null,
      notify: c.notify ?? null,
      verifiedName: c.verifiedName ?? null,
      now: Date.now()
    })
}

export function upsertLidMapping(lid: string, pn: string): void {
  getDb()
    .query(`INSERT INTO lid_map (lid, pn) VALUES (@lid, @pn)
              ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn`)
    .run({ lid, pn })
}

export function upsertChat(c: {
  jid: string
  name?: string | null
  isGroup?: boolean
  lastMessageAt?: number | null
  unreadCount?: number | null
  archived?: boolean | null
  pinned?: boolean | null
  mutedUntil?: number | null
}): void {
  getDb()
    .query(
      // The INSERT branch supplies defaults; the UPDATE branch references
      // the bound parameters (not `excluded`) so an omitted field does NOT
      // clobber whatever value is already stored.
      `INSERT INTO chats (jid, name, is_group, last_message_at, unread_count, archived, pinned, muted_until, updated_at)
       VALUES (@jid, @name, @isGroup, @lastMessageAt, COALESCE(@unreadCount, 0), COALESCE(@archived, 0), COALESCE(@pinned, 0), @mutedUntil, @now)
       ON CONFLICT(jid) DO UPDATE SET
         name            = COALESCE(NULLIF(@name, ''), chats.name),
         is_group        = @isGroup,
         last_message_at = NULLIF(MAX(COALESCE(@lastMessageAt, 0), COALESCE(chats.last_message_at, 0)), 0),
         unread_count    = COALESCE(@unreadCount, chats.unread_count),
         archived        = COALESCE(@archived, chats.archived),
         pinned          = COALESCE(@pinned, chats.pinned),
         muted_until     = COALESCE(@mutedUntil, chats.muted_until),
         updated_at      = @now`
    )
    .run({
      jid: c.jid,
      name: c.name ?? null,
      isGroup: c.isGroup ? 1 : 0,
      lastMessageAt: c.lastMessageAt ?? null,
      unreadCount: c.unreadCount ?? null,
      archived: c.archived === undefined || c.archived === null ? null : c.archived ? 1 : 0,
      pinned: c.pinned === undefined || c.pinned === null ? null : c.pinned ? 1 : 0,
      mutedUntil: c.mutedUntil ?? null,
      now: Date.now()
    })
}

const insertMessageStmt = () =>
  getDb().query(
    `INSERT INTO messages (chat_jid, msg_id, from_me, sender_jid, sender_name, timestamp, kind, text, quoted_id, media_type, filename, raw)
     VALUES (@chat_jid, @msg_id, @from_me, @sender_jid, @sender_name, @timestamp, @kind, @text, @quoted_id, @media_type, @filename, @raw)
     ON CONFLICT(chat_jid, msg_id) DO UPDATE SET
       text        = COALESCE(excluded.text, messages.text),
       kind        = COALESCE(excluded.kind, messages.kind),
       sender_name = COALESCE(excluded.sender_name, messages.sender_name),
       media_type  = COALESCE(excluded.media_type, messages.media_type),
       filename    = COALESCE(excluded.filename, messages.filename),
       raw         = COALESCE(excluded.raw, messages.raw)`
  )

const ftsDeleteStmt = () =>
  getDb().query(`DELETE FROM messages_fts WHERE chat_jid = @chat_jid AND msg_id = @msg_id`)
const ftsInsertStmt = () =>
  getDb().query(`INSERT INTO messages_fts (text, chat_jid, msg_id) VALUES (@text, @chat_jid, @msg_id)`)

export type MessageInput = MessageRow & { raw?: string | null }

export function upsertMessages(rows: MessageInput[]): number {
  if (rows.length === 0) return 0
  const d = getDb()
  const ins = insertMessageStmt()
  const ftsDel = ftsDeleteStmt()
  const ftsIns = ftsInsertStmt()

  const run = d.transaction((batch: MessageInput[]) => {
    for (const r of batch) {
      ins.run({
        chat_jid: r.chat_jid,
        msg_id: r.msg_id,
        from_me: r.from_me,
        sender_jid: r.sender_jid ?? null,
        sender_name: r.sender_name ?? null,
        timestamp: r.timestamp,
        kind: r.kind ?? null,
        text: r.text ?? null,
        quoted_id: r.quoted_id ?? null,
        media_type: r.media_type ?? null,
        filename: r.filename ?? null,
        raw: r.raw ?? null
      })
      if (r.text) {
        ftsDel.run({ chat_jid: r.chat_jid, msg_id: r.msg_id })
        ftsIns.run({ text: r.text, chat_jid: r.chat_jid, msg_id: r.msg_id })
      }
    }
  })
  run(rows)
  return rows.length
}

// ---------------------------------------------------------------- reads

/**
 * Display name for a chat, degrading gracefully:
 *   chat name -> saved contact -> pushName -> phone number -> raw jid
 */
const CHAT_NAME_SQL = `
  COALESCE(
    NULLIF(c.name, ''),
    NULLIF(ct.name, ''),
    NULLIF(ct.verified_name, ''),
    NULLIF(ct.notify, ''),
    NULLIF(ct.phone_number, ''),
    NULLIF(lm.pn, ''),
    c.jid
  )
`

const CHAT_SELECT = `
  SELECT
    c.jid                              AS jid,
    ${CHAT_NAME_SQL}                   AS name,
    c.is_group                         AS is_group,
    c.last_message_at                  AS last_message_at,
    c.unread_count                     AS unread_count,
    c.archived                         AS archived,
    c.pinned                           AS pinned,
    c.muted_until                      AS muted_until,
    COALESCE(ct.phone_number, lm.pn)   AS phone_number,
    (SELECT m.text FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS last_message_text,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid)                                 AS message_count
  FROM chats c
  LEFT JOIN contacts ct ON ct.jid = c.jid
  LEFT JOIN lid_map  lm ON lm.lid = c.jid
`

export type ChatView = {
  jid: string
  name: string
  is_group: number
  last_message_at: number | null
  unread_count: number
  archived: number
  pinned: number
  muted_until: number | null
  phone_number: string | null
  last_message_text: string | null
  message_count: number
}

export function listChats(opts: {
  limit?: number
  offset?: number
  type?: 'all' | 'dm' | 'group'
  unreadOnly?: boolean
  includeArchived?: boolean
}): ChatView[] {
  const where: string[] = []
  const params: Record<string, string | number | null> = {
    limit: Math.min(Math.max(opts.limit ?? 25, 1), 200),
    offset: Math.max(opts.offset ?? 0, 0)
  }
  if (opts.type === 'dm') where.push('c.is_group = 0')
  if (opts.type === 'group') where.push('c.is_group = 1')
  if (opts.unreadOnly) where.push('c.unread_count > 0')
  if (!opts.includeArchived) where.push('c.archived = 0')

  const sql = `${CHAT_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.pinned DESC, COALESCE(c.last_message_at, 0) DESC
    LIMIT @limit OFFSET @offset`
  return getDb().query(sql).all(params) as ChatView[]
}

export function searchChats(query: string, limit = 20): ChatView[] {
  const q = `%${query.trim().toLowerCase()}%`
  const sql = `${CHAT_SELECT}
    WHERE lower(${CHAT_NAME_SQL}) LIKE @q
       OR lower(c.jid) LIKE @q
       OR lower(COALESCE(ct.phone_number, lm.pn, '')) LIKE @q
    ORDER BY c.pinned DESC, COALESCE(c.last_message_at, 0) DESC
    LIMIT @limit`
  return getDb()
    .query(sql)
    .all({ q, limit: Math.min(Math.max(limit, 1), 100) }) as ChatView[]
}

export function getChat(jid: string): ChatView | null {
  const sql = `${CHAT_SELECT} WHERE c.jid = @jid LIMIT 1`
  return (getDb().query(sql).get({ jid }) as ChatView | undefined) ?? null
}

export type MessageView = MessageRow & { sender_display: string | null }

export function getMessages(opts: {
  chatJid: string
  limit?: number
  before?: number | null
  after?: number | null
}): MessageView[] {
  const where = ['m.chat_jid = @chatJid']
  const params: Record<string, string | number | null> = {
    chatJid: opts.chatJid,
    limit: Math.min(Math.max(opts.limit ?? 50, 1), 500)
  }
  if (opts.before) {
    where.push('m.timestamp < @before')
    params.before = opts.before
  }
  if (opts.after) {
    where.push('m.timestamp > @after')
    params.after = opts.after
  }

  const sql = `
    SELECT
      m.chat_jid, m.msg_id, m.from_me, m.sender_jid, m.sender_name,
      m.timestamp, m.kind, m.text, m.quoted_id, m.media_type, m.filename,
      COALESCE(
        NULLIF(ct.name, ''), NULLIF(ct.notify, ''), NULLIF(m.sender_name, ''),
        NULLIF(ct.phone_number, ''), NULLIF(lm.pn, ''), m.sender_jid
      ) AS sender_display
    FROM messages m
    LEFT JOIN contacts ct ON ct.jid = m.sender_jid
    LEFT JOIN lid_map  lm ON lm.lid = m.sender_jid
    WHERE ${where.join(' AND ')}
    ORDER BY m.timestamp DESC
    LIMIT @limit`
  const rows = getDb().query(sql).all(params) as MessageView[]
  return rows.reverse() // ascending chronological order reads better
}

export function counts(): { chats: number; messages: number; contacts: number } {
  const d = getDb()
  return {
    chats: (d.query('SELECT COUNT(*) n FROM chats').get() as { n: number }).n,
    messages: (d.query('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
    contacts: (d.query('SELECT COUNT(*) n FROM contacts').get() as { n: number }).n
  }
}
