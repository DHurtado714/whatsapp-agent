import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { __resetForTests, getMessages, upsertChat, upsertMessages } from '../shared/db.js'
import { type Permissions, resolvePermissions } from '../shared/permissions.js'
import {
  ActionError,
  type WriteSocket,
  __resetRateLimitForTests,
  __setSocketForTests,
  createGroup,
  deleteMessage,
  editMessage,
  markChatRead,
  normalizeJid,
  reactToMessage,
  sendMedia,
  sendText,
  sendTyping,
  setPermissions,
  updateChat,
  updateGroup,
  updateGroupParticipants,
} from './actions.js'

/**
 * The write path, exercised without a WhatsApp connection and without a
 * listening port: a stub socket records what it was asked to do, and the real
 * SQLite store backs the guardrail and message-key lookups.
 */

const DM = '15550100001@s.whatsapp.net'
const GROUP = '120363000111@g.us'
const STRANGER = '15559999999@s.whatsapp.net'

type Call = { method: string; args: unknown[] }

let calls: Call[] = []
const scratchDirs: string[] = []

function stubSocket(): WriteSocket {
  const record =
    (method: string, result: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve(result)
    }
  return {
    // The shape Baileys returns from sendMessage, which the send path reflects
    // back into the database.
    sendMessage: (jid: string, content: any, options?: any) => {
      calls.push({ method: 'sendMessage', args: [jid, content, options] })
      return Promise.resolve({
        key: { remoteJid: jid, fromMe: true, id: 'SENT1' },
        message: { conversation: content?.text ?? '' },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Test User',
      })
    },
    readMessages: record('readMessages') as WriteSocket['readMessages'],
    chatModify: record('chatModify') as WriteSocket['chatModify'],
    sendPresenceUpdate: record('sendPresenceUpdate') as WriteSocket['sendPresenceUpdate'],
    groupCreate: record('groupCreate', { id: 'NEWGROUP@g.us', subject: 'Team' }) as WriteSocket['groupCreate'],
    groupParticipantsUpdate: record('groupParticipantsUpdate', []) as WriteSocket['groupParticipantsUpdate'],
    groupUpdateSubject: record('groupUpdateSubject') as WriteSocket['groupUpdateSubject'],
    groupUpdateDescription: record('groupUpdateDescription') as WriteSocket['groupUpdateDescription'],
    groupLeave: record('groupLeave') as WriteSocket['groupLeave'],
    groupInviteCode: record('groupInviteCode', 'INVITECODE') as WriteSocket['groupInviteCode'],
    groupRevokeInvite: record('groupRevokeInvite', 'FRESHCODE') as WriteSocket['groupRevokeInvite'],
  }
}

/** A fresh database seeded with one DM and one group, plus a message in each. */
function seed(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-actions-test-'))
  scratchDirs.push(dir)
  __resetForTests(path.join(dir, 'store.db'))

  const now = Date.now()
  upsertChat({ jid: DM, isGroup: false, lastMessageAt: now })
  upsertChat({ jid: GROUP, name: 'Product Team', isGroup: true, lastMessageAt: now })
  upsertMessages([
    {
      chat_jid: DM,
      msg_id: 'THEIRS',
      from_me: 0,
      sender_jid: DM,
      sender_name: 'Alice',
      timestamp: now - 60_000,
      kind: 'conversation',
      text: 'their message',
      quoted_id: null,
      media_type: null,
      filename: null,
      raw: null,
    },
    {
      chat_jid: DM,
      msg_id: 'MINE',
      from_me: 1,
      sender_jid: null,
      sender_name: null,
      timestamp: now - 30_000,
      kind: 'conversation',
      text: 'my message',
      quoted_id: null,
      media_type: null,
      filename: null,
      raw: JSON.stringify({ conversation: 'my message' }),
    },
    {
      chat_jid: GROUP,
      msg_id: 'GMSG',
      from_me: 0,
      sender_jid: DM,
      sender_name: 'Alice',
      timestamp: now - 10_000,
      kind: 'conversation',
      text: 'group message',
      quoted_id: null,
      media_type: null,
      filename: null,
      raw: null,
    },
  ])
}

function grant(overrides: Partial<Permissions> & { allow?: string } = {}): void {
  const { allow, ...rest } = overrides
  setPermissions({ ...resolvePermissions({ allow: allow ?? 'all' }), ...rest })
}

beforeEach(() => {
  calls = []
  seed()
  __resetRateLimitForTests()
  __setSocketForTests(stubSocket())
  grant()
})

afterEach(() => {
  __setSocketForTests(null)
  __resetForTests(null)
  // bun test shares one process across files, and permissions live in module
  // state — hand them back read-only so nothing downstream inherits a grant.
  setPermissions(resolvePermissions({ readOnly: true }))
})

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const lastCall = (method: string) => calls.filter((c) => c.method === method).at(-1)

// ---------------------------------------------------------------- scopes

describe('scope enforcement', () => {
  test('a read-only bridge refuses every write, naming the flag to add', async () => {
    grant({ allow: '' })
    await expect(sendText({ chat_jid: DM, text: 'hi' })).rejects.toThrow(/--allow=send/)
    await expect(sendMedia({ chat_jid: DM, kind: 'image', path: '/tmp/x' })).rejects.toThrow(/--allow=media/)
    await expect(markChatRead({ chat_jid: DM })).rejects.toThrow(/--allow=chats/)
    await expect(createGroup({ subject: 'x', participants: [DM] })).rejects.toThrow(/--allow=groups/)
    expect(calls).toHaveLength(0)
  })

  test('one scope does not unlock another', async () => {
    grant({ allow: 'send' })
    await expect(sendText({ chat_jid: DM, text: 'hi' })).resolves.toMatchObject({ ok: true })
    await expect(sendTyping({ chat_jid: DM })).rejects.toThrow(/"chats" permission is not granted/)
  })

  test('a scope failure carries a 403 so the HTTP layer needs no classification', async () => {
    grant({ allow: '' })
    const err = await sendText({ chat_jid: DM, text: 'hi' }).catch((e) => e)
    expect(err).toBeInstanceOf(ActionError)
    expect(err.status).toBe(403)
  })
})

// ---------------------------------------------------------------- guardrails

describe('the "no new contacts" guardrail', () => {
  test('refuses a number with no stored chat', async () => {
    const err = await sendText({ chat_jid: STRANGER, text: 'hi' }).catch((e) => e)
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/--allow-new-contacts/)
    expect(calls).toHaveLength(0)
  })

  test('allows it once --allow-new-contacts is set', async () => {
    grant({ allowNewContacts: true })
    await expect(sendText({ chat_jid: STRANGER, text: 'hi' })).resolves.toMatchObject({ ok: true })
  })

  test('applies to group creation too, since that also reaches strangers', async () => {
    await expect(createGroup({ subject: 'Team', participants: [STRANGER] })).rejects.toThrow(/no stored chat/)
  })

  test('applies to adding participants, but not to removing them', async () => {
    await expect(
      updateGroupParticipants({ group_jid: GROUP, action: 'add', participants: [STRANGER] }),
    ).rejects.toThrow(/no stored chat/)
    // Removing someone you can't see a chat with still has to work.
    await expect(
      updateGroupParticipants({ group_jid: GROUP, action: 'remove', participants: [STRANGER] }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('rate limiting', () => {
  test('blocks the send that exceeds the window, with a 429 and a wait time', async () => {
    grant({ sendRateLimit: 2 })
    await sendText({ chat_jid: DM, text: '1' })
    await sendText({ chat_jid: DM, text: '2' })
    const err = await sendText({ chat_jid: DM, text: '3' }).catch((e) => e)
    expect(err.status).toBe(429)
    expect(err.message).toMatch(/2 messages\/minute/)
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2)
  })

  test('0 disables the limit', async () => {
    grant({ sendRateLimit: 0 })
    for (let i = 0; i < 12; i++) await sendText({ chat_jid: DM, text: `m${i}` })
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(12)
  })

  test('reactions and typing do not consume the send budget', async () => {
    grant({ sendRateLimit: 1 })
    await reactToMessage({ chat_jid: DM, msg_id: 'THEIRS', emoji: '👍' })
    await sendTyping({ chat_jid: DM })
    await expect(sendText({ chat_jid: DM, text: 'still allowed' })).resolves.toMatchObject({ ok: true })
  })
})

describe('dry run', () => {
  test('reports the intent and never touches the socket', async () => {
    grant({ dryRun: true })
    const result: any = await sendText({ chat_jid: DM, text: 'would send this' })
    expect(result.dry_run).toBe(true)
    expect(result.action).toBe('send_message')
    expect(result.would.text).toBe('would send this')
    expect(calls).toHaveLength(0)
  })

  test('still enforces scopes and guardrails first', async () => {
    grant({ dryRun: true })
    // A dry run that says "sure, I would have done that" for something the
    // real run would refuse would be actively misleading.
    await expect(sendText({ chat_jid: STRANGER, text: 'hi' })).rejects.toThrow(/no stored chat/)
    grant({ allow: '', dryRun: true })
    await expect(sendText({ chat_jid: DM, text: 'hi' })).rejects.toThrow(/not granted/)
  })

  test('covers the destructive actions too', async () => {
    grant({ dryRun: true })
    for (const run of [
      () => deleteMessage({ chat_jid: DM, msg_id: 'MINE' }),
      () => updateGroup({ group_jid: GROUP, action: 'leave' }),
      () => updateGroupParticipants({ group_jid: GROUP, action: 'remove', participants: [DM] }),
    ]) {
      expect((await run()) as any).toMatchObject({ dry_run: true })
    }
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- jids

describe('normalizeJid', () => {
  test('passes a full JID through', () => {
    expect(normalizeJid(DM)).toBe(DM)
    expect(normalizeJid(GROUP)).toBe(GROUP)
    expect(normalizeJid('99887766@lid')).toBe('99887766@lid')
  })

  test('turns a bare number into a user JID, ignoring formatting', () => {
    expect(normalizeJid('+1 (555) 010-0001')).toBe(DM)
  })

  test('rejects anything it would have to guess at', () => {
    expect(() => normalizeJid('')).toThrow(/missing chat identifier/)
    expect(() => normalizeJid('Alice')).toThrow(/neither a JID nor a plausible phone number/)
    expect(() => normalizeJid('someone@example.com')).toThrow(/not a valid WhatsApp JID/)
  })
})

// ---------------------------------------------------------------- sending

describe('sendText', () => {
  test('sends the text and reflects the message into the database immediately', async () => {
    const before = getMessages({ chatJid: DM, limit: 100 }).length
    const result: any = await sendText({ chat_jid: DM, text: 'hello there' })
    expect(result).toMatchObject({ ok: true, chat_jid: DM, msg_id: 'SENT1' })

    // Without this reflection, a get_messages right after a send would race
    // the messages.upsert echo and appear to have lost the message.
    const after = getMessages({ chatJid: DM, limit: 100 })
    expect(after).toHaveLength(before + 1)
    expect(after.at(-1)).toMatchObject({ msg_id: 'SENT1', from_me: 1, text: 'hello there' })
  })

  test('trims the text and refuses an empty one', async () => {
    await sendText({ chat_jid: DM, text: '  spaced  ' })
    expect((lastCall('sendMessage')!.args[1] as any).text).toBe('spaced')
    await expect(sendText({ chat_jid: DM, text: '   ' })).rejects.toThrow(/text is empty/)
  })

  test('passes mentions through, normalized', async () => {
    await sendText({ chat_jid: GROUP, text: 'ping @15550100001', mentions: ['15550100001'] })
    expect((lastCall('sendMessage')!.args[1] as any).mentions).toEqual([DM])
  })

  test('omits the mentions field entirely when there are none', async () => {
    await sendText({ chat_jid: DM, text: 'plain' })
    expect(lastCall('sendMessage')!.args[1]).toEqual({ text: 'plain' })
  })

  test('reply_to quotes a stored message, reusing its raw body when we have one', async () => {
    await sendText({ chat_jid: DM, text: 'replying', reply_to: 'MINE' })
    const quoted = (lastCall('sendMessage')!.args[2] as any).quoted
    expect(quoted.key).toMatchObject({ remoteJid: DM, id: 'MINE', fromMe: true })
    expect(quoted.message).toEqual({ conversation: 'my message' })
  })

  test('reply_to falls back to a synthetic body for an inbound message with no raw', async () => {
    await sendText({ chat_jid: DM, text: 'replying', reply_to: 'THEIRS' })
    const quoted = (lastCall('sendMessage')!.args[2] as any).quoted
    expect(quoted.key).toMatchObject({ id: 'THEIRS', fromMe: false })
    expect(quoted.message).toEqual({ conversation: 'their message' })
  })

  test('a group quote carries the participant, which WhatsApp requires there', async () => {
    await sendText({ chat_jid: GROUP, text: 'replying', reply_to: 'GMSG' })
    const quoted = (lastCall('sendMessage')!.args[2] as any).quoted
    expect(quoted.key.participant).toBe(DM)
  })

  test('a 1:1 quote has no participant', async () => {
    await sendText({ chat_jid: DM, text: 'replying', reply_to: 'THEIRS' })
    expect((lastCall('sendMessage')!.args[2] as any).quoted.key.participant).toBeUndefined()
  })

  test('replying to a message we never stored is a 404, not a silent plain send', async () => {
    const err = await sendText({ chat_jid: DM, text: 'x', reply_to: 'GHOST' }).catch((e) => e)
    expect(err.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})

describe('sendMedia', () => {
  let file: string

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-test-'))
    scratchDirs.push(dir)
    file = path.join(dir, 'photo.jpg')
    fs.writeFileSync(file, 'not really a jpeg')
  })

  test('sends a local file as the requested kind', async () => {
    await sendMedia({ chat_jid: DM, kind: 'image', path: file, caption: 'look' })
    expect(lastCall('sendMessage')!.args[1]).toEqual({ image: { url: file }, caption: 'look' })
  })

  test('documents carry a filename and a mimetype', async () => {
    await sendMedia({ chat_jid: DM, kind: 'document', path: file, filename: 'report.pdf', mimetype: 'application/pdf' })
    expect(lastCall('sendMessage')!.args[1]).toMatchObject({
      document: { url: file },
      fileName: 'report.pdf',
      mimetype: 'application/pdf',
    })
  })

  test('voice_note sends audio as push-to-talk', async () => {
    await sendMedia({ chat_jid: DM, kind: 'audio', path: file, voice_note: true })
    expect(lastCall('sendMessage')!.args[1]).toMatchObject({ ptt: true })
  })

  test('requires exactly one of path or url', async () => {
    await expect(sendMedia({ chat_jid: DM, kind: 'image' })).rejects.toThrow(/exactly one of path/)
    await expect(sendMedia({ chat_jid: DM, kind: 'image', path: file, url: 'https://x/y.jpg' })).rejects.toThrow(
      /exactly one of path/,
    )
  })

  test('rejects a missing file, a directory, and a non-http url before uploading', async () => {
    await expect(sendMedia({ chat_jid: DM, kind: 'image', path: '/no/such/file.jpg' })).rejects.toThrow(/no such file/)
    await expect(sendMedia({ chat_jid: DM, kind: 'image', path: path.dirname(file) })).rejects.toThrow(
      /not a regular file/,
    )
    await expect(sendMedia({ chat_jid: DM, kind: 'image', url: 'file:///etc/passwd' })).rejects.toThrow(
      /must start with http/,
    )
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- react / edit / delete

describe('reactToMessage', () => {
  test('reacts with the given emoji', async () => {
    const result: any = await reactToMessage({ chat_jid: DM, msg_id: 'THEIRS', emoji: '🎉' })
    expect(result.removed).toBe(false)
    expect(lastCall('sendMessage')!.args[1]).toMatchObject({ react: { text: '🎉' } })
  })

  test('an empty emoji removes the reaction, which is valid input', async () => {
    const result: any = await reactToMessage({ chat_jid: DM, msg_id: 'THEIRS', emoji: '' })
    expect(result.removed).toBe(true)
    expect((lastCall('sendMessage')!.args[1] as any).react.text).toBe('')
  })
})

describe('editMessage', () => {
  test('edits our own message', async () => {
    await editMessage({ chat_jid: DM, msg_id: 'MINE', text: 'corrected' })
    expect(lastCall('sendMessage')!.args[1]).toMatchObject({ text: 'corrected', edit: { id: 'MINE' } })
  })

  test("refuses to edit someone else's message", async () => {
    const err = await editMessage({ chat_jid: DM, msg_id: 'THEIRS', text: 'nope' }).catch((e) => e)
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/only edit your own/)
    expect(calls).toHaveLength(0)
  })
})

describe('deleteMessage', () => {
  test('retracts for everyone by default', async () => {
    const result: any = await deleteMessage({ chat_jid: DM, msg_id: 'MINE' })
    expect(result.for_everyone).toBe(true)
    expect(lastCall('sendMessage')!.args[1]).toMatchObject({ delete: { id: 'MINE' } })
  })

  test('for_everyone false only removes it locally, via chatModify', async () => {
    await deleteMessage({ chat_jid: DM, msg_id: 'MINE', for_everyone: false })
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false)
    expect((lastCall('chatModify')!.args[0] as any).deleteForMe.key.id).toBe('MINE')
  })
})

// ---------------------------------------------------------------- chats

describe('markChatRead', () => {
  test('sends a read receipt for the last inbound message and syncs the badge', async () => {
    const result: any = await markChatRead({ chat_jid: DM })
    expect(result.up_to_msg_id).toBe('THEIRS')
    expect((lastCall('readMessages')!.args[0] as any[])[0]).toMatchObject({ id: 'THEIRS' })
    expect(lastCall('chatModify')!.args[0]).toMatchObject({ markRead: true })
  })

  test('a chat with nothing received has nothing to mark read', async () => {
    upsertChat({ jid: STRANGER, isGroup: false })
    grant({ allowNewContacts: true })
    await expect(markChatRead({ chat_jid: STRANGER })).rejects.toThrow(/nothing to mark read/)
  })
})

describe('updateChat', () => {
  test('archives, pins and mutes in one call, reporting what it applied', async () => {
    const result: any = await updateChat({ chat_jid: DM, archived: true, pinned: true, muted_for_ms: 3.6e6 })
    expect(result.applied).toEqual(['archive', 'pin', 'mute for 3600000ms'])
    expect(calls.filter((c) => c.method === 'chatModify')).toHaveLength(3)
  })

  test('archive carries lastMessages, which chatModify requires', async () => {
    await updateChat({ chat_jid: DM, archived: true })
    expect((lastCall('chatModify')!.args[0] as any).lastMessages[0].key.id).toBe('MINE')
  })

  test('unmute clears the mute and wins over muted_for_ms', async () => {
    await updateChat({ chat_jid: DM, unmute: true, muted_for_ms: 60_000 })
    expect(lastCall('chatModify')!.args[0]).toEqual({ mute: null })
  })

  test('false values are applied rather than treated as absent', async () => {
    const result: any = await updateChat({ chat_jid: DM, archived: false, pinned: false })
    expect(result.applied).toEqual(['unarchive', 'unpin'])
  })

  test('a call that changes nothing is a 400 instead of a silent no-op', async () => {
    await expect(updateChat({ chat_jid: DM })).rejects.toThrow(/nothing to change/)
  })

  test('a non-positive mute duration is rejected', async () => {
    await expect(updateChat({ chat_jid: DM, muted_for_ms: 0 })).rejects.toThrow(/positive number/)
  })
})

describe('sendTyping', () => {
  test('defaults to composing', async () => {
    const result: any = await sendTyping({ chat_jid: DM })
    expect(result.state).toBe('composing')
    expect(lastCall('sendPresenceUpdate')!.args).toEqual(['composing', DM])
  })

  test('rejects a presence state WhatsApp does not know', async () => {
    await expect(sendTyping({ chat_jid: DM, state: 'dancing' })).rejects.toThrow(/unknown presence state/)
  })
})

// ---------------------------------------------------------------- groups

describe('groups', () => {
  test('createGroup normalizes participants and returns the new jid', async () => {
    const result: any = await createGroup({ subject: 'Team', participants: ['15550100001'] })
    expect(result.group_jid).toBe('NEWGROUP@g.us')
    expect(lastCall('groupCreate')!.args).toEqual(['Team', [DM]])
  })

  test('createGroup needs a subject and at least one participant', async () => {
    await expect(createGroup({ subject: '', participants: [DM] })).rejects.toThrow(/subject is empty/)
    await expect(createGroup({ subject: 'Team', participants: [] })).rejects.toThrow(/at least one other participant/)
  })

  test('participant actions are restricted to the four WhatsApp supports', async () => {
    await expect(updateGroupParticipants({ group_jid: GROUP, action: 'banish', participants: [DM] })).rejects.toThrow(
      /unknown action "banish"/,
    )
  })

  test('participant actions require a group jid', async () => {
    await expect(updateGroupParticipants({ group_jid: DM, action: 'remove', participants: [DM] })).rejects.toThrow(
      /is not a group JID/,
    )
  })

  test('updateGroup renames, and returns an invite link when asked', async () => {
    const result: any = await updateGroup({ group_jid: GROUP, subject: 'Renamed', action: 'invite_link' })
    expect(result.invite_link).toBe('https://chat.whatsapp.com/INVITECODE')
    expect(result.applied).toEqual(['subject="Renamed"', 'invite_link'])
  })

  test('revoke_invite returns the fresh code', async () => {
    const result: any = await updateGroup({ group_jid: GROUP, action: 'revoke_invite' })
    expect(result.invite_link).toBe('https://chat.whatsapp.com/FRESHCODE')
  })

  test('leaving happens last, so a rename in the same call still lands', async () => {
    await updateGroup({ group_jid: GROUP, subject: 'Farewell', action: 'leave' })
    const order = calls.map((c) => c.method)
    expect(order.indexOf('groupUpdateSubject')).toBeLessThan(order.indexOf('groupLeave'))
  })

  test('an empty description is applied rather than ignored', async () => {
    const result: any = await updateGroup({ group_jid: GROUP, description: '' })
    expect(result.applied).toEqual(['description'])
    expect(lastCall('groupUpdateDescription')!.args).toEqual([GROUP, ''])
  })

  test('a call with nothing to do is a 400', async () => {
    await expect(updateGroup({ group_jid: GROUP })).rejects.toThrow(/nothing to do/)
  })
})
