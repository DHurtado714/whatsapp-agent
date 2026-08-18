import fs from 'node:fs'
import type { AnyMessageContent, WAMessage, WAMessageKey, WAPresence } from 'baileys'

import { chatExists, getLastInboundMessageKey, getLastMessageKey, getStoredMessage } from '../shared/db.js'
import {
  type Permissions,
  type Scope,
  hasScope,
  isReadOnly,
  resolvePermissions,
  scopeList,
} from '../shared/permissions.js'
import { getSocket, ingestMessages, state } from './socket.js'

/**
 * Every mutation the bridge can perform, as plain async functions over the
 * socket and the local database. Deliberately free of HTTP: server.ts is a
 * thin translation layer on top of this, and the unit tests drive these
 * functions directly against a stub socket, with no live WhatsApp session and
 * no listening port.
 */

// ---------------------------------------------------------------- errors

/** Carries the HTTP status the bridge should answer with, so server.ts doesn't have to classify failures. */
export class ActionError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ActionError'
    this.status = status
  }
}

const badRequest = (msg: string) => new ActionError(400, msg)
const forbidden = (msg: string) => new ActionError(403, msg)
const notFound = (msg: string) => new ActionError(404, msg)

// ---------------------------------------------------------------- permissions state

let permissions: Permissions | null = null

/** Called once by the bridge at startup with the flag/env-resolved permissions. */
export function setPermissions(p: Permissions): void {
  permissions = p
}

export function getPermissions(): Permissions {
  if (!permissions) permissions = resolvePermissions()
  return permissions
}

function requireScope(scope: Scope): Permissions {
  const perms = getPermissions()
  if (!hasScope(perms, scope)) {
    const current = isReadOnly(perms) ? 'read-only' : `read + ${scopeList(perms).join(', ')}`
    throw forbidden(
      `the "${scope}" permission is not granted (this bridge is running ${current}). ` +
        `Restart it with --allow=${scope} (or WA_ALLOW=${scope}) to enable it.`,
    )
  }
  return perms
}

// ---------------------------------------------------------------- socket

/**
 * The subset of the Baileys socket the write path touches. Narrowing it to an
 * interface is what makes these actions testable: the stub in actions.test.ts
 * implements this and nothing more.
 */
export type WriteSocket = {
  sendMessage(jid: string, content: AnyMessageContent, options?: Record<string, unknown>): Promise<unknown>
  readMessages(keys: WAMessageKey[]): Promise<void>
  chatModify(modification: any, jid: string): Promise<void>
  sendPresenceUpdate(type: WAPresence, toJid?: string): Promise<void>
  groupCreate(subject: string, participants: string[]): Promise<{ id: string; subject?: string }>
  groupParticipantsUpdate(jid: string, participants: string[], action: string): Promise<unknown>
  groupUpdateSubject(jid: string, subject: string): Promise<void>
  groupUpdateDescription(jid: string, description?: string): Promise<void>
  groupLeave(jid: string): Promise<void>
  groupInviteCode(jid: string): Promise<string | undefined>
  groupRevokeInvite(jid: string): Promise<string | undefined>
}

let socketOverride: WriteSocket | null = null

/**
 * Test-only: swap in a stub socket, bypassing the real connection check. Pass
 * null to go back to the real one. Mirrors __resetForTests in shared/db.ts.
 */
export function __setSocketForTests(stub: WriteSocket | null): void {
  socketOverride = stub
}

function requireSocket(): WriteSocket {
  if (socketOverride) return socketOverride
  const sock = getSocket()
  if (!sock || state.connection !== 'open') {
    throw new ActionError(
      503,
      `not connected to WhatsApp (connection: ${state.connection}). ` +
        `Check "whatsapp-agent status" — the bridge may still be linking or reconnecting.`,
    )
  }
  return sock as unknown as WriteSocket
}

// ---------------------------------------------------------------- rate limiting

let sendTimes: number[] = []

/** Test-only: forget the send history so a rate-limit test can't leak into the next one. */
export function __resetRateLimitForTests(): void {
  sendTimes = []
}

/**
 * Sliding one-minute window over outbound *messages*. Reactions, typing and
 * chat metadata deliberately don't consume budget: the limit exists to stop a
 * looping agent from spamming a human (and from getting the account flagged),
 * and those three aren't visible as messages.
 */
function consumeSendBudget(): void {
  const limit = getPermissions().sendRateLimit
  if (limit === 0) return
  const now = Date.now()
  sendTimes = sendTimes.filter((t) => now - t < 60_000)
  if (sendTimes.length >= limit) {
    const waitMs = 60_000 - (now - sendTimes[0])
    throw new ActionError(
      429,
      `send rate limit reached (${limit} messages/minute). Try again in ${Math.ceil(waitMs / 1000)}s, ` +
        `or raise it with --rate-limit=<n> (0 disables it).`,
    )
  }
  sendTimes.push(now)
}

// ---------------------------------------------------------------- jid handling

const JID_SUFFIXES = ['@s.whatsapp.net', '@g.us', '@lid', '@newsletter', '@broadcast']

/** Accepts a full JID or a bare phone number; anything else is rejected rather than guessed at. */
export function normalizeJid(input: string): string {
  const trimmed = (input ?? '').trim()
  if (trimmed === '') throw badRequest('missing chat identifier')
  if (trimmed.includes('@')) {
    if (!JID_SUFFIXES.some((s) => trimmed.endsWith(s))) {
      throw badRequest(`"${trimmed}" is not a valid WhatsApp JID (expected one of ${JID_SUFFIXES.join(', ')})`)
    }
    return trimmed
  }
  const digits = trimmed.replace(/[^\d]/g, '')
  if (digits.length < 6) {
    throw badRequest(`"${trimmed}" is neither a JID nor a plausible phone number`)
  }
  return `${digits}@s.whatsapp.net`
}

/**
 * The "no new contacts" guardrail. An agent that has hallucinated a phone
 * number will otherwise happily message a stranger, which is the single worst
 * failure mode of a write-enabled assistant — so by default we only write to
 * chats we've actually seen.
 */
function assertKnownChat(jid: string): void {
  if (getPermissions().allowNewContacts) return
  if (chatExists(jid)) return
  throw forbidden(
    `${jid} has no stored chat, so it looks like a new contact. ` +
      `Use list_chats or search_chats to confirm the right chat exists, ` +
      `or restart the bridge with --allow-new-contacts to permit writing to unknown numbers.`,
  )
}

// ---------------------------------------------------------------- shared helpers

type DryRun = { dry_run: true; action: string; would: Record<string, unknown> }

function dryRun(action: string, would: Record<string, unknown>): DryRun | null {
  return getPermissions().dryRun ? { dry_run: true, action, would } : null
}

/**
 * Rebuilds a quoted WAMessage from what we stored. `raw` is only kept for our
 * own and media messages (see ingestMessages), so for an inbound text we fall
 * back to a synthetic { conversation } body: the stanzaId link that makes it a
 * real reply is carried by the key either way, only the quoted preview text
 * may differ from what the other side originally sent.
 */
function quotedFrom(chatJid: string, msgId: string): WAMessage {
  const stored = requireStored(chatJid, msgId)
  let message: unknown = null
  if (stored.raw) {
    try {
      message = JSON.parse(stored.raw)
    } catch {
      /* fall through to the synthetic body */
    }
  }
  if (!message) message = { conversation: stored.text ?? '' }
  return { key: stored.key, message, messageTimestamp: stored.messageTimestamp } as unknown as WAMessage
}

function requireStored(chatJid: string, msgId: string) {
  const stored = getStoredMessage(chatJid, msgId)
  if (!stored) {
    throw notFound(
      `no stored message ${msgId} in ${chatJid}. Read the chat with get_messages first — ` +
        `only messages present in the local database can be referenced.`,
    )
  }
  return stored
}

/** lastMessages is required by every chatModify that acts on a position in the chat. */
function lastMessageList(chatJid: string) {
  const last = getLastMessageKey(chatJid)
  if (!last) throw badRequest(`no stored messages in ${chatJid}, so WhatsApp has no position to anchor this change to`)
  return [{ key: last.key, messageTimestamp: last.messageTimestamp }]
}

/** Result shape shared by everything that sends: enough for the caller to reference the message later. */
function sentResult(chatJid: string, sent: unknown) {
  const msg = sent as WAMessage | undefined
  if (msg?.key) {
    // Reflect it immediately so a follow-up get_messages shows it instead of
    // racing the messages.upsert event that WhatsApp will echo back to us.
    try {
      ingestMessages([msg])
    } catch {
      /* the echoed event will store it a moment later; not worth failing the send over */
    }
  }
  return { ok: true, chat_jid: chatJid, msg_id: msg?.key?.id ?? null }
}

// ---------------------------------------------------------------- send

export type SendTextInput = {
  chat_jid: string
  text: string
  reply_to?: string | null
  mentions?: string[] | null
}

export async function sendText(input: SendTextInput) {
  requireScope('send')
  const jid = normalizeJid(input.chat_jid)
  assertKnownChat(jid)
  const text = (input.text ?? '').trim()
  if (text === '') throw badRequest('text is empty')

  const mentions = (input.mentions ?? []).map(normalizeJid)
  const dry = dryRun('send_message', { chat_jid: jid, text, reply_to: input.reply_to ?? null, mentions })
  if (dry) return dry

  consumeSendBudget()
  const sock = requireSocket()
  const quoted = input.reply_to ? quotedFrom(jid, input.reply_to) : undefined
  const sent = await sock.sendMessage(jid, { text, ...(mentions.length ? { mentions } : {}) }, quoted ? { quoted } : {})
  return sentResult(jid, sent)
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export type SendMediaInput = {
  chat_jid: string
  kind: MediaKind
  path?: string | null
  url?: string | null
  caption?: string | null
  filename?: string | null
  mimetype?: string | null
  voice_note?: boolean | null
  reply_to?: string | null
}

export async function sendMedia(input: SendMediaInput) {
  requireScope('media')
  const jid = normalizeJid(input.chat_jid)
  assertKnownChat(jid)

  // Exactly one source, and a local path must exist and be a regular file —
  // otherwise Baileys fails deep inside the upload with an opaque error.
  const hasPath = Boolean(input.path)
  const hasUrl = Boolean(input.url)
  if (hasPath === hasUrl) throw badRequest('provide exactly one of path (a local file) or url (http/https)')
  if (hasUrl && !/^https?:\/\//i.test(input.url!)) throw badRequest('url must start with http:// or https://')
  if (hasPath) {
    let stat: fs.Stats
    try {
      stat = fs.statSync(input.path!)
    } catch {
      throw badRequest(`no such file: ${input.path}`)
    }
    if (!stat.isFile()) throw badRequest(`not a regular file: ${input.path}`)
  }

  const source = { url: (input.path ?? input.url)! }
  const caption = input.caption?.trim() || undefined
  const dry = dryRun('send_media', {
    chat_jid: jid,
    kind: input.kind,
    source: source.url,
    caption: caption ?? null,
    reply_to: input.reply_to ?? null,
  })
  if (dry) return dry

  let content: AnyMessageContent
  switch (input.kind) {
    case 'image':
      content = { image: source, caption }
      break
    case 'video':
      content = { video: source, caption }
      break
    case 'audio':
      content = { audio: source, ptt: Boolean(input.voice_note), mimetype: input.mimetype ?? 'audio/mp4' }
      break
    case 'sticker':
      content = { sticker: source }
      break
    case 'document':
      content = {
        document: source,
        mimetype: input.mimetype ?? 'application/octet-stream',
        fileName: input.filename ?? undefined,
        caption,
      }
      break
    default:
      throw badRequest(`unknown media kind "${input.kind}"`)
  }

  consumeSendBudget()
  const sock = requireSocket()
  const quoted = input.reply_to ? quotedFrom(jid, input.reply_to) : undefined
  const sent = await sock.sendMessage(jid, content, quoted ? { quoted } : {})
  return sentResult(jid, sent)
}

// ---------------------------------------------------------------- react / edit / delete

export async function reactToMessage(input: { chat_jid: string; msg_id: string; emoji: string }) {
  requireScope('send')
  const jid = normalizeJid(input.chat_jid)
  assertKnownChat(jid)
  const stored = requireStored(jid, input.msg_id)
  // An empty string is WhatsApp's way of removing a reaction, so it's valid input.
  const emoji = input.emoji ?? ''

  const dry = dryRun('react_to_message', { chat_jid: jid, msg_id: input.msg_id, emoji })
  if (dry) return dry

  const sock = requireSocket()
  await sock.sendMessage(jid, { react: { text: emoji, key: stored.key } })
  return { ok: true, chat_jid: jid, msg_id: input.msg_id, emoji, removed: emoji === '' }
}

export async function editMessage(input: { chat_jid: string; msg_id: string; text: string }) {
  requireScope('send')
  const jid = normalizeJid(input.chat_jid)
  assertKnownChat(jid)
  const stored = requireStored(jid, input.msg_id)
  if (!stored.key.fromMe) throw badRequest('you can only edit your own messages')
  const text = (input.text ?? '').trim()
  if (text === '') throw badRequest('text is empty')

  const dry = dryRun('edit_message', { chat_jid: jid, msg_id: input.msg_id, text })
  if (dry) return dry

  consumeSendBudget()
  const sock = requireSocket()
  const sent = await sock.sendMessage(jid, { text, edit: stored.key })
  return sentResult(jid, sent)
}

export async function deleteMessage(input: { chat_jid: string; msg_id: string; for_everyone?: boolean }) {
  requireScope('send')
  const jid = normalizeJid(input.chat_jid)
  assertKnownChat(jid)
  const stored = requireStored(jid, input.msg_id)
  const forEveryone = input.for_everyone !== false

  const dry = dryRun('delete_message', { chat_jid: jid, msg_id: input.msg_id, for_everyone: forEveryone })
  if (dry) return dry

  const sock = requireSocket()
  if (forEveryone) {
    // Retracts it for both sides. Only valid for our own messages, or as a
    // group admin — WhatsApp itself enforces that, and rejects otherwise.
    await sock.sendMessage(jid, { delete: stored.key })
  } else {
    await sock.chatModify(
      { deleteForMe: { key: stored.key, deleteMedia: false, timestamp: stored.messageTimestamp } },
      jid,
    )
  }
  return { ok: true, chat_jid: jid, msg_id: input.msg_id, for_everyone: forEveryone }
}

// ---------------------------------------------------------------- chat management

export async function markChatRead(input: { chat_jid: string }) {
  requireScope('chats')
  const jid = normalizeJid(input.chat_jid)
  assertKnownChat(jid)
  const inbound = getLastInboundMessageKey(jid)
  if (!inbound) throw badRequest(`no received messages stored in ${jid}, so there's nothing to mark read`)

  const dry = dryRun('mark_chat_read', { chat_jid: jid, up_to_msg_id: inbound.key.id })
  if (dry) return dry

  const sock = requireSocket()
  // readMessages sends the read receipt the sender sees; chatModify syncs the
  // unread badge across your own devices. Both are needed for "read" to stick.
  await sock.readMessages([inbound.key])
  await sock.chatModify({ markRead: true, lastMessages: lastMessageList(jid) }, jid)
  return { ok: true, chat_jid: jid, up_to_msg_id: inbound.key.id }
}

export async function updateChat(input: {
  chat_jid: string
  archived?: boolean | null
  pinned?: boolean | null
  muted_for_ms?: number | null
  unmute?: boolean | null
}) {
  requireScope('chats')
  const jid = normalizeJid(input.chat_jid)
  assertKnownChat(jid)

  const changes: Array<{ label: string; modification: unknown }> = []
  if (input.archived !== undefined && input.archived !== null) {
    changes.push({
      label: input.archived ? 'archive' : 'unarchive',
      modification: { archive: input.archived, lastMessages: lastMessageList(jid) },
    })
  }
  if (input.pinned !== undefined && input.pinned !== null) {
    changes.push({ label: input.pinned ? 'pin' : 'unpin', modification: { pin: input.pinned } })
  }
  if (input.unmute) {
    changes.push({ label: 'unmute', modification: { mute: null } })
  } else if (input.muted_for_ms !== undefined && input.muted_for_ms !== null) {
    if (!Number.isFinite(input.muted_for_ms) || input.muted_for_ms <= 0) {
      throw badRequest('muted_for_ms must be a positive number of milliseconds (use unmute to clear it)')
    }
    changes.push({ label: `mute for ${input.muted_for_ms}ms`, modification: { mute: input.muted_for_ms } })
  }
  if (changes.length === 0) {
    throw badRequest('nothing to change — pass at least one of archived, pinned, muted_for_ms, unmute')
  }

  const dry = dryRun('update_chat', { chat_jid: jid, changes: changes.map((c) => c.label) })
  if (dry) return dry

  const sock = requireSocket()
  for (const change of changes) await sock.chatModify(change.modification, jid)
  return { ok: true, chat_jid: jid, applied: changes.map((c) => c.label) }
}

const PRESENCE_STATES: WAPresence[] = ['available', 'unavailable', 'composing', 'recording', 'paused']

export async function sendTyping(input: { chat_jid: string; state?: string | null }) {
  requireScope('chats')
  const jid = normalizeJid(input.chat_jid)
  assertKnownChat(jid)
  const presence = (input.state ?? 'composing') as WAPresence
  if (!PRESENCE_STATES.includes(presence)) {
    throw badRequest(`unknown presence state "${input.state}" (expected one of ${PRESENCE_STATES.join(', ')})`)
  }

  const dry = dryRun('send_typing', { chat_jid: jid, state: presence })
  if (dry) return dry

  const sock = requireSocket()
  await sock.sendPresenceUpdate(presence, jid)
  return { ok: true, chat_jid: jid, state: presence }
}

// ---------------------------------------------------------------- groups

export async function createGroup(input: { subject: string; participants: string[] }) {
  requireScope('groups')
  const subject = (input.subject ?? '').trim()
  if (subject === '') throw badRequest('subject is empty')
  const participants = (input.participants ?? []).map(normalizeJid)
  if (participants.length === 0) throw badRequest('a group needs at least one other participant')
  // The new-contacts guardrail applies here too: creating a group is a way to
  // reach a stranger just as much as sending them a message is.
  for (const p of participants) assertKnownChat(p)

  const dry = dryRun('create_group', { subject, participants })
  if (dry) return dry

  const sock = requireSocket()
  const group = await sock.groupCreate(subject, participants)
  return { ok: true, group_jid: group.id, subject: group.subject ?? subject, participants }
}

export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote'
const PARTICIPANT_ACTIONS: ParticipantAction[] = ['add', 'remove', 'promote', 'demote']

export async function updateGroupParticipants(input: { group_jid: string; action: string; participants: string[] }) {
  requireScope('groups')
  const jid = normalizeJid(input.group_jid)
  if (!jid.endsWith('@g.us')) throw badRequest(`${jid} is not a group JID`)
  const action = input.action as ParticipantAction
  if (!PARTICIPANT_ACTIONS.includes(action)) {
    throw badRequest(`unknown action "${input.action}" (expected one of ${PARTICIPANT_ACTIONS.join(', ')})`)
  }
  const participants = (input.participants ?? []).map(normalizeJid)
  if (participants.length === 0) throw badRequest('participants is empty')
  if (action === 'add') for (const p of participants) assertKnownChat(p)

  const dry = dryRun('manage_group_participants', { group_jid: jid, action, participants })
  if (dry) return dry

  const sock = requireSocket()
  const result = await sock.groupParticipantsUpdate(jid, participants, action)
  return { ok: true, group_jid: jid, action, participants, result }
}

export async function updateGroup(input: {
  group_jid: string
  subject?: string | null
  description?: string | null
  action?: 'leave' | 'invite_link' | 'revoke_invite' | null
}) {
  requireScope('groups')
  const jid = normalizeJid(input.group_jid)
  if (!jid.endsWith('@g.us')) throw badRequest(`${jid} is not a group JID`)

  const subject = input.subject?.trim() || null
  const hasDescription = input.description !== undefined && input.description !== null
  const action = input.action ?? null
  if (!subject && !hasDescription && !action) {
    throw badRequest('nothing to do — pass subject, description, or action (leave | invite_link | revoke_invite)')
  }

  const dry = dryRun('update_group', { group_jid: jid, subject, description: input.description ?? null, action })
  if (dry) return dry

  const sock = requireSocket()
  const applied: string[] = []
  let inviteLink: string | null = null

  if (subject) {
    await sock.groupUpdateSubject(jid, subject)
    applied.push(`subject="${subject}"`)
  }
  if (hasDescription) {
    await sock.groupUpdateDescription(jid, input.description ?? undefined)
    applied.push('description')
  }
  if (action === 'invite_link' || action === 'revoke_invite') {
    const code = action === 'revoke_invite' ? await sock.groupRevokeInvite(jid) : await sock.groupInviteCode(jid)
    inviteLink = code ? `https://chat.whatsapp.com/${code}` : null
    applied.push(action)
  }
  // Leaving last: anything after it would fail, since we're no longer a member.
  if (action === 'leave') {
    await sock.groupLeave(jid)
    applied.push('leave')
  }

  return { ok: true, group_jid: jid, applied, invite_link: inviteLink }
}
