#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { BRIDGE_URL } from '../shared/config.js'
import { bridgeGet } from './client.js'

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

// ---------------------------------------------------------------- helpers

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

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

// ---------------------------------------------------------------- server

const server = new McpServer(
  { name: 'whatsapp', version: '0.1.0' },
  {
    instructions:
      'READ-ONLY access to the user\'s WhatsApp account through a local bridge (Baileys). ' +
      'Use list_chats to see recent conversations, search_chats to find one by name or number, ' +
      'and get_messages to read a conversation\'s history. ' +
      'get_messages accepts a name or number directly, no need to look up the JID first. ' +
      'This server cannot send messages or modify anything.'
  }
)

server.registerTool(
  'whatsapp_status',
  {
    title: 'WhatsApp connection status',
    description:
      'Shows whether the WhatsApp bridge is connected, with which account, and how many chats and messages ' +
      'are stored locally. Use this first if any other tool returns empty results or a connection error.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    try {
      const s = await bridgeGet<any>('/status')
      const lines = [
        `Connection: ${s.connection}${s.registered ? '' : ' (not linked yet)'}`,
        s.me ? `Account: ${s.me.name ?? '(no name)'} — ${s.me.id}` : 'Account: not linked',
        `Stored locally: ${s.stored.chats} chats, ${s.stored.messages} messages, ${s.stored.contacts} contacts`,
        `History sync: ${s.history_sync.complete ? 'complete' : 'in progress'} (${s.history_sync.received} messages received)`,
        s.connected_at ? `Connected since: ${fmtDate(s.connected_at)}` : null,
        s.awaiting_qr ? 'Waiting for you to scan the QR in the terminal running the bridge.' : null,
        s.pairing_code ? `Pending pairing code: ${s.pairing_code}` : null,
        s.last_error ? `Last error: ${s.last_error}` : null
      ].filter(Boolean)
      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
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
      include_archived: z.boolean().default(false).describe('Include archived chats.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ limit, offset, type, unread_only, include_archived }) => {
    try {
      const { chats } = await bridgeGet<{ chats: ChatView[] }>('/chats', {
        limit,
        offset,
        type,
        unread_only,
        include_archived
      })
      return ok(`${chats.length} chats:\n\n${renderChats(chats)}`)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
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
      limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of results.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ query, limit }) => {
    try {
      const { chats } = await bridgeGet<{ chats: ChatView[] }>('/chats/search', { q: query, limit })
      return ok(`${chats.length} matches for "${query}":\n\n${renderChats(chats)}`)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
)

server.registerTool(
  'get_messages',
  {
    title: 'Read messages from a chat',
    description:
      'Returns a conversation\'s message history in chronological order. ' +
      'The chat parameter accepts an exact JID, a contact/group name, or a phone number. ' +
      'Use since/until to narrow by date and limit + before to page backwards.',
    inputSchema: {
      chat: z.string().min(1).describe('JID (e.g. 15551234567@s.whatsapp.net), contact/group name, or number.'),
      limit: z.number().int().min(1).max(500).default(50).describe('How many messages to return (the most recent in range).'),
      since: z
        .string()
        .optional()
        .describe('Only messages after this date. Accepts ISO 8601 ("2026-08-01") or relative ("7d", "12h", "2w").'),
      until: z
        .string()
        .optional()
        .describe('Only messages before this date. Same format as since. Use this to page backwards.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ chat, limit, since, until }) => {
    try {
      const resolved = await resolveChat(chat)
      if ('ambiguous' in resolved) {
        if (resolved.ambiguous.length === 0) {
          return fail(
            `Could not find any chat matching "${chat}". Try list_chats or search_chats to see what's available.`
          )
        }
        return ok(
          `"${chat}" matches several chats. Call get_messages again with one's exact jid:\n\n` +
            renderChats(resolved.ambiguous)
        )
      }

      const target = resolved.chat
      const { messages } = await bridgeGet<{ messages: MessageView[] }>('/messages', {
        chat_jid: target.jid,
        limit,
        after: parseWhen(since),
        before: parseWhen(until)
      })

      if (messages.length === 0) {
        return ok(
          `${target.name} (${target.jid}): no messages stored in that range. ` +
            `The chat has ${target.message_count} messages in total. ` +
            `If that's 0, history sync may still be running — check whatsapp_status.`
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
          return `[${fmtDate(m.timestamp)}] ${who}${reply}: ${m.text ?? ''}${media}`.trimEnd()
        })
        .join('\n')

      const footer =
        messages.length >= limit
          ? `\n\n(There are more messages. To keep going backwards: get_messages with until="${new Date(messages[0].timestamp).toISOString()}")`
          : ''

      return ok(`${header}\n${body}${footer}`)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`whatsapp-agent mcp ready (bridge: ${BRIDGE_URL})\n`)
}

main().catch((err) => {
  process.stderr.write(`whatsapp-agent mcp failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
