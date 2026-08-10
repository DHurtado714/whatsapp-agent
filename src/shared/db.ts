import Database from 'better-sqlite3'
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

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  ensureDataDir()
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(d: Database.Database): void {
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

    -- Mapeo LID <-> numero telefonico. WhatsApp migro a direcciones @lid y
    -- sin esto muchos chats se ven como identificadores opacos.
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

    -- FTS5 listo para la fase 2 (busqueda de texto en todo el historial).
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      chat_jid UNINDEXED,
      msg_id   UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `)
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value)
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
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
  // COALESCE(excluded.x, x) => nunca sobreescribimos un dato bueno con null.
  getDb()
    .prepare(
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
    .prepare(`INSERT INTO lid_map (lid, pn) VALUES (?, ?)
              ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn`)
    .run(lid, pn)
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
    .prepare(
      // En el INSERT damos defaults; en el UPDATE referenciamos los parametros
      // (no `excluded`) para que un campo omitido NO pise el valor ya guardado.
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
  getDb().prepare(
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
  getDb().prepare(`DELETE FROM messages_fts WHERE chat_jid = ? AND msg_id = ?`)
const ftsInsertStmt = () =>
  getDb().prepare(`INSERT INTO messages_fts (text, chat_jid, msg_id) VALUES (?, ?, ?)`)

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
        ftsDel.run(r.chat_jid, r.msg_id)
        ftsIns.run(r.text, r.chat_jid, r.msg_id)
      }
    }
  })
  run(rows)
  return rows.length
}

// ---------------------------------------------------------------- lecturas

/**
 * Nombre legible de un chat, con degradacion elegante:
 *   nombre del chat -> contacto guardado -> pushName -> numero -> jid crudo
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
  const params: Record<string, unknown> = {
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
  return getDb().prepare(sql).all(params) as ChatView[]
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
    .prepare(sql)
    .all({ q, limit: Math.min(Math.max(limit, 1), 100) }) as ChatView[]
}

export function getChat(jid: string): ChatView | null {
  const sql = `${CHAT_SELECT} WHERE c.jid = @jid LIMIT 1`
  return (getDb().prepare(sql).get({ jid }) as ChatView | undefined) ?? null
}

export type MessageView = MessageRow & { sender_display: string | null }

export function getMessages(opts: {
  chatJid: string
  limit?: number
  before?: number | null
  after?: number | null
}): MessageView[] {
  const where = ['m.chat_jid = @chatJid']
  const params: Record<string, unknown> = {
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
  const rows = getDb().prepare(sql).all(params) as MessageView[]
  return rows.reverse() // cronologico ascendente: se lee mejor
}

export function counts(): { chats: number; messages: number; contacts: number } {
  const d = getDb()
  return {
    chats: (d.prepare('SELECT COUNT(*) n FROM chats').get() as { n: number }).n,
    messages: (d.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
    contacts: (d.prepare('SELECT COUNT(*) n FROM contacts').get() as { n: number }).n
  }
}
