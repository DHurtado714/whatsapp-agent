/**
 * Prueba end-to-end sin WhatsApp real:
 *   1. parseMessage contra formas de mensaje reales de WhatsApp
 *   2. siembra SQLite con chats/contactos/mensajes
 *   3. levanta el bridge HTTP (sin socket de Baileys)
 *   4. levanta el MCP por stdio y lo ejercita con un cliente MCP real
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-test-'))
process.env.WA_AGENT_DIR = TMP
process.env.WA_BRIDGE_PORT = '8899'
process.env.WA_LOG_LEVEL = 'error'

const ROOT = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push(['PASS', name])
  } catch (err) {
    results.push(['FAIL', `${name} -> ${err.message}`])
  }
}

// ---------------------------------------------------------------- 1. parseMessage
const { parseMessage, toMillis } = await import(path.join(ROOT, 'dist/shared/message.js'))

check('texto simple', () => {
  const r = parseMessage({ message: { conversation: 'hola mundo' } })
  assert.equal(r.text, 'hola mundo')
  assert.equal(r.kind, 'conversation')
})

check('extendedTextMessage con cita', () => {
  const r = parseMessage({
    message: {
      extendedTextMessage: { text: 'te respondo esto', contextInfo: { stanzaId: 'ABC123' } }
    }
  })
  assert.equal(r.text, 'te respondo esto')
  assert.equal(r.quotedId, 'ABC123')
})

check('imagen con caption', () => {
  const r = parseMessage({ message: { imageMessage: { caption: 'mira esto', mimetype: 'image/jpeg' } } })
  assert.equal(r.text, 'mira esto')
  assert.equal(r.mediaType, 'image')
})

check('documento con nombre de archivo', () => {
  const r = parseMessage({ message: { documentMessage: { fileName: 'factura.pdf' } } })
  assert.equal(r.mediaType, 'document')
  assert.equal(r.filename, 'factura.pdf')
})

check('nota de voz', () => {
  const r = parseMessage({ message: { audioMessage: { ptt: true, seconds: 12 } } })
  assert.equal(r.mediaType, 'audio')
  assert.equal(r.text, '[nota de voz]')
})

check('envoltura ephemeral se desanida', () => {
  const r = parseMessage({
    message: { ephemeralMessage: { message: { conversation: 'mensaje temporal' } } }
  })
  assert.equal(r.text, 'mensaje temporal')
})

check('viewOnce se desanida', () => {
  const r = parseMessage({
    message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'una sola vez' } } } }
  })
  assert.equal(r.mediaType, 'image')
  assert.equal(r.text, 'una sola vez')
})

check('mensaje vacio no revienta', () => {
  const r = parseMessage({ message: null })
  assert.equal(r.kind, 'unknown')
  assert.equal(r.text, null)
})

check('timestamps en segundos se convierten a ms', () => {
  assert.equal(toMillis(1754600000), 1754600000000)
  assert.equal(toMillis(1754600000000), 1754600000000)
  assert.equal(toMillis({ toNumber: () => 1754600000 }), 1754600000000)
})

// ---------------------------------------------------------------- 2. seed
const db = await import(path.join(ROOT, 'dist/shared/db.js'))

const now = Date.now()
const DAY = 86400000

db.upsertContact({ jid: '573001112222@s.whatsapp.net', phoneNumber: '573001112222', name: 'Maria Gomez' })
db.upsertContact({ jid: '573009998888@s.whatsapp.net', phoneNumber: '573009998888', notify: 'Carlos' })
db.upsertContact({ jid: '99887766@lid', lid: '99887766@lid', phoneNumber: '573005554444', name: 'Ana Lopez' })
db.upsertLidMapping('99887766@lid', '573005554444')

db.upsertChat({ jid: '573001112222@s.whatsapp.net', isGroup: false, lastMessageAt: now - 2 * DAY, unreadCount: 3 })
db.upsertChat({ jid: '573009998888@s.whatsapp.net', isGroup: false, lastMessageAt: now - 10 * DAY })
db.upsertChat({ jid: '99887766@lid', isGroup: false, lastMessageAt: now - 1 * DAY })
db.upsertChat({ jid: '120363000111@g.us', name: 'Equipo Capa', isGroup: true, lastMessageAt: now - 3600_000, pinned: true })
db.upsertChat({ jid: '573007776666@s.whatsapp.net', name: 'Viejo', isGroup: false, lastMessageAt: now - 200 * DAY, archived: true })

const msgs = []
for (let i = 0; i < 12; i++) {
  msgs.push({
    chat_jid: '120363000111@g.us',
    msg_id: `G${i}`,
    from_me: i % 3 === 0 ? 1 : 0,
    sender_jid: i % 3 === 0 ? null : '573001112222@s.whatsapp.net',
    sender_name: i % 3 === 0 ? null : 'Maria Gomez',
    timestamp: now - (12 - i) * 3600_000,
    kind: 'conversation',
    text: `mensaje de grupo numero ${i} sobre el deploy`,
    quoted_id: null,
    media_type: null,
    filename: null,
    raw: null
  })
}
msgs.push({
  chat_jid: '573001112222@s.whatsapp.net',
  msg_id: 'M1',
  from_me: 0,
  sender_jid: '573001112222@s.whatsapp.net',
  sender_name: 'Maria Gomez',
  timestamp: now - 2 * DAY,
  kind: 'documentMessage',
  text: null,
  quoted_id: null,
  media_type: 'document',
  filename: 'contrato.pdf',
  raw: null
})
db.upsertMessages(msgs)

check('seed: conteos correctos', () => {
  const c = db.counts()
  assert.equal(c.chats, 5)
  assert.equal(c.messages, 13)
  assert.equal(c.contacts, 3)
})

check('listChats oculta archivados por defecto', () => {
  const chats = db.listChats({ limit: 50 })
  assert.equal(chats.length, 4)
  assert.equal(chats[0].jid, '120363000111@g.us', 'el chat fijado va primero')
})

check('listChats include_archived los muestra', () => {
  assert.equal(db.listChats({ limit: 50, includeArchived: true }).length, 5)
})

check('nombre de chat cae al contacto cuando el chat no tiene nombre', () => {
  const c = db.getChat('573001112222@s.whatsapp.net')
  assert.equal(c.name, 'Maria Gomez')
  assert.equal(c.phone_number, '573001112222')
})

check('chat @lid resuelve nombre y numero via contacto/lid_map', () => {
  const c = db.getChat('99887766@lid')
  assert.equal(c.name, 'Ana Lopez')
  assert.equal(c.phone_number, '573005554444')
})

check('searchChats encuentra por nombre parcial', () => {
  assert.equal(db.searchChats('mari').length, 1)
  assert.equal(db.searchChats('capa')[0].jid, '120363000111@g.us')
})

check('searchChats encuentra por numero', () => {
  assert.equal(db.searchChats('573009998888')[0].jid, '573009998888@s.whatsapp.net')
})

check('searchChats por notify (pushName)', () => {
  assert.equal(db.searchChats('carlos').length, 1)
})

check('getMessages devuelve orden cronologico ascendente', () => {
  const m = db.getMessages({ chatJid: '120363000111@g.us', limit: 100 })
  assert.equal(m.length, 12)
  assert.ok(m[0].timestamp < m[m.length - 1].timestamp)
})

check('getMessages respeta limit y devuelve los mas recientes', () => {
  const m = db.getMessages({ chatJid: '120363000111@g.us', limit: 3 })
  assert.equal(m.length, 3)
  assert.equal(m[2].msg_id, 'G11')
})

check('getMessages filtra por after', () => {
  const m = db.getMessages({ chatJid: '120363000111@g.us', limit: 100, after: now - 5 * 3600_000 })
  assert.ok(m.length > 0 && m.length < 12)
})

check('upsert de mensaje es idempotente', () => {
  const before = db.counts().messages
  db.upsertMessages([msgs[0]])
  assert.equal(db.counts().messages, before)
})

check('FTS indexa el texto de los mensajes', () => {
  const rows = db.getDb().prepare(`SELECT msg_id FROM messages_fts WHERE messages_fts MATCH 'deploy'`).all()
  assert.equal(rows.length, 12)
})

// ---------------------------------------------------------------- 3. bridge HTTP
const { startServer } = await import(path.join(ROOT, 'dist/bridge/server.js'))
const socketMod = await import(path.join(ROOT, 'dist/bridge/socket.js'))
socketMod.state.connection = 'open'
socketMod.state.registered = true
socketMod.state.me = { id: '573001234567@s.whatsapp.net', name: 'Daniel' }
socketMod.state.connectedAt = now
socketMod.state.historySync = { received: 13, complete: true, progress: 100 }

const server = startServer()
await new Promise((r) => setTimeout(r, 400))

const base = 'http://127.0.0.1:8899'
const j = async (p) => (await fetch(base + p)).json()

const status = await j('/status')
check('GET /status refleja el estado', () => {
  assert.equal(status.connection, 'open')
  assert.equal(status.me.name, 'Daniel')
  assert.equal(status.stored.messages, 13)
})

check('POST es rechazado (bridge de solo lectura)', async () => {})
const postRes = await fetch(base + '/chats', { method: 'POST' })
check('POST devuelve 405', () => assert.equal(postRes.status, 405))

const chatsRes = await j('/chats?limit=10&type=group')
check('GET /chats?type=group filtra', () => {
  assert.equal(chatsRes.chats.length, 1)
  assert.equal(chatsRes.chats[0].name, 'Equipo Capa')
})

const searchRes = await j('/chats/search?q=ana')
check('GET /chats/search funciona', () => assert.equal(searchRes.chats[0].name, 'Ana Lopez'))

const msgRes = await j('/messages?chat_jid=120363000111%40g.us&limit=5')
check('GET /messages funciona', () => {
  assert.equal(msgRes.messages.length, 5)
  assert.equal(msgRes.chat.name, 'Equipo Capa')
})

check('GET /messages sin chat_jid da 400', async () => {})
const badRes = await fetch(base + '/messages')
check('GET /messages sin chat_jid devuelve 400', () => assert.equal(badRes.status, 400))

// ---------------------------------------------------------------- 4. MCP por stdio
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist/mcp/index.js')],
  env: { ...process.env, WA_AGENT_DIR: TMP, WA_BRIDGE_PORT: '8899' },
  stderr: 'ignore'
})
const client = new Client({ name: 'test', version: '1.0.0' })
await client.connect(transport)

const tools = await client.listTools()
check('MCP expone los 4 tools', () => {
  const names = tools.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['get_messages', 'list_chats', 'search_chats', 'whatsapp_status'])
})

check('los tools tienen inputSchema con descripciones', () => {
  const gm = tools.tools.find((t) => t.name === 'get_messages')
  assert.ok(gm.inputSchema.properties.chat.description.length > 10)
  assert.deepEqual(gm.inputSchema.required, ['chat'])
})

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) }
}

const rStatus = await call('whatsapp_status')
check('tool whatsapp_status', () => {
  assert.ok(!rStatus.isError, rStatus.text)
  assert.match(rStatus.text, /Conexion: open/)
  assert.match(rStatus.text, /13 mensajes/)
})

const rList = await call('list_chats', { limit: 10 })
check('tool list_chats', () => {
  assert.ok(!rList.isError, rList.text)
  assert.match(rList.text, /Equipo Capa \[grupo, fijado\]/)
  assert.match(rList.text, /Maria Gomez \[3 sin leer\]/)
  assert.match(rList.text, /tel: \+573001112222/)
})

const rListGroups = await call('list_chats', { type: 'group' })
check('tool list_chats type=group', () => {
  assert.match(rListGroups.text, /^1 chats:/)
})

const rSearch = await call('search_chats', { query: 'capa' })
check('tool search_chats', () => {
  assert.ok(!rSearch.isError, rSearch.text)
  assert.match(rSearch.text, /120363000111@g\.us/)
})

const rMsgJid = await call('get_messages', { chat: '120363000111@g.us', limit: 5 })
check('tool get_messages por jid', () => {
  assert.ok(!rMsgJid.isError, rMsgJid.text)
  assert.match(rMsgJid.text, /Equipo Capa — grupo/)
  assert.match(rMsgJid.text, /mensaje de grupo numero 11/)
  assert.match(rMsgJid.text, /Hay mas mensajes/)
})

const rMsgName = await call('get_messages', { chat: 'Equipo Capa' })
check('tool get_messages resolviendo por nombre', () => {
  assert.ok(!rMsgName.isError, rMsgName.text)
  assert.match(rMsgName.text, /12 mensajes/)
})

const rMsgPhone = await call('get_messages', { chat: '573001112222' })
check('tool get_messages resolviendo por numero + media', () => {
  assert.ok(!rMsgPhone.isError, rMsgPhone.text)
  assert.match(rMsgPhone.text, /\[document: contrato\.pdf\]/)
})

const rMsgRel = await call('get_messages', { chat: '120363000111@g.us', since: '5h' })
check('tool get_messages con since relativo', () => {
  assert.ok(!rMsgRel.isError, rMsgRel.text)
  assert.ok(/([1-5]) mensajes,/.test(rMsgRel.text), rMsgRel.text.split('\n')[1])
})

const rMsgNone = await call('get_messages', { chat: 'no-existe-este-chat-xyz' })
check('tool get_messages con chat inexistente da error util', () => {
  assert.ok(rMsgNone.isError)
  assert.match(rMsgNone.text, /No encontre ningun chat/)
})

const rAmbiguous = await call('get_messages', { chat: '5730' })
check('tool get_messages ambiguo pide desambiguar', () => {
  assert.match(rAmbiguous.text, /coincide con varios chats/)
})

// bridge caido -> mensaje accionable
await new Promise((r) => server.close(r))
const rDown = await call('list_chats')
check('con el bridge caido el error explica que hacer', () => {
  assert.ok(rDown.isError)
  assert.match(rDown.text, /No pude conectarme al bridge/)
  assert.match(rDown.text, /wa-bridge/)
})

await client.close()

// ---------------------------------------------------------------- reporte
const failed = results.filter(([s]) => s === 'FAIL')
for (const [s, n] of results) console.log(`${s === 'PASS' ? '  ok  ' : '  FAIL'}  ${n}`)
console.log(`\n${results.length - failed.length}/${results.length} pruebas pasaron`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
