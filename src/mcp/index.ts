#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import pkg from '../../package.json' with { type: 'json' }
import { BRIDGE_URL } from '../shared/config.js'
import { SCOPE_HELP, type Scope, isReadOnly, resolvePermissions, scopeList } from '../shared/permissions.js'
import { bridgeGet, bridgePost } from './client.js'

// ---------------------------------------------------------------- bridge types

type ChatView = {
  jid: string
  name: string
  is_group: number
  last_message_at: number | null
  unread_count: number
  archived: number
  pinned: number
  phone_number: string | null
  last_message_text: string | null
  message_count: number
}

type MessageView = {
  msg_id: string
  from_me: number
  sender_display: string | null
  timestamp: number
  kind: string | null
  text: string | null
  media_type: string | null
  filename: string | null
  quoted_id: string | null
}

// ---------------------------------------------------------------- permissions

/**
 * Resolved from this process's own env, not from the bridge. The bridge is the
 * real enforcer — it owns the socket — but the tool *list* has to be decided
 * before the transport connects, and the bridge may not even be up yet at that
 * point. Both read the same WA_ALLOW, so they normally agree; when they don't,
 * the bridge answers 403 and its message names the flag to add.
 */
function resolveOrExit() {
  try {
    return resolvePermissions()
  } catch (err) {
    // Thrown at module load, before the transport exists, so there's no way to
    // report this over MCP — stderr and a non-zero exit is all the client gets,
    // and a bare stack trace would bury the actual cause (usually a typo in
    // WA_ALLOW in the client's own config).
    process.stderr.write(`whatsapp-agent mcp: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

const perms = resolveOrExit()
const granted = new Set<Scope>(scopeList(perms))
const can = (scope: Scope) => granted.has(scope)

function buildInstructions(): string {
  const base =
    "Access to the user's WhatsApp account through a local bridge (Baileys). " +
    'Use list_chats to see recent conversations, search_chats to find one by name or number, ' +
    "and get_messages to read a conversation's history. " +
    'Every tool that takes a chat accepts a JID, a contact/group name, or a phone number — ' +
    'no need to look up the JID first.'

  if (isReadOnly(perms)) {
    return `${base} This server is running READ-ONLY: it cannot send messages or modify anything.`
  }

  const abilities = scopeList(perms).map((s) => `${s} (${SCOPE_HELP[s]})`)
  const notes = [
    `Write access is enabled for: ${abilities.join('; ')}.`,
    'Messages are sent to real people and cannot be unsent once delivered — confirm the recipient and the wording with the user before calling a write tool, unless they have already told you exactly what to send and to whom.',
  ]
  if (perms.dryRun) {
    notes.push('DRY-RUN is on: write tools report what they would do without actually doing it.')
  }
  if (!perms.allowNewContacts) {
    notes.push('Writing is restricted to chats that already exist locally; unknown numbers are refused.')
  }
  return `${base} ${notes.join(' ')}`
}

// ---------------------------------------------------------------- helpers

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Every tool body is the same shape: build a string, or turn any throw into an isError result. */
async function guarded(run: () => Promise<string>) {
  try {
    return ok(await run())
  } catch (err) {
    return fail(errText(err))
  }
}

function fmtDate(ms: number | null): string {
  if (!ms) return 'no date'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function parseWhen(input?: string): number | null {
  if (!input) return null
  const trimmed = input.trim()
  const relative = /^(\d+)\s*([dhwm])$/i.exec(trimmed)
  if (relative) {
    const n = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const mult = unit === 'h' ? 3.6e6 : unit === 'd' ? 8.64e7 : unit === 'w' ? 6.048e8 : 2.592e9
    return Date.now() - n * mult
  }
  if (/^\d{10}$/.test(trimmed)) return Number(trimmed) * 1000
  if (/^\d{13}$/.test(trimmed)) return Number(trimmed)
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

function renderChats(chats: ChatView[]): string {
  if (chats.length === 0) return 'No matching chats.'
  return chats
    .map((c) => {
      const tags: string[] = []
      if (c.is_group) tags.push('group')
      if (c.unread_count > 0) tags.push(`${c.unread_count} unread`)
      if (c.pinned) tags.push('pinned')
      if (c.archived) tags.push('archived')
      const preview = c.last_message_text ? ` | last: ${truncate(c.last_message_text, 90)}` : ''
      return (
        `- ${c.name}${tags.length ? ` [${tags.join(', ')}]` : ''}\n` +
        `  jid: ${c.jid}${c.phone_number ? ` | phone: +${c.phone_number}` : ''}\n` +
        `  activity: ${fmtDate(c.last_message_at)} | ${c.message_count} messages stored${preview}`
      )
    })
    .join('\n')
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : clean.slice(0, n - 1) + '…'
}

/** Accepts an exact JID, or a name/number we resolve against the stored chats. */
async function resolveChat(input: string): Promise<{ chat: ChatView } | { ambiguous: ChatView[] }> {
  if (input.includes('@')) {
    const { chat } = await bridgeGet<{ chat: ChatView | null }>('/chat', { jid: input })
    if (chat) return { chat }
  }
  const { chats } = await bridgeGet<{ chats: ChatView[] }>('/chats/search', { q: input, limit: 10 })
  if (chats.length === 1) return { chat: chats[0] }
  return { ambiguous: chats }
}

/**
 * Chat resolution for write tools. Reading the wrong chat wastes a turn;
 * writing to the wrong chat sends a message to the wrong human, so an
 * ambiguous or empty match has to be a hard failure here — never a best guess.
 */
async function resolveWriteTarget(input: string): Promise<ChatView> {
  const resolved = await resolveChat(input)
  if ('chat' in resolved) return resolved.chat
  if (resolved.ambiguous.length === 0) {
    throw new Error(
      `Could not find any chat matching "${input}". Nothing was sent. ` +
        `Use search_chats or list_chats to find the exact chat first.`,
    )
  }
  throw new Error(
    `"${input}" matches ${resolved.ambiguous.length} chats, so nothing was sent — ` +
      `call this tool again with one of these exact jids:\n\n${renderChats(resolved.ambiguous)}`,
  )
}

type WriteResult = { dry_run?: boolean; action?: string; would?: Record<string, unknown> }

/** Renders a bridge write response, keeping dry-run results unmistakable. */
function renderWrite(result: WriteResult, success: string): string {
  if (result?.dry_run) {
    return (
      `DRY RUN — nothing actually happened. Would ${result.action}:\n` +
      `${JSON.stringify(result.would, null, 2)}\n\n` +
      `The bridge is running in dry-run mode; it has to be restarted without --dry-run ` +
      `(or WA_DRY_RUN) for this to take effect.`
    )
  }
  return success
}

const chatParam = z
  .string()
  .min(1)
  .describe('JID (e.g. 15551234567@s.whatsapp.net), contact/group name, or phone number.')

const groupParam = z.string().min(1).describe('Group JID (…@g.us) or the group name.')

// ---------------------------------------------------------------- server

const server = new McpServer({ name: 'whatsapp', version: pkg.version }, { instructions: buildInstructions() })

server.registerTool(
  'whatsapp_status',
  {
    title: 'WhatsApp connection status',
    description:
      'Shows whether the WhatsApp bridge is connected, with which account, how many chats and messages ' +
      'are stored locally, and which write permissions are enabled. Use this first if any other tool ' +
      'returns empty results, a connection error, or a permission error.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const s = await bridgeGet<any>('/status')
      const p = s.permissions
      const lines = [
        `Connection: ${s.connection}${s.registered ? '' : ' (not linked yet)'}`,
        s.me ? `Account: ${s.me.name ?? '(no name)'} — ${s.me.id}` : 'Account: not linked',
        `Stored locally: ${s.stored.chats} chats, ${s.stored.messages} messages, ${s.stored.contacts} contacts`,
        `History sync: ${s.history_sync.complete ? 'complete' : 'in progress'} (${s.history_sync.received} messages received)`,
        p
          ? `Permissions: ${p.read_only ? 'read-only' : `read + ${p.scopes.join(', ')}`}` +
            `${p.dry_run ? ' [dry-run]' : ''}` +
            `${p.read_only ? '' : ` | rate limit: ${p.send_rate_limit_per_minute === 0 ? 'none' : `${p.send_rate_limit_per_minute}/min`}`}` +
            `${p.read_only ? '' : ` | new contacts: ${p.allow_new_contacts ? 'allowed' : 'blocked'}`}`
          : null,
        s.connected_at ? `Connected since: ${fmtDate(s.connected_at)}` : null,
        s.awaiting_qr ? 'Waiting for you to scan the QR in the terminal running the bridge.' : null,
        s.pairing_code ? `Pending pairing code: ${s.pairing_code}` : null,
        s.last_error ? `Last error: ${s.last_error}` : null,
      ].filter(Boolean)
      return ok(lines.join('\n'))
    } catch (err) {
      return fail(errText(err))
    }
  },
)

server.registerTool(
  'list_chats',
  {
    title: 'List WhatsApp chats',
    description:
      'Lists WhatsApp conversations ordered by recent activity (pinned first). ' +
      'Returns the name, the JID (the identifier get_messages needs), how many messages are stored, ' +
      'and a preview of the last message. Use unread_only to see only what is pending.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(25).describe('How many chats to return (1-200).'),
      offset: z.number().int().min(0).default(0).describe('How many chats to skip, for pagination.'),
      type: z
        .enum(['all', 'dm', 'group'])
        .default('all')
        .describe('Filter by type: all, dm (one-on-one conversations), group.'),
      unread_only: z.boolean().default(false).describe('Only chats with unread messages.'),
      include_archived: z.boolean().default(false).describe('Include archived chats.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ limit, offset, type, unread_only, include_archived }) => {
    try {
      const { chats } = await bridgeGet<{ chats: ChatView[] }>('/chats', {
        limit,
        offset,
        type,
        unread_only,
        include_archived,
      })
      return ok(`${chats.length} chats:\n\n${renderChats(chats)}`)
    } catch (err) {
      return fail(errText(err))
    }
  },
)

server.registerTool(
  'search_chats',
  {
    title: 'Search WhatsApp chats',
    description:
      'Searches conversations by contact name, group name, or phone number. ' +
      'Partial, case-insensitive match. Use this when you know who you want to reach but not the JID.',
    inputSchema: {
      query: z.string().min(1).describe('Name, part of a name, or phone number to search for.'),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of results.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, limit }) => {
    try {
      const { chats } = await bridgeGet<{ chats: ChatView[] }>('/chats/search', { q: query, limit })
      return ok(`${chats.length} matches for "${query}":\n\n${renderChats(chats)}`)
    } catch (err) {
      return fail(errText(err))
    }
  },
)

server.registerTool(
  'get_messages',
  {
    title: 'Read messages from a chat',
    description:
      "Returns a conversation's message history in chronological order. " +
      'The chat parameter accepts an exact JID, a contact/group name, or a phone number. ' +
      'Use since/until to narrow by date and limit + before to page backwards. ' +
      'Each message includes its msg_id, which the write tools need to reply to, react to, edit or delete it.',
    inputSchema: {
      chat: chatParam,
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('How many messages to return (the most recent in range).'),
      since: z
        .string()
        .optional()
        .describe('Only messages after this date. Accepts ISO 8601 ("2026-08-01") or relative ("7d", "12h", "2w").'),
      until: z
        .string()
        .optional()
        .describe('Only messages before this date. Same format as since. Use this to page backwards.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ chat, limit, since, until }) => {
    try {
      const resolved = await resolveChat(chat)
      if ('ambiguous' in resolved) {
        if (resolved.ambiguous.length === 0) {
          return fail(
            `Could not find any chat matching "${chat}". Try list_chats or search_chats to see what's available.`,
          )
        }
        return ok(
          `"${chat}" matches several chats. Call get_messages again with one's exact jid:\n\n` +
            renderChats(resolved.ambiguous),
        )
      }

      const target = resolved.chat
      const { messages } = await bridgeGet<{ messages: MessageView[] }>('/messages', {
        chat_jid: target.jid,
        limit,
        after: parseWhen(since),
        before: parseWhen(until),
      })

      if (messages.length === 0) {
        return ok(
          `${target.name} (${target.jid}): no messages stored in that range. ` +
            `The chat has ${target.message_count} messages in total. ` +
            `If that's 0, history sync may still be running — check whatsapp_status.`,
        )
      }

      const header =
        `${target.name} — ${target.is_group ? 'group' : 'one-on-one conversation'} (${target.jid})\n` +
        `${messages.length} messages, from ${fmtDate(messages[0].timestamp)} to ${fmtDate(messages[messages.length - 1].timestamp)}\n`

      const body = messages
        .map((m) => {
          const who = m.from_me ? 'me' : (m.sender_display ?? 'unknown')
          const media = m.media_type ? ` [${m.media_type}${m.filename ? `: ${m.filename}` : ''}]` : ''
          const reply = m.quoted_id ? ' (reply)' : ''
          return `[${fmtDate(m.timestamp)}] ${who}${reply} (id: ${m.msg_id}): ${m.text ?? ''}${media}`.trimEnd()
        })
        .join('\n')

      const footer =
        messages.length >= limit
          ? `\n\n(There are more messages. To keep going backwards: get_messages with until="${new Date(messages[0].timestamp).toISOString()}")`
          : ''

      return ok(`${header}\n${body}${footer}`)
    } catch (err) {
      return fail(errText(err))
    }
  },
)

// ---------------------------------------------------------------- write: messages

if (can('send')) {
  server.registerTool(
    'send_message',
    {
      title: 'Send a WhatsApp message',
      description:
        'Sends a text message to a chat. This reaches a real person immediately and cannot be unsent, ' +
        'so make sure the recipient and the wording are what the user intended. ' +
        'Set reply_to to a msg_id from get_messages to send it as a reply to that message.',
      inputSchema: {
        chat: chatParam,
        text: z.string().min(1).describe('The message body, exactly as it should appear.'),
        reply_to: z
          .string()
          .optional()
          .describe('msg_id of a message in this chat to quote (from get_messages). Omit for a plain message.'),
        mentions: z
          .array(z.string())
          .optional()
          .describe(
            'JIDs to @-mention. In groups, the text must also contain the matching "@<number>" for the mention to render.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ chat, text, reply_to, mentions }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(chat)
        const result = await bridgePost<WriteResult & { msg_id: string | null }>('/send', {
          chat_jid: target.jid,
          text,
          reply_to,
          mentions,
        })
        return renderWrite(
          result,
          `Sent to ${target.name} (${target.jid}).\nmsg_id: ${result.msg_id}\nText: ${truncate(text, 200)}`,
        )
      }),
  )

  server.registerTool(
    'react_to_message',
    {
      title: 'React to a WhatsApp message',
      description:
        'Adds an emoji reaction to a message. Pass an empty emoji string to remove a reaction you added earlier. ' +
        'Get the msg_id from get_messages.',
      inputSchema: {
        chat: chatParam,
        msg_id: z.string().min(1).describe('msg_id of the message to react to, from get_messages.'),
        emoji: z.string().describe('A single emoji, e.g. "👍". Empty string removes your reaction.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, msg_id, emoji }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(chat)
        const result = await bridgePost<WriteResult & { removed: boolean }>('/react', {
          chat_jid: target.jid,
          msg_id,
          emoji,
        })
        return renderWrite(
          result,
          result.removed
            ? `Removed your reaction from ${msg_id} in ${target.name}.`
            : `Reacted ${emoji} to ${msg_id} in ${target.name}.`,
        )
      }),
  )

  server.registerTool(
    'edit_message',
    {
      title: 'Edit a sent WhatsApp message',
      description:
        'Replaces the text of a message you sent. Only your own messages can be edited, and WhatsApp only ' +
        'allows it for a limited time after sending. Recipients see that the message was edited.',
      inputSchema: {
        chat: chatParam,
        msg_id: z.string().min(1).describe('msg_id of your own message to edit, from get_messages.'),
        text: z.string().min(1).describe('The new full text of the message.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ chat, msg_id, text }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(chat)
        const result = await bridgePost<WriteResult>('/edit', { chat_jid: target.jid, msg_id, text })
        return renderWrite(result, `Edited ${msg_id} in ${target.name}.\nNew text: ${truncate(text, 200)}`)
      }),
  )

  server.registerTool(
    'delete_message',
    {
      title: 'Delete a WhatsApp message',
      description:
        'Deletes a message. With for_everyone true (the default) it is retracted for all participants and they ' +
        'see "This message was deleted" — that is irreversible. With for_everyone false it only disappears from ' +
        'your own devices. Retracting for everyone requires the message to be yours, or you to be a group admin.',
      inputSchema: {
        chat: chatParam,
        msg_id: z.string().min(1).describe('msg_id of the message to delete, from get_messages.'),
        for_everyone: z
          .boolean()
          .default(true)
          .describe('true retracts it for all participants; false only removes it from your own devices.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, msg_id, for_everyone }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(chat)
        const result = await bridgePost<WriteResult>('/delete', { chat_jid: target.jid, msg_id, for_everyone })
        return renderWrite(
          result,
          `Deleted ${msg_id} in ${target.name} (${for_everyone ? 'for everyone' : 'only for you'}).`,
        )
      }),
  )
}

// ---------------------------------------------------------------- write: media

if (can('media')) {
  server.registerTool(
    'send_media',
    {
      title: 'Send a file over WhatsApp',
      description:
        'Sends an image, video, audio clip, document or sticker, read either from a local file path or ' +
        'downloaded from an http(s) URL. Exactly one of path or url must be given. ' +
        'Anything you send leaves the machine and reaches a real person — never send a file the user has ' +
        'not explicitly asked to send, and confirm the path is the one they meant.',
      inputSchema: {
        chat: chatParam,
        kind: z
          .enum(['image', 'video', 'audio', 'document', 'sticker'])
          .describe('What kind of media this is. Determines how WhatsApp renders it.'),
        path: z.string().optional().describe('Absolute path to a local file. Mutually exclusive with url.'),
        url: z.string().optional().describe('http(s) URL to fetch the file from. Mutually exclusive with path.'),
        caption: z.string().optional().describe('Caption shown with the file (image, video and document only).'),
        filename: z.string().optional().describe('Filename recipients see. Documents only.'),
        mimetype: z.string().optional().describe('MIME type. Recommended for documents and audio.'),
        voice_note: z.boolean().optional().describe('Audio only: send as a push-to-talk voice note.'),
        reply_to: z.string().optional().describe('msg_id in this chat to send this as a reply to.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ chat, kind, path, url, caption, filename, mimetype, voice_note, reply_to }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(chat)
        const result = await bridgePost<WriteResult & { msg_id: string | null }>('/send/media', {
          chat_jid: target.jid,
          kind,
          path,
          url,
          caption,
          filename,
          mimetype,
          voice_note,
          reply_to,
        })
        return renderWrite(
          result,
          `Sent ${kind} to ${target.name} (${target.jid}).\nSource: ${path ?? url}\nmsg_id: ${result.msg_id}`,
        )
      }),
  )
}

// ---------------------------------------------------------------- write: chats

if (can('chats')) {
  server.registerTool(
    'mark_chat_read',
    {
      title: 'Mark a chat as read',
      description:
        'Clears the unread badge for a chat and sends a read receipt, so the other side sees their messages ' +
        'as read (blue ticks). Cannot be undone from here.',
      inputSchema: { chat: chatParam },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(chat)
        const result = await bridgePost<WriteResult>('/chat/read', { chat_jid: target.jid })
        return renderWrite(result, `Marked ${target.name} (${target.jid}) as read.`)
      }),
  )

  server.registerTool(
    'update_chat',
    {
      title: 'Archive, pin or mute a chat',
      description:
        "Changes a chat's own settings on the user's account: archived, pinned, and muted. Pass only the " +
        'fields you want to change. Nothing is sent to the other participants.',
      inputSchema: {
        chat: chatParam,
        archived: z.boolean().optional().describe('true archives the chat, false unarchives it.'),
        pinned: z.boolean().optional().describe('true pins the chat to the top, false unpins it.'),
        mute_hours: z
          .number()
          .positive()
          .optional()
          .describe('Mute notifications for this many hours (e.g. 8, 168). Use unmute to clear a mute.'),
        unmute: z.boolean().optional().describe('true clears an existing mute.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, archived, pinned, mute_hours, unmute }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(chat)
        const result = await bridgePost<WriteResult & { applied: string[] }>('/chat/update', {
          chat_jid: target.jid,
          archived,
          pinned,
          muted_for_ms: mute_hours === undefined ? undefined : Math.round(mute_hours * 3.6e6),
          unmute,
        })
        return renderWrite(result, `Updated ${target.name}: ${result.applied.join(', ')}.`)
      }),
  )

  server.registerTool(
    'send_typing',
    {
      title: 'Send a typing indicator',
      description:
        'Shows "typing…" (or "recording…") to the other side of a chat, or clears it. Purely cosmetic — ' +
        'useful before a send so the conversation feels natural. The indicator expires on its own.',
      inputSchema: {
        chat: chatParam,
        state: z
          .enum(['composing', 'recording', 'paused', 'available', 'unavailable'])
          .default('composing')
          .describe('composing = typing…, recording = recording audio…, paused clears the indicator.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, state }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(chat)
        const result = await bridgePost<WriteResult>('/chat/typing', { chat_jid: target.jid, state })
        return renderWrite(result, `Sent "${state}" to ${target.name}.`)
      }),
  )
}

// ---------------------------------------------------------------- write: groups

if (can('groups')) {
  server.registerTool(
    'create_group',
    {
      title: 'Create a WhatsApp group',
      description:
        'Creates a new group and adds the given participants, who are notified immediately. ' +
        'Confirm the exact participant list with the user first — adding the wrong person to a group is ' +
        'visible to everyone in it.',
      inputSchema: {
        subject: z.string().min(1).describe('The group name.'),
        participants: z
          .array(z.string().min(1))
          .min(1)
          .describe('JIDs or phone numbers to add, besides yourself. Resolve names with search_chats first.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ subject, participants }) =>
      guarded(async () => {
        const result = await bridgePost<WriteResult & { group_jid: string }>('/group/create', {
          subject,
          participants,
        })
        return renderWrite(
          result,
          `Created group "${subject}" (${result.group_jid}) with ${participants.length} participant(s).`,
        )
      }),
  )

  server.registerTool(
    'manage_group_participants',
    {
      title: 'Add, remove or promote group participants',
      description:
        'Adds or removes participants, or promotes/demotes them as admins. Requires you to be an admin of ' +
        'the group. Removing someone is visible to the whole group and cannot be undone.',
      inputSchema: {
        group: groupParam,
        action: z
          .enum(['add', 'remove', 'promote', 'demote'])
          .describe('add/remove membership, or promote/demote admin rights.'),
        participants: z.array(z.string().min(1)).min(1).describe('JIDs or phone numbers to act on.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ group, action, participants }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(group)
        const result = await bridgePost<WriteResult>('/group/participants', {
          group_jid: target.jid,
          action,
          participants,
        })
        return renderWrite(result, `${action}: ${participants.join(', ')} in ${target.name} (${target.jid}).`)
      }),
  )

  server.registerTool(
    'update_group',
    {
      title: 'Rename a group, or leave it',
      description:
        "Changes a group's name or description, fetches or revokes its invite link, or leaves the group. " +
        'Leaving is irreversible without a new invite — confirm with the user before doing it.',
      inputSchema: {
        group: groupParam,
        subject: z.string().optional().describe('New group name.'),
        description: z.string().optional().describe('New group description. Pass an empty string to clear it.'),
        action: z
          .enum(['leave', 'invite_link', 'revoke_invite'])
          .optional()
          .describe('leave the group, get its invite link, or revoke the current link and get a fresh one.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ group, subject, description, action }) =>
      guarded(async () => {
        const target = await resolveWriteTarget(group)
        const result = await bridgePost<WriteResult & { applied: string[]; invite_link: string | null }>(
          '/group/update',
          { group_jid: target.jid, subject, description, action },
        )
        return renderWrite(
          result,
          `Updated ${target.name} (${target.jid}): ${result.applied.join(', ')}.` +
            (result.invite_link ? `\nInvite link: ${result.invite_link}` : ''),
        )
      }),
  )
}

export async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const mode = isReadOnly(perms) ? 'read-only' : `read + ${scopeList(perms).join(', ')}`
  process.stderr.write(`whatsapp-agent mcp ready (bridge: ${BRIDGE_URL}, permissions: ${mode})\n`)
}

// Still runnable directly (`bun run src/mcp/index.ts`) for local dev and as
// the e2e suite's fallback when WA_TEST_BIN isn't set. When imported by the
// CLI router (src/cli/index.ts) this is false and the router calls main().
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`whatsapp-agent mcp failed: ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exit(1)
  })
}
