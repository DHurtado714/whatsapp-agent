import assert from 'node:assert/strict'
import fs from 'node:fs'
/**
 * End-to-end test without a real WhatsApp connection:
 *   1. seed SQLite with chats/contacts/messages
 *   2. start the bridge's HTTP API (no Baileys socket)
 *   3. start the MCP server over stdio and exercise it with a real MCP client
 *
 * Runs under Bun (db.ts uses bun:sqlite) and imports straight from src/, so
 * there's no build step. Set WA_TEST_BIN to a compiled binary path to run
 * this same suite against a `bun build --compile` artifact instead of
 * source — CI does this to catch --compile-only failures.
 */
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-test-'))
process.env.WA_AGENT_DIR = TMP
process.env.WA_BRIDGE_PORT = '0' // let the OS pick a free port, avoids clashes in CI
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

// ---------------------------------------------------------------- 1. seed
const db = await import(path.join(ROOT, 'src/shared/db.ts'))

const now = Date.now()
const DAY = 86400000

db.upsertContact({ jid: '15550100001@s.whatsapp.net', phoneNumber: '15550100001', name: 'Alice Johnson' })
db.upsertContact({ jid: '15550100002@s.whatsapp.net', phoneNumber: '15550100002', notify: 'Bob Smith' })
db.upsertContact({ jid: '99887766@lid', lid: '99887766@lid', phoneNumber: '15550100003', name: 'Carol Diaz' })
db.upsertLidMapping('99887766@lid', '15550100003')

db.upsertChat({ jid: '15550100001@s.whatsapp.net', isGroup: false, lastMessageAt: now - 2 * DAY, unreadCount: 3 })
db.upsertChat({ jid: '15550100002@s.whatsapp.net', isGroup: false, lastMessageAt: now - 10 * DAY })
db.upsertChat({ jid: '99887766@lid', isGroup: false, lastMessageAt: now - 1 * DAY })
db.upsertChat({
  jid: '120363000111@g.us',
  name: 'Product Team',
  isGroup: true,
  lastMessageAt: now - 3600_000,
  pinned: true,
})
db.upsertChat({
  jid: '15550100004@s.whatsapp.net',
  name: 'Old Chat',
  isGroup: false,
  lastMessageAt: now - 200 * DAY,
  archived: true,
})

const msgs = []
for (let i = 0; i < 12; i++) {
  msgs.push({
    chat_jid: '120363000111@g.us',
    msg_id: `G${i}`,
    from_me: i % 3 === 0 ? 1 : 0,
    sender_jid: i % 3 === 0 ? null : '15550100001@s.whatsapp.net',
    sender_name: i % 3 === 0 ? null : 'Alice Johnson',
    timestamp: now - (12 - i) * 3600_000,
    kind: 'conversation',
    text: `group message number ${i} about the deploy`,
    quoted_id: null,
    media_type: null,
    filename: null,
    raw: null,
  })
}
msgs.push({
  chat_jid: '15550100001@s.whatsapp.net',
  msg_id: 'M1',
  from_me: 0,
  sender_jid: '15550100001@s.whatsapp.net',
  sender_name: 'Alice Johnson',
  timestamp: now - 2 * DAY,
  kind: 'documentMessage',
  text: null,
  quoted_id: null,
  media_type: 'document',
  filename: 'invoice.pdf',
  raw: null,
})
db.upsertMessages(msgs)

check('seed: counts are correct', () => {
  const c = db.counts()
  assert.equal(c.chats, 5)
  assert.equal(c.messages, 13)
  assert.equal(c.contacts, 3)
})

check('listChats hides archived by default', () => {
  const chats = db.listChats({ limit: 50 })
  assert.equal(chats.length, 4)
  assert.equal(chats[0].jid, '120363000111@g.us', 'the pinned chat comes first')
})

check('listChats include_archived shows them', () => {
  assert.equal(db.listChats({ limit: 50, includeArchived: true }).length, 5)
})

check('chat name falls back to contact when the chat has no name', () => {
  const c = db.getChat('15550100001@s.whatsapp.net')
  assert.equal(c.name, 'Alice Johnson')
  assert.equal(c.phone_number, '15550100001')
})

check('@lid chat resolves name and number via contact/lid_map', () => {
  const c = db.getChat('99887766@lid')
  assert.equal(c.name, 'Carol Diaz')
  assert.equal(c.phone_number, '15550100003')
})

check('searchChats finds by partial name', () => {
  assert.equal(db.searchChats('alic').length, 1)
  assert.equal(db.searchChats('product')[0].jid, '120363000111@g.us')
})

check('searchChats finds by number', () => {
  assert.equal(db.searchChats('15550100002')[0].jid, '15550100002@s.whatsapp.net')
})

check('searchChats finds by notify (pushName)', () => {
  assert.equal(db.searchChats('bob').length, 1)
})

check('getMessages returns ascending chronological order', () => {
  const m = db.getMessages({ chatJid: '120363000111@g.us', limit: 100 })
  assert.equal(m.length, 12)
  assert.ok(m[0].timestamp < m[m.length - 1].timestamp)
})

check('getMessages respects limit and returns the most recent', () => {
  const m = db.getMessages({ chatJid: '120363000111@g.us', limit: 3 })
  assert.equal(m.length, 3)
  assert.equal(m[2].msg_id, 'G11')
})

check('getMessages filters by after', () => {
  const m = db.getMessages({ chatJid: '120363000111@g.us', limit: 100, after: now - 5 * 3600_000 })
  assert.ok(m.length > 0 && m.length < 12)
})

check('upserting a message is idempotent', () => {
  const before = db.counts().messages
  db.upsertMessages([msgs[0]])
  assert.equal(db.counts().messages, before)
})

check('FTS indexes message text', () => {
  const rows = db.getDb().prepare(`SELECT msg_id FROM messages_fts WHERE messages_fts MATCH 'deploy'`).all()
  assert.equal(rows.length, 12)
})

// ---------------------------------------------------------------- 2. bridge HTTP
const { startServer } = await import(path.join(ROOT, 'src/bridge/server.ts'))
const socketMod = await import(path.join(ROOT, 'src/bridge/socket.ts'))
socketMod.state.connection = 'open'
socketMod.state.registered = true
socketMod.state.me = { id: '15551234567@s.whatsapp.net', name: 'Test User' }
socketMod.state.connectedAt = now
socketMod.state.historySync = { received: 13, complete: true, progress: 100 }

const server = startServer()
await new Promise((resolve, reject) => {
  server.once('listening', resolve)
  server.once('error', reject)
})
const port = server.address().port
process.env.WA_BRIDGE_PORT = String(port) // for the MCP child spawned below

const base = `http://127.0.0.1:${port}`
const j = async (p) => (await fetch(base + p)).json()

const status = await j('/status')
check('GET /status reflects the state', () => {
  assert.equal(status.connection, 'open')
  assert.equal(status.me.name, 'Test User')
  assert.equal(status.stored.messages, 13)
})

const putRes = await fetch(base + '/chats', { method: 'PUT' })
check('PUT is rejected (only GET and POST exist)', () => assert.equal(putRes.status, 405))

const postJson = (p, body, extraHeaders = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })

const noScopeRes = await postJson('/send', { chat_jid: '15550100001@s.whatsapp.net', text: 'hi' })
check('POST /send is 403 while no write scope is granted', () => {
  assert.equal(noScopeRes.status, 403)
})
const noScopeBody = await noScopeRes.json()
check('the 403 names the flag needed to enable it', () => {
  assert.match(noScopeBody.error, /--allow=send/)
})

const originRes = await postJson('/send', { chat_jid: 'x', text: 'y' }, { origin: 'https://evil.example.com' })
check('POST carrying an Origin header is refused (browser-originated)', () => {
  assert.equal(originRes.status, 403)
})

const chatsRes = await j('/chats?limit=10&type=group')
check('GET /chats?type=group filters', () => {
  assert.equal(chatsRes.chats.length, 1)
  assert.equal(chatsRes.chats[0].name, 'Product Team')
})

const searchRes = await j('/chats/search?q=carol')
check('GET /chats/search works', () => assert.equal(searchRes.chats[0].name, 'Carol Diaz'))

const msgRes = await j('/messages?chat_jid=120363000111%40g.us&limit=5')
check('GET /messages works', () => {
  assert.equal(msgRes.messages.length, 5)
  assert.equal(msgRes.chat.name, 'Product Team')
})

const badRes = await fetch(base + '/messages')
check('GET /messages without chat_jid returns 400', () => assert.equal(badRes.status, 400))

// ---------------------------------------------------------------- 3. MCP over stdio
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

// WA_TEST_BIN points at a compiled `bun build --compile` artifact — CI uses
// this to run the exact same suite against the distributed binary, not just
// against source, since --compile has its own failure modes (argv shape,
// bundling, codesigning...).
const testBin = process.env.WA_TEST_BIN
const mcpCommand = testBin
  ? { command: testBin, args: ['mcp'] }
  : { command: process.execPath, args: ['run', path.join(ROOT, 'src/cli/index.ts'), 'mcp'] }
const mcpEnv = { ...process.env, WA_AGENT_DIR: TMP, WA_BRIDGE_PORT: String(port) }

// stdio JSON-RPC breaks on a single stray byte on stdout — verify the raw
// transport is clean before layering the SDK's Client on top, so a bug here
// doesn't just look like an inscrutable protocol error later.
{
  const raw = Bun.spawn([mcpCommand.command, ...mcpCommand.args], {
    env: mcpEnv,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  raw.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`)
  raw.stdin.end()
  const chunk = await raw.stdout.getReader().read()
  const firstByte = chunk.value ? String.fromCharCode(chunk.value[0]) : null
  check('mcp subcommand emits clean JSON-RPC on stdout (first byte is "{")', () => {
    assert.equal(firstByte, '{')
  })
  raw.kill()
}

const transport = new StdioClientTransport({ ...mcpCommand, env: mcpEnv, stderr: 'ignore' })
const client = new Client({ name: 'test', version: '1.0.0' })
await client.connect(transport)

const perms = await import(path.join(ROOT, 'src/shared/permissions.ts'))

const tools = await client.listTools()
check('MCP exposes exactly the read tools when no scope is granted', () => {
  const names = tools.tools.map((t) => t.name).sort()
  assert.deepEqual(names, perms.expectedTools(perms.resolvePermissions()))
})

check('tools have an inputSchema with descriptions', () => {
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
  assert.match(rStatus.text, /Connection: open/)
  assert.match(rStatus.text, /13 messages/)
})

const rList = await call('list_chats', { limit: 10 })
check('tool list_chats', () => {
  assert.ok(!rList.isError, rList.text)
  assert.match(rList.text, /Product Team \[group, pinned\]/)
  assert.match(rList.text, /Alice Johnson \[3 unread\]/)
  assert.match(rList.text, /phone: \+15550100001/)
})

const rListGroups = await call('list_chats', { type: 'group' })
check('tool list_chats type=group', () => {
  assert.match(rListGroups.text, /^1 chats:/)
})

const rSearch = await call('search_chats', { query: 'product' })
check('tool search_chats', () => {
  assert.ok(!rSearch.isError, rSearch.text)
  assert.match(rSearch.text, /120363000111@g\.us/)
})

const rMsgJid = await call('get_messages', { chat: '120363000111@g.us', limit: 5 })
check('tool get_messages by jid', () => {
  assert.ok(!rMsgJid.isError, rMsgJid.text)
  assert.match(rMsgJid.text, /Product Team — group/)
  assert.match(rMsgJid.text, /group message number 11/)
  assert.match(rMsgJid.text, /more messages/)
})

const rMsgName = await call('get_messages', { chat: 'Product Team' })
check('tool get_messages resolving by name', () => {
  assert.ok(!rMsgName.isError, rMsgName.text)
  assert.match(rMsgName.text, /12 messages/)
})

const rMsgPhone = await call('get_messages', { chat: '15550100001' })
check('tool get_messages resolving by number + media', () => {
  assert.ok(!rMsgPhone.isError, rMsgPhone.text)
  assert.match(rMsgPhone.text, /\[document: invoice\.pdf\]/)
})

const rMsgRel = await call('get_messages', { chat: '120363000111@g.us', since: '5h' })
check('tool get_messages with relative since', () => {
  assert.ok(!rMsgRel.isError, rMsgRel.text)
  assert.ok(/([1-5]) messages,/.test(rMsgRel.text), rMsgRel.text.split('\n')[1])
})

const rMsgNone = await call('get_messages', { chat: 'no-such-chat-xyz' })
check('tool get_messages with a nonexistent chat gives a useful error', () => {
  assert.ok(rMsgNone.isError)
  assert.match(rMsgNone.text, /Could not find any chat/)
})

const rAmbiguous = await call('get_messages', { chat: '1555010000' })
check('tool get_messages ambiguous match asks to disambiguate', () => {
  assert.match(rAmbiguous.text, /matches several chats/)
})

// ---------------------------------------------------------------- 4. write mode (dry run)
// Grant everything on the already-running bridge, with dry-run on so nothing
// can reach WhatsApp: there's no socket in this process anyway, and dry-run
// short-circuits before any action would ask for one.
const actions = await import(path.join(ROOT, 'src/bridge/actions.ts'))
process.env.WA_ALLOW = 'all'
process.env.WA_DRY_RUN = 'true'
actions.setPermissions(perms.resolvePermissions())

const statusWrite = await j('/status')
check('GET /status reports the granted scopes', () => {
  assert.deepEqual(statusWrite.permissions.scopes, ['send', 'media', 'chats', 'groups'])
  assert.equal(statusWrite.permissions.dry_run, true)
  assert.equal(statusWrite.permissions.allow_new_contacts, false)
})

const permRes = await j('/permissions')
check('GET /permissions works', () => assert.equal(permRes.read_only, false))

const sendRes = await postJson('/send', { chat_jid: '15550100001@s.whatsapp.net', text: 'hello there' })
const sendBody = await sendRes.json()
check('POST /send in dry-run reports what it would do', () => {
  assert.equal(sendRes.status, 200)
  assert.equal(sendBody.dry_run, true)
  assert.equal(sendBody.would.text, 'hello there')
})

const strangerRes = await postJson('/send', { chat_jid: '15559999999@s.whatsapp.net', text: 'hi' })
const strangerBody = await strangerRes.json()
check('POST /send to a number with no stored chat is refused', () => {
  assert.equal(strangerRes.status, 403)
  assert.match(strangerBody.error, /--allow-new-contacts/)
})

const badJidRes = await postJson('/send', { chat_jid: 'not-a-jid', text: 'hi' })
check('POST /send with an unusable chat identifier is a 400', () => {
  assert.equal(badJidRes.status, 400)
})

const emptyBodyRes = await fetch(base + '/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: 'not json',
})
check('a malformed JSON body is a 400, not a 500', () => assert.equal(emptyBodyRes.status, 400))

const missingMsgRes = await postJson('/react', { chat_jid: '120363000111@g.us', msg_id: 'NOPE', emoji: '👍' })
check('reacting to an unknown msg_id is a 404', () => assert.equal(missingMsgRes.status, 404))

const groupUpdateRes = await postJson('/group/update', { group_jid: '120363000111@g.us', subject: 'Renamed' })
const groupUpdateBody = await groupUpdateRes.json()
check('POST /group/update in dry-run reports the rename', () => {
  assert.equal(groupUpdateRes.status, 200)
  assert.equal(groupUpdateBody.would.subject, 'Renamed')
})

const notAGroupRes = await postJson('/group/update', { group_jid: '15550100001@s.whatsapp.net', subject: 'x' })
check('POST /group/update on a non-group is a 400', () => assert.equal(notAGroupRes.status, 400))

// A second MCP process, this time with the write scopes, to confirm the tool
// list grows and a write tool round-trips end to end.
const writeEnv = { ...mcpEnv, WA_ALLOW: 'send,chats' }
const writeTransport = new StdioClientTransport({ ...mcpCommand, env: writeEnv, stderr: 'ignore' })
const writeClient = new Client({ name: 'test-write', version: '1.0.0' })
await writeClient.connect(writeTransport)

const writeTools = await writeClient.listTools()
check('MCP exposes the write tools for the granted scopes only', () => {
  const names = writeTools.tools.map((t) => t.name).sort()
  const expected = perms.expectedTools({ scopes: perms.parseScopes('send,chats') })
  assert.deepEqual(names, expected)
  assert.ok(!names.includes('send_media'), 'media was not granted')
  assert.ok(!names.includes('create_group'), 'groups was not granted')
})

check('write tools are annotated as non-read-only', () => {
  const sm = writeTools.tools.find((t) => t.name === 'send_message')
  assert.equal(sm.annotations.readOnlyHint, false)
  const dm = writeTools.tools.find((t) => t.name === 'delete_message')
  assert.equal(dm.annotations.destructiveHint, true)
})

const callWrite = async (name, args = {}) => {
  const r = await writeClient.callTool({ name, arguments: args })
  return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) }
}

const rSend = await callWrite('send_message', { chat: 'Alice Johnson', text: 'ping from the e2e suite' })
check('tool send_message resolves a name and reports the dry run', () => {
  assert.ok(!rSend.isError, rSend.text)
  assert.match(rSend.text, /DRY RUN/)
  assert.match(rSend.text, /ping from the e2e suite/)
})

const rAmbiguousSend = await callWrite('send_message', { chat: '1555010000', text: 'nope' })
check('an ambiguous chat is a hard failure for a write, not a guess', () => {
  assert.ok(rAmbiguousSend.isError)
  assert.match(rAmbiguousSend.text, /nothing was sent/)
})

const rNoSuchSend = await callWrite('send_message', { chat: 'definitely-not-a-chat', text: 'nope' })
check('sending to an unknown chat name fails without sending', () => {
  assert.ok(rNoSuchSend.isError)
  assert.match(rNoSuchSend.text, /Nothing was sent/)
})

const rOutOfScope = await callWrite('send_typing', { chat: 'Alice Johnson', state: 'composing' })
check('a chats-scope tool works when chats is granted', () => {
  assert.ok(!rOutOfScope.isError, rOutOfScope.text)
})

await writeClient.close()

// Back to read-only, so the bridge-down check below isn't affected by scopes.
// biome-ignore lint/performance/noDelete: process.env needs a real delete
delete process.env.WA_ALLOW
// biome-ignore lint/performance/noDelete: process.env needs a real delete
delete process.env.WA_DRY_RUN
actions.setPermissions(perms.resolvePermissions())

// ---------------------------------------------------------------- 5. bridge down -> actionable error
await new Promise((r) => server.close(r))
const rDown = await call('list_chats')
check('with the bridge down the error explains what to do', () => {
  assert.ok(rDown.isError)
  assert.match(rDown.text, /Could not connect to the WhatsApp bridge/)
  assert.match(rDown.text, /whatsapp-agent bridge/)
})

await client.close()

// ---------------------------------------------------------------- report
const failed = results.filter(([s]) => s === 'FAIL')
for (const [s, n] of results) console.log(`${s === 'PASS' ? '  ok  ' : '  FAIL'}  ${n}`)
console.log(`\n${results.length - failed.length}/${results.length} tests passed`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
